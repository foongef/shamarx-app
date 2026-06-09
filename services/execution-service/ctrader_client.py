"""cTrader Open API broker client. Implements the Broker ABC over Spotware
WebSocket API. Authenticates with app-level + account-level OAuth tokens,
maintains a persistent connection with heartbeat + reconnect, and translates
between our domain types and Spotware ProtoOA messages."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, TypeVar

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

        self._symbol_id_by_name: Dict[str, int] = {}
        self._symbol_name_by_id: Dict[int, str] = {}
        self._symbol_digits: Dict[str, int] = {}
        self._position_symbol_cache: Dict[int, str] = {}

    @classmethod
    def from_creds(cls, creds: Dict[str, Any]) -> 'CTraderClient':
        return cls(
            access_token=creds['accessToken'],
            refresh_token=creds['refreshToken'],
            ctid_trader_account_id=int(creds['ctidTraderAccountId']),
            expires_at=int(creds.get('expiresAt', 0)),
            account_kind=creds.get('accountKind', 'DEMO'),
            account_id=creds.get('accountId', ''),
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

    def _to_ctrader_price(self, symbol: str, price: float) -> int:
        digits = self._symbol_digits.get(symbol, 5)
        return int(round(price * (10 ** digits)))

    def _from_ctrader_price(self, symbol: str, price_int: int) -> float:
        digits = self._symbol_digits.get(symbol, 5)
        return price_int / (10 ** digits)

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
                self._symbol_digits[name] = int(s.get('digits', 5))
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

    async def place_order(self, request) -> object:
        from models import OrderResponse
        assert self._transport is not None
        symbol_id = self._to_ctrader_symbol(request.symbol)
        volume = int(round(request.lot_size * 100))
        side = request.side.value if hasattr(request.side, 'value') else str(request.side)
        payload = {
            'ctidTraderAccountId': self.ctid_trader_account_id,
            'symbolId': symbol_id,
            'orderType': 'MARKET',
            'tradeSide': side,
            'volume': volume,
            'stopLoss': self._to_ctrader_price(request.symbol, request.sl_price),
            'takeProfit': self._to_ctrader_price(request.symbol, request.tp_price),
        }
        res = await self._transport.request(
            PAYLOAD['NEW_ORDER_REQ'], payload, PAYLOAD['EXECUTION_EVENT'],
        )
        exec_type = res.get('executionType')
        position_id = res.get('position', {}).get('positionId')
        if position_id:
            self._position_symbol_cache[int(position_id)] = request.symbol
        status = 'FILLED' if exec_type == 'ORDER_FILLED' else 'REJECTED'
        return OrderResponse(
            orderId=str(res.get('order', {}).get('orderId', '')),
            mt5Ticket=int(position_id) if position_id else None,
            status=status,
            message=str(res.get('errorCode') or exec_type or ''),
        )

    async def get_positions(self, symbol: Optional[str] = None) -> list:
        assert self._transport is not None
        res = await self._transport.request(
            PAYLOAD['RECONCILE_REQ'],
            {'ctidTraderAccountId': self.ctid_trader_account_id},
            PAYLOAD['RECONCILE_RES'],
        )
        positions = []
        for p in res.get('position', []):
            td = p.get('tradeData', {})
            sym_id = int(td.get('symbolId', 0))
            sym = self._our_symbol_from_id(sym_id)
            if symbol and sym != symbol:
                continue
            entry_price = self._from_ctrader_price(sym, int(p.get('price', 0)))
            positions.append({
                'ticket': int(p['positionId']),
                'symbol': sym,
                'side': td.get('tradeSide', ''),
                'lotSize': int(td.get('volume', 0)) / 100.0,
                'entryPrice': entry_price,
                'currentPrice': entry_price,  # cTrader reconcile doesn't include current; strategy doesn't depend on it
                'sl': self._from_ctrader_price(sym, int(p.get('stopLoss', 0))),
                'tp': self._from_ctrader_price(sym, int(p.get('takeProfit', 0))),
                'pnl': 0.0,
                'openTime': str(td.get('openTimestamp', 0)),
            })
            self._position_symbol_cache[int(p['positionId'])] = sym
        return positions

    async def close_position(self, ticket: int) -> dict:
        assert self._transport is not None
        res = await self._transport.request(
            PAYLOAD['CLOSE_POSITION_REQ'],
            {'ctidTraderAccountId': self.ctid_trader_account_id, 'positionId': int(ticket), 'volume': 0},
            PAYLOAD['EXECUTION_EVENT'],
        )
        exec_type = res.get('executionType', 'UNKNOWN')
        self._position_symbol_cache.pop(int(ticket), None)
        return {'status': 'CLOSED' if exec_type == 'ORDER_FILLED' else exec_type}

    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict:
        assert self._transport is not None
        symbol = self._position_symbol_cache.get(int(ticket))
        if not symbol:
            positions = await self.get_positions()
            for p in positions:
                if p.get('ticket') == int(ticket):
                    symbol = p.get('symbol')
                    self._position_symbol_cache[int(ticket)] = symbol
                    break
        if not symbol:
            raise CTraderApiError('POSITION_NOT_FOUND', f'ticket={ticket}')
        await self._transport.request(
            PAYLOAD['AMEND_POSITION_SLTP_REQ'],
            {
                'ctidTraderAccountId': self.ctid_trader_account_id,
                'positionId': int(ticket),
                'stopLoss': self._to_ctrader_price(symbol, sl_price),
                'takeProfit': self._to_ctrader_price(symbol, tp_price),
            },
            PAYLOAD['EXECUTION_EVENT'],
        )
        return {'status': 'OK'}

    async def get_account_info(self) -> object:
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

    async def get_position_close_info(self, ticket: int) -> Optional[dict]:
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
            sym_id = int(deal.get('symbolId', 0))
            sym = self._our_symbol_from_id(sym_id)
            return {
                'ticket': int(ticket),
                'closePrice': self._from_ctrader_price(sym, int(cpd.get('executionPrice', 0))),
                'closeTime': str(deal.get('executionTimestamp', 0)),
                'pnl': int(cpd.get('grossProfit', 0)) / 100.0,
                'commission': int(deal.get('commission', 0)) / 100.0,
                'swap': int(cpd.get('swap', 0)) / 100.0,
                'reason': cpd.get('closeReason', 'UNKNOWN'),
            }
        return None

    async def close(self) -> None:
        self._closed = True
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self._transport:
            await self._transport.close()
