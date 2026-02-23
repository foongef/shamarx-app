"""MetaAPI-based MT5 backend. Connects to a real MT5 broker account via metaapi.cloud."""

import os
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from metaapi_cloud_sdk import MetaApi

from models import (
    OrderRequest,
    OrderResponse,
    OrderStatus,
    Position,
    AccountInfo,
    CandleData,
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


class MetaApiMT5:
    # Standard symbols we support
    KNOWN_SYMBOLS = ["XAUUSD", "GBPUSD", "EURUSD", "USDJPY"]

    def __init__(self):
        self._api: Optional[MetaApi] = None
        self._connection = None
        self._account = None
        self._initialized = False
        self._symbol_map: dict[str, str] = {}    # our symbol -> broker symbol
        self._reverse_map: dict[str, str] = {}   # broker symbol -> our symbol

    async def initialize(self):
        if self._initialized:
            return

        token = os.getenv("METAAPI_ACCESS_TOKEN")
        account_id = os.getenv("METAAPI_ACCOUNT_ID_DEMO")

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
        action = "ORDER_TYPE_BUY" if request.side == Side.BUY else "ORDER_TYPE_SELL"

        try:
            result = await self._connection.create_market_buy_order(
                broker_symbol, request.lot_size, request.sl_price, request.tp_price,
                {"comment": request.comment or ""}
            ) if request.side == Side.BUY else await self._connection.create_market_sell_order(
                broker_symbol, request.lot_size, request.sl_price, request.tp_price,
                {"comment": request.comment or ""}
            )

            return OrderResponse(
                orderId=result.get("orderId", ""),
                mt5Ticket=result.get("positionId"),
                status=OrderStatus.FILLED.value,
                message=f"Order filled via MetaAPI",
            )
        except Exception as e:
            logger.error(f"Order failed: {e}")
            return OrderResponse(
                orderId="",
                mt5Ticket=None,
                status=OrderStatus.REJECTED.value,
                message=str(e),
            )

    async def get_positions(self, symbol: Optional[str] = None) -> list[Position]:
        await self.initialize()

        positions_data = await self._connection.get_positions()
        positions = []

        for pos in positions_data:
            pos_symbol = self._our_symbol(pos.get("symbol", ""))
            if symbol and pos_symbol != symbol:
                continue

            side = "BUY" if pos.get("type") == "POSITION_TYPE_BUY" else "SELL"
            positions.append(
                Position(
                    ticket=pos.get("id", 0),
                    symbol=pos_symbol,
                    side=side,
                    lotSize=pos.get("volume", 0),
                    entryPrice=pos.get("openPrice", 0),
                    currentPrice=pos.get("currentPrice", 0),
                    sl=pos.get("stopLoss", 0),
                    tp=pos.get("takeProfit", 0),
                    pnl=pos.get("profit", 0),
                    openTime=pos.get("time", ""),
                )
            )

        return positions

    async def get_account_info(self) -> AccountInfo:
        await self.initialize()

        info = await self._connection.get_account_information()
        positions = await self._connection.get_positions()

        return AccountInfo(
            balance=info.get("balance", 0),
            equity=info.get("equity", 0),
            margin=info.get("margin", 0),
            freeMargin=info.get("freeMargin", 0),
            openPositions=len(positions),
        )

    async def get_candles(
        self, symbol: str, timeframe: str, count: int
    ) -> list[CandleData]:
        """Get recent candles via MetaAPI."""
        await self.initialize()

        broker_symbol = self._broker_symbol(symbol)
        tf = TIMEFRAME_MAP.get(timeframe, "15m")

        # Use the REST API to get historical candles
        token = os.getenv("METAAPI_ACCESS_TOKEN")
        account_id = os.getenv("METAAPI_ACCOUNT_ID_DEMO")
        url = (
            f"https://mt-market-data-client-api-v1.london.agiliumtrade.ai"
            f"/users/current/accounts/{account_id}"
            f"/historical-market-data/symbols/{broker_symbol}"
            f"/timeframes/{tf}/candles"
        )

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                url,
                headers={"auth-token": token},
                params={"limit": count},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()

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
        token = os.getenv("METAAPI_ACCESS_TOKEN")
        account_id = os.getenv("METAAPI_ACCOUNT_ID_DEMO")

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


# Singleton — lazy-initialized
metaapi_mt5 = MetaApiMT5()
