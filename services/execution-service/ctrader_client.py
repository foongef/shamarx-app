"""cTrader Open API broker client. Implements the Broker ABC over Spotware
WebSocket API. Authenticates with app-level + account-level OAuth tokens,
maintains a persistent connection with heartbeat + reconnect, and translates
between our domain types and Spotware ProtoOA messages."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, TypeVar

import httpx

from broker_base import Broker
from ctrader_protocol import CTraderTransport, CTraderApiError, PAYLOAD

_logger = logging.getLogger(__name__)
T = TypeVar('T')

SYMBOL_ALIASES = {
    'XAUUSD': ['GOLD', 'XAU/USD'],
    'EURUSD': ['EUR/USD'],
    'GBPUSD': ['GBP/USD'],
    'USDJPY': ['USD/JPY'],
}

# ProtoOAExecutionType values (verified against the live demo API).
EXEC_ACCEPTED = 2
EXEC_FILLED = 3
EXEC_REPLACED = 4
EXEC_CANCELLED = 5
EXEC_EXPIRED = 6
EXEC_REJECTED = 7
EXEC_PARTIAL_FILL = 11
_ORDER_TERMINAL = {EXEC_FILLED, EXEC_CANCELLED, EXEC_EXPIRED, EXEC_REJECTED}

# ProtoOATradeSide: requests accept enum names; responses return ints.
TRADE_SIDE_BY_INT = {1: 'BUY', 2: 'SELL'}

# All spot/trendbar prices and relative SL/TP distances are in 1/100_000 of
# the quote price — a FIXED scale, independent of symbol digits (verified:
# EURUSD trendbar low=114417 → 1.14417; relativeStopLoss=1000 → 100 pips).
PRICE_SCALE = 100_000

TIMEFRAME_MS = {
    'M1': 60_000, 'M5': 5 * 60_000, 'M15': 15 * 60_000, 'M30': 30 * 60_000,
    'H1': 3_600_000, 'H4': 4 * 3_600_000, 'D1': 24 * 3_600_000,
}

# Fallback lotSize (cents of units): 1 FX lot = 100_000 units = 10_000_000.
# Real values come from SYMBOL_BY_ID details fetched at initialize.
DEFAULT_LOT_SIZE_CENTS = 10_000_000


async def _async_token_request(url: str, params: Dict[str, str]) -> httpx.Response:
    # cTrader's token endpoint is a GET with query-string params (non-standard
    # OAuth2) — a POST form body yields HTTP 400.
    async with httpx.AsyncClient(timeout=10.0) as client:
        return await client.get(url, params=params)


def make_token_refresh_callback(account_id: str) -> Callable[[Dict[str, Any]], Awaitable[None]]:
    """Returns an async callback the CTraderClient calls after a successful token
    refresh. It PATCHes the refreshed tokens back to NestJS so they get re-encrypted
    into the BrokerAccount row.

    The internal NestJS endpoint is IP-restricted to docker subnets, so this only
    works when both services are on the docker network."""
    backend_url = os.getenv('BACKEND_INTERNAL_URL', 'http://backend:3001')

    async def callback(tokens: Dict[str, Any]) -> None:
        async with httpx.AsyncClient(timeout=10.0) as http:
            try:
                res = await http.patch(
                    f'{backend_url}/api/accounts/{account_id}/oauth-tokens',
                    json={
                        'accessToken': tokens['accessToken'],
                        'refreshToken': tokens['refreshToken'],
                        'expiresAt': int(tokens['expiresAt']),
                    },
                )
                if res.status_code >= 400:
                    _logger.warning(
                        f'Token persistence failed for account={account_id}: '
                        f'{res.status_code} {res.text[:200]}'
                    )
            except Exception as e:
                _logger.warning(f'Token persistence error for account={account_id}: {e}')

    return callback


class CTraderClient(Broker):
    def __init__(
        self,
        access_token: str,
        refresh_token: str,
        ctid_trader_account_id: int,
        expires_at: int,
        account_kind: str,
        account_id: str = '',
        on_token_refresh: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
    ):
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.ctid_trader_account_id = ctid_trader_account_id
        self.expires_at = expires_at
        self.account_kind = account_kind  # 'DEMO' | 'LIVE'
        self.account_id = account_id
        self._on_token_refresh = on_token_refresh

        self._transport: Optional[CTraderTransport] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._closed = False
        # Trendbar throttle: Spotware rate-limits historical-data requests
        # (BLOCKED_PAYLOAD_TYPE observed live when the candle cron bursts
        # 8 pair×timeframe fetches at once). Space them out client-side.
        self._trendbar_lock = asyncio.Lock()
        self._last_trendbar_at = 0.0

        self._symbol_id_by_name: Dict[str, int] = {}
        self._symbol_name_by_id: Dict[int, str] = {}
        self._symbol_details: Dict[int, Dict[str, Any]] = {}  # symbolId → full ProtoOASymbol
        self._position_symbol_cache: Dict[int, str] = {}
        self._position_volume_cache: Dict[int, int] = {}  # positionId → volume (cents of units)

    @classmethod
    def from_creds(cls, creds: Dict[str, Any]) -> 'CTraderClient':
        return cls(
            access_token=creds['accessToken'],
            refresh_token=creds['refreshToken'],
            ctid_trader_account_id=int(creds['ctidTraderAccountId']),
            expires_at=int(creds.get('expiresAt', 0)),
            account_kind=creds.get('accountKind', 'DEMO'),
            account_id=creds.get('brokerAccountId', ''),
        )

    # ----- Symbol + price helpers -----
    def _to_ctrader_symbol(self, symbol: str) -> int:
        if symbol in self._symbol_id_by_name:
            return self._symbol_id_by_name[symbol]
        for alias in SYMBOL_ALIASES.get(symbol, []):
            if alias in self._symbol_id_by_name:
                return self._symbol_id_by_name[alias]
        raise ValueError(f'Symbol {symbol} not available on this cTrader account')

    def _our_symbol_from_id(self, symbol_id: int) -> str:
        return self._symbol_name_by_id.get(symbol_id, str(symbol_id))

    def _lot_size_cents(self, symbol_id: int) -> int:
        details = self._symbol_details.get(symbol_id) or {}
        return int(details.get('lotSize') or DEFAULT_LOT_SIZE_CENTS)

    def _lots_to_volume(self, symbol_id: int, lots: float) -> int:
        """Lots → ProtoOA volume (cents of units): 0.01 lot EURUSD = 100_000.
        Clamped to minVolume and snapped to stepVolume when known."""
        details = self._symbol_details.get(symbol_id) or {}
        volume = int(round(lots * self._lot_size_cents(symbol_id)))
        step = int(details.get('stepVolume') or 0)
        if step > 0:
            volume = max(step, int(round(volume / step)) * step)
        min_vol = int(details.get('minVolume') or 0)
        if min_vol > 0:
            volume = max(volume, min_vol)
        return volume

    def _volume_to_lots(self, symbol_id: int, volume: int) -> float:
        return volume / self._lot_size_cents(symbol_id)

    # ----- Stubs (filled in subsequent tasks) -----
    async def initialize(self) -> None:
        client_id = os.getenv('CTRADER_CLIENT_ID')
        client_secret = os.getenv('CTRADER_CLIENT_SECRET')
        if not client_id or not client_secret:
            raise RuntimeError('CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET must be set')

        host = 'live.ctraderapi.com' if self.account_kind == 'LIVE' else 'demo.ctraderapi.com'
        self._transport = CTraderTransport(host)
        await self._transport.connect()

        try:
            # App-level auth
            await self._transport.request(
                PAYLOAD['APP_AUTH_REQ'],
                {'clientId': client_id, 'clientSecret': client_secret},
                PAYLOAD['APP_AUTH_RES'],
            )

            # Account-level auth
            await self._transport.request(
                PAYLOAD['ACCOUNT_AUTH_REQ'],
                {'ctidTraderAccountId': self.ctid_trader_account_id, 'accessToken': self.access_token},
                PAYLOAD['ACCOUNT_AUTH_RES'],
            )

            # Symbol catalog
            symbols_res = await self._transport.request(
                PAYLOAD['SYMBOLS_LIST_REQ'],
                {'ctidTraderAccountId': self.ctid_trader_account_id, 'includeArchivedSymbols': False},
                PAYLOAD['SYMBOLS_LIST_RES'],
            )
            for s in symbols_res.get('symbol', []):
                name = s['symbolName']
                sid = int(s['symbolId'])
                self._symbol_id_by_name[name] = sid
                self._symbol_name_by_id[sid] = name

            # The light symbols list carries NO digits/lotSize/minVolume —
            # fetch full details for the symbols we trade (needed for correct
            # lots→volume conversion; XAUUSD lot ≠ FX lot).
            wanted_ids = []
            for our_name in SYMBOL_ALIASES:
                try:
                    wanted_ids.append(self._to_ctrader_symbol(our_name))
                except ValueError:
                    continue
            if wanted_ids:
                details_res = await self._transport.request(
                    PAYLOAD['SYMBOL_BY_ID_REQ'],
                    {'ctidTraderAccountId': self.ctid_trader_account_id, 'symbolId': wanted_ids},
                    PAYLOAD['SYMBOL_BY_ID_RES'],
                )
                for s in details_res.get('symbol', []):
                    self._symbol_details[int(s['symbolId'])] = s
        except Exception:
            # Clean up the transport so we don't leak a connected socket
            try:
                await self._transport.close()
            finally:
                self._transport = None
            raise

        # Start heartbeat AFTER all fallible work succeeds
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        _logger.info(f'CTraderClient: initialized account={self.ctid_trader_account_id} '
                     f'kind={self.account_kind} symbols={len(self._symbol_id_by_name)}')

    async def _heartbeat_loop(self) -> None:
        assert self._transport is not None
        while not self._closed:
            await asyncio.sleep(10)
            try:
                await self._transport.send_oneway(PAYLOAD['HEARTBEAT_EVENT'], {})
            except Exception as e:
                _logger.warning(f'CTrader heartbeat failed: {e}')

    async def _place_order_impl(self, request) -> object:
        from models import OrderResponse
        assert self._transport is not None
        symbol_id = self._to_ctrader_symbol(request.symbol)
        volume = self._lots_to_volume(symbol_id, request.lot_size)
        side = request.side.value if hasattr(request.side, 'value') else str(request.side)

        # MARKET orders reject absolute SL/TP ("allowed only for LIMIT, STOP,
        # STOP_LIMIT" — verified live). Send RELATIVE distances (1/100_000 of
        # price, anchored to the fill price), then amend the open position to
        # the strategy's exact absolute levels once filled.
        entry_ref = float(request.entry_price or 0)
        payload = {
            'ctidTraderAccountId': self.ctid_trader_account_id,
            'symbolId': symbol_id,
            'orderType': 'MARKET',
            'tradeSide': side,
            'volume': volume,
        }
        if request.comment:
            payload['comment'] = request.comment
        if entry_ref > 0 and request.sl_price:
            payload['relativeStopLoss'] = max(1, int(round(abs(entry_ref - request.sl_price) * PRICE_SCALE)))
        if entry_ref > 0 and request.tp_price:
            payload['relativeTakeProfit'] = max(1, int(round(abs(request.tp_price - entry_ref) * PRICE_SCALE)))

        try:
            envs = await self._transport.request_until(
                PAYLOAD['NEW_ORDER_REQ'], payload,
                done=lambda env: (env.get('payload') or {}).get('executionType') in _ORDER_TERMINAL,
            )
        except CTraderApiError as e:
            _logger.error(f'CTrader place_order rejected: {e}')
            return OrderResponse(orderId='', mt5Ticket=None, status='REJECTED', message=str(e))

        final = envs[-1].get('payload') or {}
        exec_type = final.get('executionType')
        deal = final.get('deal') or {}
        position = final.get('position') or {}
        position_id = position.get('positionId') or deal.get('positionId')
        if exec_type != EXEC_FILLED or not position_id:
            return OrderResponse(
                orderId=str((final.get('order') or {}).get('orderId', '')),
                mt5Ticket=None,
                status='REJECTED',
                message=f'executionType={exec_type}',
            )

        position_id = int(position_id)
        self._position_symbol_cache[position_id] = request.symbol
        self._position_volume_cache[position_id] = int(
            (position.get('tradeData') or {}).get('volume') or volume,
        )

        # Pin SL/TP to the exact strategy levels. If the amend fails we keep
        # the relative protection already attached at fill — never naked.
        if request.sl_price or request.tp_price:
            try:
                await self._amend_sltp(position_id, request.sl_price, request.tp_price)
            except Exception as e:
                _logger.warning(
                    f'CTrader post-fill SL/TP amend failed for position={position_id} '
                    f'(relative protection stays active): {e}'
                )

        fill_price = deal.get('executionPrice') or position.get('price')
        status = 'FILLED'
        exec_type = 'ORDER_FILLED'
        return OrderResponse(
            orderId=str((final.get('order') or {}).get('orderId', '')),
            mt5Ticket=position_id,
            status=status,
            message=f'{exec_type} @ {fill_price}',
        )

    async def _latest_stored_close(self, symbol: str) -> Optional[float]:
        """Newest M15 close from the shared Candle table — cheap local query,
        used to estimate current price / unrealized P&L for display (cTrader's
        reconcile carries no live prices, and per-poll trendbar fetches would
        hit Spotware's rate limit). Returns None outside the API service
        context (e.g. unit tests without DATABASE_URL)."""
        try:
            from db import get_pool
            pool = await get_pool()
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    'SELECT close FROM "Candle" WHERE symbol=$1 AND timeframe=$2 '
                    'ORDER BY "openTime" DESC LIMIT 1',
                    symbol, 'M15',
                )
                return float(row['close']) if row else None
        except Exception:
            return None

    async def _get_positions_impl(self, symbol: Optional[str] = None) -> list:
        assert self._transport is not None
        res = await self._transport.request(
            PAYLOAD['RECONCILE_REQ'],
            {'ctidTraderAccountId': self.ctid_trader_account_id},
            PAYLOAD['RECONCILE_RES'],
        )
        positions = []
        close_cache: Dict[str, Optional[float]] = {}
        for p in res.get('position', []):
            td = p.get('tradeData', {})
            sym_id = int(td.get('symbolId', 0))
            sym = self._our_symbol_from_id(sym_id)
            if symbol and sym != symbol:
                continue
            # Position/order/deal prices are absolute doubles (verified live);
            # only trendbars and relative SL/TP use the 1e5 integer scale.
            entry_price = float(p.get('price', 0) or 0)
            volume = int(td.get('volume', 0) or 0)
            open_ts = int(td.get('openTimestamp', 0) or 0)
            # openTimestamp is epoch-ms — the UI does new Date(openTime), so a
            # raw digit-string renders as "Invalid Date". Emit ISO like MetaApi.
            open_iso = (
                datetime.fromtimestamp(open_ts / 1000, tz=timezone.utc)
                .strftime('%Y-%m-%dT%H:%M:%S.000Z') if open_ts else ''
            )
            # Estimate current price / unrealized P&L from the latest stored
            # M15 close (<=15min stale; honest-ish, unlike a hardcoded $0.00).
            if sym not in close_cache:
                close_cache[sym] = await self._latest_stored_close(sym)
            current = close_cache[sym] or entry_price
            lots = self._volume_to_lots(sym_id, volume)
            side = TRADE_SIDE_BY_INT.get(td.get('tradeSide'), str(td.get('tradeSide', '')))
            diff = (current - entry_price) if side == 'BUY' else (entry_price - current)
            lot_units = 100 if sym == 'XAUUSD' else 100_000
            raw_pnl = diff * lots * lot_units
            if sym.endswith('JPY') and current:
                raw_pnl /= current
            positions.append({
                'ticket': int(p['positionId']),
                'symbol': sym,
                'side': side,
                'lotSize': lots,
                'entryPrice': entry_price,
                'currentPrice': current,
                'sl': float(p.get('stopLoss', 0) or 0),
                'tp': float(p.get('takeProfit', 0) or 0),
                'pnl': round(raw_pnl, 2),
                'openTime': open_iso,
            })
            self._position_symbol_cache[int(p['positionId'])] = sym
            self._position_volume_cache[int(p['positionId'])] = volume
        return positions

    async def _close_position_impl(self, ticket: int) -> dict:
        assert self._transport is not None
        ticket = int(ticket)
        # ProtoOAClosePositionReq requires the ACTUAL volume to close — 0 is
        # rejected. Use the cached volume; reconcile if we don't have it.
        volume = self._position_volume_cache.get(ticket)
        if not volume:
            await self._get_positions_impl()
            volume = self._position_volume_cache.get(ticket)
        if not volume:
            raise CTraderApiError('POSITION_NOT_FOUND', f'ticket={ticket}')
        envs = await self._transport.request_until(
            PAYLOAD['CLOSE_POSITION_REQ'],
            {'ctidTraderAccountId': self.ctid_trader_account_id, 'positionId': ticket, 'volume': volume},
            done=lambda env: (env.get('payload') or {}).get('executionType') in _ORDER_TERMINAL,
        )
        final = envs[-1].get('payload') or {}
        exec_type = final.get('executionType')
        if exec_type == EXEC_FILLED:
            self._position_symbol_cache.pop(ticket, None)
            self._position_volume_cache.pop(ticket, None)
            deal = final.get('deal') or {}
            cpd = deal.get('closePositionDetail') or {}
            money_digits = int(deal.get('moneyDigits', 2))
            return {
                'status': 'CLOSED',
                'closePrice': float(deal.get('executionPrice', 0) or 0),
                'pnl': int(cpd.get('grossProfit', 0) or 0) / (10 ** money_digits),
            }
        return {'status': f'executionType={exec_type}'}

    async def _amend_sltp(self, position_id: int, sl_price: float, tp_price: float) -> None:
        """AMEND_POSITION_SLTP takes ABSOLUTE double prices (verified live);
        the response is an EXECUTION_EVENT with executionType ORDER_REPLACED."""
        assert self._transport is not None
        payload = {
            'ctidTraderAccountId': self.ctid_trader_account_id,
            'positionId': int(position_id),
        }
        if sl_price:
            payload['stopLoss'] = float(sl_price)
        if tp_price:
            payload['takeProfit'] = float(tp_price)
        await self._transport.request_until(
            PAYLOAD['AMEND_POSITION_SLTP_REQ'], payload,
            done=lambda env: (env.get('payload') or {}).get('executionType') in (
                EXEC_REPLACED, EXEC_CANCELLED, EXEC_REJECTED,
            ),
        )

    async def _modify_position_impl(self, ticket: int, sl_price: float, tp_price: float) -> dict:
        await self._amend_sltp(int(ticket), sl_price, tp_price)
        return {'status': 'OK'}

    # ----- Public API — reconnect-aware wrappers -----
    # The cTrader server closes the WebSocket on weekends / idle (1000 "Bye");
    # the registry caches this client, so without these wrappers every call
    # after a disconnect would 500 forever off a dead transport.
    #
    # Read-only ops retry through _with_reconnect (safe to repeat). Mutating
    # ops only reconnect BEFORE sending — a retry after an ambiguous mid-
    # flight failure could double-execute (e.g. two market orders).

    async def _ensure_connected(self) -> None:
        if self._transport is None or not self._transport.is_alive:
            _logger.warning(
                f'CTraderClient: transport dead for account={self.ctid_trader_account_id} — reconnecting',
            )
            await self._ensure_fresh_token()
            await self._reconnect()

    async def get_positions(self, symbol: Optional[str] = None) -> list:
        return await self._with_reconnect(
            'get_positions', lambda: self._get_positions_impl(symbol), max_attempts=3)

    async def get_account_info(self) -> object:
        return await self._with_reconnect(
            'get_account_info', self._get_account_info_impl, max_attempts=3)

    async def get_position_close_info(self, ticket: int) -> Optional[dict]:
        return await self._with_reconnect(
            'get_position_close_info', lambda: self._get_position_close_info_impl(ticket), max_attempts=3)

    async def get_candles(self, symbol: str, timeframe: str, count: int) -> list:
        return await self._with_reconnect(
            'get_candles', lambda: self._get_candles_impl(symbol, timeframe, count), max_attempts=3)

    async def place_order(self, request) -> object:
        await self._ensure_connected()
        return await self._place_order_impl(request)

    async def close_position(self, ticket: int) -> dict:
        await self._ensure_connected()
        return await self._close_position_impl(ticket)

    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict:
        await self._ensure_connected()
        return await self._modify_position_impl(ticket, sl_price, tp_price)

    async def _get_account_info_impl(self) -> object:
        from models import AccountInfo
        assert self._transport is not None
        trader_res = await self._transport.request(
            PAYLOAD['TRADER_REQ'],
            {'ctidTraderAccountId': self.ctid_trader_account_id},
            PAYLOAD['TRADER_RES'],
        )
        trader = trader_res.get('trader', {})
        money_digits = int(trader.get('moneyDigits', 2))
        divisor = 10 ** money_digits
        balance = int(trader.get('balance', 0)) / divisor
        positions_res = await self._transport.request(
            PAYLOAD['RECONCILE_REQ'],
            {'ctidTraderAccountId': self.ctid_trader_account_id},
            PAYLOAD['RECONCILE_RES'],
        )
        open_positions = len(positions_res.get('position', []))
        used_margin = sum(int(p.get('usedMargin', 0)) for p in positions_res.get('position', [])) / divisor
        equity = balance  # cTrader does not surface live equity on TRADER_RES; close enough for risk gates
        return AccountInfo(
            balance=balance,
            equity=equity,
            margin=used_margin,
            freeMargin=max(0.0, equity - used_margin),
            openPositions=open_positions,
        )

    async def _get_position_close_info_impl(self, ticket: int) -> Optional[dict]:
        assert self._transport is not None
        now_ms = int(time.time() * 1000)
        seven_days_ms = 7 * 24 * 3600 * 1000
        res = await self._transport.request(
            PAYLOAD['DEAL_LIST_REQ'],
            {
                'ctidTraderAccountId': self.ctid_trader_account_id,
                'fromTimestamp': now_ms - seven_days_ms,
                'toTimestamp': now_ms,
            },
            PAYLOAD['DEAL_LIST_RES'],
        )
        for deal in res.get('deal', []):
            if int(deal.get('positionId', 0)) != int(ticket):
                continue
            if deal.get('closePositionDetail') is None:
                continue
            cpd = deal['closePositionDetail']
            # Monetary fields are ints scaled by moneyDigits (verified live:
            # grossProfit=1, moneyDigits=2 → $0.01). executionPrice is an
            # absolute double on the DEAL, not on closePositionDetail.
            money_digits = int(deal.get('moneyDigits', 2))
            divisor = 10 ** money_digits
            return {
                'ticket': int(ticket),
                'closePrice': float(deal.get('executionPrice', 0) or 0),
                'closeTime': str(deal.get('executionTimestamp', 0)),
                'pnl': int(cpd.get('grossProfit', 0) or 0) / divisor,
                'commission': int(cpd.get('commission', deal.get('commission', 0)) or 0) / divisor,
                'swap': int(cpd.get('swap', 0) or 0) / divisor,
                'reason': cpd.get('closeReason', 'UNKNOWN'),
            }
        return None

    async def _throttle_trendbars(self, min_interval: float = 0.3) -> None:
        async with self._trendbar_lock:
            now = asyncio.get_running_loop().time()
            wait = self._last_trendbar_at + min_interval - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_trendbar_at = asyncio.get_running_loop().time()

    async def _get_candles_impl(self, symbol: str, timeframe: str, count: int) -> list:
        """Recent OHLC bars via ProtoOAGetTrendbars (2137/2138). Used as the
        market-data failover when the primary MetaApi feed is down.

        Wire format (verified live): request accepts the period as an enum
        NAME string ('M15'); bars come compressed as {low, deltaOpen,
        deltaHigh, deltaClose, utcTimestampInMinutes, volume} with prices in
        1/100_000 units. The most recent bar may still be forming — callers
        (CandleService) already drop in-progress bars by openTime."""
        from models import CandleData
        assert self._transport is not None
        tf = timeframe.upper()
        tf_ms = TIMEFRAME_MS.get(tf)
        if not tf_ms:
            raise ValueError(f'Unsupported timeframe {timeframe}')
        symbol_id = self._to_ctrader_symbol(symbol)
        now_ms = int(time.time() * 1000)
        payload = {
            'ctidTraderAccountId': self.ctid_trader_account_id,
            'symbolId': symbol_id,
            'period': tf,
            'fromTimestamp': now_ms - tf_ms * (count + 3),
            'toTimestamp': now_ms,
        }
        res = None
        for attempt in range(2):
            await self._throttle_trendbars()
            try:
                res = await self._transport.request(
                    PAYLOAD['GET_TRENDBARS_REQ'], payload,
                    PAYLOAD['GET_TRENDBARS_RES'], timeout=20.0,
                )
                break
            except CTraderApiError as e:
                if e.code == 'BLOCKED_PAYLOAD_TYPE' and attempt == 0:
                    _logger.warning(f'trendbars rate-limited for {symbol} {tf} — backing off 2.5s')
                    await asyncio.sleep(2.5)
                    continue
                raise
        candles = []
        for b in res.get('trendbar', []):
            low = int(b.get('low', 0))
            open_ms = int(b.get('utcTimestampInMinutes', 0)) * 60_000
            candles.append(CandleData(
                symbol=symbol,
                timeframe=tf,
                openTime=datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc)
                    .strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                open=(low + int(b.get('deltaOpen', 0))) / PRICE_SCALE,
                high=(low + int(b.get('deltaHigh', 0))) / PRICE_SCALE,
                low=low / PRICE_SCALE,
                close=(low + int(b.get('deltaClose', 0))) / PRICE_SCALE,
                volume=float(b.get('volume', 0)),
            ))
        candles.sort(key=lambda c: c.open_time)
        return candles[-count:]

    async def _ensure_fresh_token(self) -> None:
        """Refresh proactively if the access token expires in <60s."""
        if self.expires_at > 0 and self.expires_at - int(time.time()) < 60:
            await self._refresh_token()

    async def _refresh_token(self) -> None:
        client_id = os.getenv('CTRADER_CLIENT_ID')
        client_secret = os.getenv('CTRADER_CLIENT_SECRET')
        token_url = os.getenv('CTRADER_TOKEN_URL', 'https://openapi.ctrader.com/apps/token')
        if not client_id or not client_secret:
            raise RuntimeError('CTRADER_CLIENT_ID/SECRET required for refresh')
        res = await _async_token_request(token_url, {
            'grant_type': 'refresh_token',
            'refresh_token': self.refresh_token,
            'client_id': client_id,
            'client_secret': client_secret,
        })
        res.raise_for_status()
        body = res.json()
        self.access_token = body['accessToken']
        self.refresh_token = body['refreshToken']
        self.expires_at = int(time.time()) + int(body.get('expiresIn', 0))
        _logger.info(f'CTraderClient: refreshed token for account={self.ctid_trader_account_id} '
                     f'(expires in {body.get("expiresIn", 0)}s)')
        if self._on_token_refresh:
            await self._on_token_refresh({
                'accessToken': self.access_token,
                'refreshToken': self.refresh_token,
                'expiresAt': self.expires_at,
            })

    async def _reconnect(self) -> None:
        """Close current transport + reinitialize. Used on auth/transport failure."""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        if self._transport:
            try:
                await self._transport.close()
            except Exception:
                pass
            self._transport = None
        await self.initialize()

    async def _with_reconnect(
        self,
        op_name: str,
        fn: Callable[[], Awaitable[T]],
        max_attempts: int = 5,
    ) -> T:
        """Run fn with exponential backoff retry on auth/transport failure.
        On CH_CLIENT_AUTH_FAILURE → refresh token + reconnect + retry once."""
        delay = 1.0
        last_exc: Optional[Exception] = None
        for attempt in range(max_attempts):
            try:
                await self._ensure_fresh_token()
                return await fn()
            except CTraderApiError as e:
                last_exc = e
                if e.code in ('CH_CLIENT_AUTH_FAILURE', 'CH_ACCESS_TOKEN_INVALID'):
                    _logger.warning(f'{op_name}: auth failure → refresh + reconnect')
                    await self._refresh_token()
                    await self._reconnect()
                    continue
                if e.code == 'DISCONNECTED':
                    # Server closed the socket (weekend "Bye" / idle timeout) —
                    # reconnect and retry; the cached client must self-heal.
                    _logger.warning(f'{op_name}: transport disconnected → reconnect')
                    await self._reconnect()
                    continue
                raise
            except Exception as e:
                last_exc = e
                _logger.warning(f'{op_name} attempt {attempt + 1}/{max_attempts} failed: {e}')
                if attempt < max_attempts - 1:
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 16.0)
                    await self._reconnect()
        raise last_exc or RuntimeError(f'{op_name}: max attempts exceeded')

    async def close(self) -> None:
        self._closed = True
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self._transport:
            await self._transport.close()
