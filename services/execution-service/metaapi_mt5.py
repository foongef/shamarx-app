"""MetaAPI-based MT5 backend. Connects to a real MT5 broker account via metaapi.cloud."""

import os
import asyncio
import logging
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional, TypeVar

import httpx
from metaapi_cloud_sdk import MetaApi

T = TypeVar("T")

# Errors that signal "transient connection problem — try reconnecting once".
# We match by class name to stay robust across MetaApi SDK versions.
_RECONNECTABLE_ERROR_NAMES = {
    "ConnectionError",
    "TimeoutError",
    "TimeoutException",
    "WebsocketDisconnectedException",
    "InternalException",
    "NotSynchronizedException",
    "TooManyRequestsException",
}


def _is_reconnectable(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in _RECONNECTABLE_ERROR_NAMES:
        return True
    msg = str(exc).lower()
    return any(
        kw in msg
        for kw in ("disconnect", "timeout", "not synchronized", "websocket", "connection reset", "broken pipe")
    )

from broker_base import Broker
from models import (
    OrderRequest,
    OrderResponse,
    OrderStatus,
    Position,
    AccountInfo,
    CandleData,
    ClosePositionResponse,
    Side,
)

logger = logging.getLogger(__name__)

# Map our timeframe names to MetaAPI timeframe strings
TIMEFRAME_MAP = {
    "M1": "1m",
    "M5": "5m",
    "M15": "15m",
    "H1": "1h",
    "H4": "4h",
    "D1": "1d",
}


class MetaApiMT5(Broker):
    # Standard symbols we support
    KNOWN_SYMBOLS = ["XAUUSD", "GBPUSD", "EURUSD", "USDJPY", "US30", "NAS100"]

    def __init__(self, account_id: str = "", access_token: str = ""):
        # Allow no-arg construction for legacy module-level singleton — falls
        # through to env vars in that case (preserves backwards-compat).
        self.account_id = account_id or os.getenv("METAAPI_ACCOUNT_ID_DEMO", "")
        self.access_token = access_token or os.getenv("METAAPI_ACCESS_TOKEN", "")
        self._api: Optional[MetaApi] = None
        self._connection = None
        self._account = None
        self._initialized = False
        self._symbol_map: dict[str, str] = {}    # our symbol -> broker symbol
        self._reverse_map: dict[str, str] = {}   # broker symbol -> our symbol
        self._init_lock = asyncio.Lock()
        self._keepalive_task: Optional[asyncio.Task] = None

    @classmethod
    def from_creds(cls, creds: dict) -> 'MetaApiMT5':
        return cls(account_id=creds['accountId'], access_token=creds['accessToken'])

    async def initialize(self, force: bool = False):
        # Serialize initialization to prevent concurrent reconnects from racing.
        async with self._init_lock:
            if self._initialized and not force:
                return
            if force:
                logger.warning("Forcing MetaAPI re-initialization")
                self._initialized = False
                # Best-effort close of stale connection
                try:
                    if self._connection is not None:
                        await self._connection.close()
                except Exception:
                    pass
                self._connection = None

            token = self.access_token
            account_id = self.account_id

            if not token or not account_id:
                raise RuntimeError("METAAPI_ACCESS_TOKEN and METAAPI_ACCOUNT_ID_DEMO must be set")

            self._api = MetaApi(token)
            self._account = await self._api.metatrader_account_api.get_account(account_id)

            if self._account.state != "DEPLOYED":
                logger.info("Deploying MetaAPI account...")
                await self._account.deploy()
                await self._account.wait_deployed()

            self._connection = self._account.get_rpc_connection()
            await self._connection.connect()
            await self._connection.wait_synchronized()

            # Build symbol map by matching broker symbols to our known symbols
            broker_symbols = await self._connection.get_symbols()
            for our_symbol in self.KNOWN_SYMBOLS:
                for bs in broker_symbols:
                    if bs.startswith(our_symbol):
                        self._symbol_map[our_symbol] = bs
                        self._reverse_map[bs] = our_symbol
                        break

            self._initialized = True
            logger.info(f"MetaAPI connected. Symbol map: {self._symbol_map}")

            # Start keepalive after first successful init to prevent the websocket
            # from going stale during quiet periods (~50min idle = silent disconnect).
            if self._keepalive_task is None or self._keepalive_task.done():
                self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def _keepalive_loop(self):
        """Ping the MetaAPI account every 5 minutes to prevent idle disconnect."""
        try:
            while True:
                await asyncio.sleep(300)  # 5 minutes
                if not self._initialized or self._connection is None:
                    continue
                try:
                    await self._connection.get_account_information()
                except Exception as e:
                    logger.warning(f"Keepalive ping failed (will reconnect on next call): {e}")
                    self._initialized = False
        except asyncio.CancelledError:
            return

    async def _with_reconnect(
        self,
        op_name: str,
        fn: Callable[[], Awaitable[T]],
    ) -> T:
        """Run an MetaAPI op; reconnect once on transient connection errors."""
        await self.initialize()
        try:
            return await fn()
        except Exception as e:
            if not _is_reconnectable(e):
                raise
            logger.warning(
                f"[{op_name}] connection error: {type(e).__name__}: {e} — reconnecting once"
            )
            try:
                await self.initialize(force=True)
            except Exception as init_err:
                logger.error(f"[{op_name}] reconnect failed: {init_err}")
                raise
            return await fn()

    def _broker_symbol(self, symbol: str) -> str:
        """Convert our symbol name to broker's symbol name."""
        broker = self._symbol_map.get(symbol)
        if not broker:
            raise ValueError(
                f"No broker symbol found for '{symbol}'. "
                f"Available: {self._symbol_map}"
            )
        return broker

    def _our_symbol(self, broker_symbol: str) -> str:
        """Convert broker's symbol name back to ours."""
        return self._reverse_map.get(broker_symbol, broker_symbol)

    async def place_order(self, request: OrderRequest) -> OrderResponse:
        await self.initialize()
        broker_symbol = self._broker_symbol(request.symbol)

        async def _do() -> OrderResponse:
            if request.side == Side.BUY:
                result = await self._connection.create_market_buy_order(
                    broker_symbol, request.lot_size, request.sl_price, request.tp_price,
                    {"comment": request.comment or ""},
                )
            else:
                result = await self._connection.create_market_sell_order(
                    broker_symbol, request.lot_size, request.sl_price, request.tp_price,
                    {"comment": request.comment or ""},
                )
            return OrderResponse(
                orderId=result.get("orderId", ""),
                mt5Ticket=result.get("positionId"),
                status=OrderStatus.FILLED.value,
                message=f"Order filled via MetaAPI",
            )

        try:
            return await self._with_reconnect("place_order", _do)
        except Exception as e:
            logger.error(f"Order failed: {e}")
            return OrderResponse(
                orderId="",
                mt5Ticket=None,
                status=OrderStatus.REJECTED.value,
                message=str(e),
            )

    async def get_positions(self, symbol: Optional[str] = None) -> list[Position]:
        positions_data = await self._with_reconnect(
            "get_positions",
            lambda: self._connection.get_positions(),
        )

        def _open_time_str(value) -> str:
            """MetaApi returns `time` as a datetime; serialize to ISO-8601 UTC."""
            if isinstance(value, datetime):
                return value.astimezone(timezone.utc).isoformat()
            return str(value or "")

        positions = []

        for pos in positions_data:
            pos_symbol = self._our_symbol(pos.get("symbol", ""))
            if symbol and pos_symbol != symbol:
                continue

            side = "BUY" if pos.get("type") == "POSITION_TYPE_BUY" else "SELL"
            try:
                ticket_raw = pos.get("id", 0)
                ticket = int(ticket_raw) if isinstance(ticket_raw, (str, int, float)) else 0
                positions.append(
                    Position(
                        ticket=ticket,
                        symbol=pos_symbol,
                        side=side,
                        lotSize=float(pos.get("volume", 0)),
                        entryPrice=float(pos.get("openPrice", 0)),
                        currentPrice=float(pos.get("currentPrice", 0)),
                        sl=float(pos.get("stopLoss", 0) or 0),
                        tp=float(pos.get("takeProfit", 0) or 0),
                        pnl=float(pos.get("profit", 0) or 0),
                        openTime=_open_time_str(pos.get("time")),
                    )
                )
            except Exception as map_err:
                logger.error(f"Failed to map position {pos.get('id')}: {map_err}")
                continue

        return positions

    async def close_position(
        self,
        ticket: int,
        lot_size: Optional[float] = None,
    ) -> ClosePositionResponse:
        """Close an open position via MetaAPI. lot_size optional → full close."""
        async def _do():
            if lot_size is not None:
                return await self._connection.close_position_partially(str(ticket), lot_size)
            return await self._connection.close_position(str(ticket))

        try:
            result = await self._with_reconnect("close_position", _do)
            return ClosePositionResponse(
                ticket=ticket,
                status="CLOSED",
                message="Closed via MetaAPI",
                closePrice=result.get("price") if isinstance(result, dict) else None,
                pnl=None,
            )
        except Exception as e:
            logger.error(f"close_position({ticket}) failed: {e}")
            return ClosePositionResponse(
                ticket=ticket,
                status="REJECTED",
                message=str(e),
            )

    async def modify_position(
        self,
        ticket: int,
        sl_price: Optional[float] = None,
        tp_price: Optional[float] = None,
    ) -> ClosePositionResponse:
        async def _do():
            await self._connection.modify_position(
                str(ticket),
                stop_loss=sl_price,
                take_profit=tp_price,
            )
            return None

        try:
            await self._with_reconnect("modify_position", _do)
            return ClosePositionResponse(
                ticket=ticket,
                status="MODIFIED",
                message=f"sl={sl_price} tp={tp_price}",
            )
        except Exception as e:
            logger.error(f"modify_position({ticket}) failed: {e}")
            return ClosePositionResponse(
                ticket=ticket,
                status="REJECTED",
                message=str(e),
            )

    async def get_account_info(self) -> AccountInfo:
        async def _do():
            info = await self._connection.get_account_information()
            positions = await self._connection.get_positions()
            return info, positions

        info, positions = await self._with_reconnect("get_account_info", _do)
        return AccountInfo(
            balance=info.get("balance", 0),
            equity=info.get("equity", 0),
            margin=info.get("margin", 0),
            freeMargin=info.get("freeMargin", 0),
            openPositions=len(positions),
        )

    async def get_position_close_info(self, ticket: int) -> Optional[dict]:
        """
        Look up the actual close info for a CLOSED position from broker history.
        Returns None if no closing deal is found yet (broker may take a moment
        to register the close after a market exit).

        Returns dict with: closePrice, realizedPnl, closeTime, exitReason
        (TP/SL/MANUAL inferred from deal reason field).
        """
        async def _do():
            return await self._connection.get_deals_by_position(str(ticket))

        try:
            result = await self._with_reconnect("get_deals_by_position", _do)
        except Exception as e:
            logger.warning(f"get_deals_by_position({ticket}) failed: {e}")
            return None

        # MetaApi returns {deals: [...], synchronizing: bool} — unwrap the list.
        if isinstance(result, dict):
            deals = result.get("deals", [])
        elif isinstance(result, list):
            deals = result
        else:
            deals = []

        # MT5 deal entry types: DEAL_ENTRY_IN (open), DEAL_ENTRY_OUT (close)
        closing_deals = [
            d for d in deals
            if d.get("entryType") == "DEAL_ENTRY_OUT"
        ]
        if not closing_deals:
            return None

        # Use the most recent closing deal (handles partial-then-full closes)
        closing_deals.sort(
            key=lambda d: d.get("time") if d.get("time") else datetime.min.replace(tzinfo=timezone.utc),
        )
        deal = closing_deals[-1]

        # Sum realized profit + commission + swap from ALL closing deals (covers partials)
        realized_pnl = sum(
            float(d.get("profit", 0) or 0)
            + float(d.get("commission", 0) or 0)
            + float(d.get("swap", 0) or 0)
            for d in closing_deals
        )

        close_time = deal.get("time")
        if isinstance(close_time, datetime):
            close_time = close_time.astimezone(timezone.utc).isoformat()

        # Reason mapping: MT5 reports `reason` like DEAL_REASON_SL, DEAL_REASON_TP,
        # DEAL_REASON_CLIENT (manual close), DEAL_REASON_EXPERT (EA close), etc.
        reason_raw = (deal.get("reason") or "").upper()
        if "SL" in reason_raw:
            exit_reason = "SL"
        elif "TP" in reason_raw:
            exit_reason = "TP"
        elif "CLIENT" in reason_raw or "EXPERT" in reason_raw or "MOBILE" in reason_raw:
            exit_reason = "MANUAL"
        else:
            exit_reason = "CLOSED"

        return {
            "closePrice": float(deal.get("price", 0) or 0),
            "realizedPnl": round(realized_pnl, 2),
            "closeTime": close_time or "",
            "exitReason": exit_reason,
        }

    async def get_candles(
        self, symbol: str, timeframe: str, count: int
    ) -> list[CandleData]:
        """Get recent candles via MetaAPI."""
        await self.initialize()

        broker_symbol = self._broker_symbol(symbol)
        tf = TIMEFRAME_MAP.get(timeframe, "15m")

        # Use the REST API to get historical candles
        token = self.access_token
        account_id = self.account_id
        url = (
            f"https://mt-market-data-client-api-v1.london.agiliumtrade.ai"
            f"/users/current/accounts/{account_id}"
            f"/historical-market-data/symbols/{broker_symbol}"
            f"/timeframes/{tf}/candles"
        )

        # Retry once on transient HTTP errors. MetaApi market-data API can flake
        # under load (502/504) and after long idle gaps.
        last_err: Optional[Exception] = None
        data = None
        for attempt in range(2):
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        url,
                        headers={"auth-token": token},
                        params={"limit": count},
                        timeout=30,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    break
            except (httpx.HTTPError, httpx.TimeoutException) as e:
                last_err = e
                logger.warning(
                    f"[get_candles] {symbol} {timeframe} attempt {attempt + 1}/2 failed: {e}"
                )
                if attempt == 0:
                    await asyncio.sleep(1)
                    continue
                raise
        if data is None:
            raise RuntimeError(f"get_candles failed: {last_err}")

        candles = []
        for c in data:
            candles.append(
                CandleData(
                    symbol=symbol,
                    timeframe=timeframe,
                    openTime=c["time"],
                    open=c["open"],
                    high=c["high"],
                    low=c["low"],
                    close=c["close"],
                    volume=c.get("tickVolume", 0),
                )
            )

        return candles

    async def get_historical_candles(
        self,
        symbol: str,
        timeframe: str,
        start: datetime,
        end: datetime,
    ) -> list[CandleData]:
        """Fetch historical candles in pages.

        MetaAPI returns candles BACKWARD from startTime, so we paginate
        backward from the end date, collecting all pages, then filter
        to the requested range and sort chronologically.
        """
        await self.initialize()

        broker_symbol = self._broker_symbol(symbol)
        tf = TIMEFRAME_MAP.get(timeframe, "15m")
        token = self.access_token
        account_id = self.account_id

        base_url = (
            f"https://mt-market-data-client-api-v1.london.agiliumtrade.ai"
            f"/users/current/accounts/{account_id}"
            f"/historical-market-data/symbols/{broker_symbol}"
            f"/timeframes/{tf}/candles"
        )

        start_utc = start.replace(tzinfo=timezone.utc) if start.tzinfo is None else start
        end_utc = end.replace(tzinfo=timezone.utc) if end.tzinfo is None else end

        all_candles: list[CandleData] = []
        current_end = end_utc

        async with httpx.AsyncClient() as client:
            while True:
                resp = await client.get(
                    base_url,
                    headers={"auth-token": token},
                    params={
                        "startTime": current_end.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                        "limit": 1000,
                    },
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()

                if not data:
                    break

                page_candles = []
                for c in data:
                    candle_time = datetime.fromisoformat(c["time"].replace("Z", "+00:00"))

                    # Only include candles within our date range
                    if candle_time < start_utc:
                        continue
                    if candle_time > end_utc:
                        continue

                    page_candles.append(
                        CandleData(
                            symbol=symbol,
                            timeframe=timeframe,
                            openTime=c["time"],
                            open=c["open"],
                            high=c["high"],
                            low=c["low"],
                            close=c["close"],
                            volume=c.get("tickVolume", 0),
                        )
                    )

                all_candles.extend(page_candles)

                # API returns candles in chronological order: data[0]=oldest, data[-1]=newest
                # All candles are BEFORE the startTime cursor
                # Move cursor to the oldest candle in this page to get earlier data
                oldest_time = datetime.fromisoformat(data[0]["time"].replace("Z", "+00:00"))
                if oldest_time <= start_utc:
                    break  # We've collected everything past our start date
                if oldest_time >= current_end:
                    break  # No progress, avoid infinite loop

                current_end = oldest_time

                if len(data) < 1000:
                    break  # Last page

        # Sort chronologically (API returns backward)
        all_candles.sort(key=lambda c: c.open_time)

        # Deduplicate by openTime
        seen = set()
        unique_candles = []
        for c in all_candles:
            if c.open_time not in seen:
                seen.add(c.open_time)
                unique_candles.append(c)

        logger.info(f"Fetched {len(unique_candles)} {timeframe} candles for {symbol}")
        return unique_candles

    async def close(self) -> None:
        """Close any persistent connection (e.g. MetaApi WebSocket).
        For the legacy singleton path this is a no-op; multi-account
        registry teardown will call this to release the RPC connection.
        """
        # Cancel keepalive loop if running
        if self._keepalive_task is not None:
            try:
                self._keepalive_task.cancel()
            except Exception:
                pass
            self._keepalive_task = None
        # Best-effort close of RPC connection
        if self._connection is not None:
            try:
                await self._connection.close()
            except Exception:
                pass
            self._connection = None
        self._initialized = False


# Singleton — lazy-initialized
metaapi_mt5 = MetaApiMT5()
