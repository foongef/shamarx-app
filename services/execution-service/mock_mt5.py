"""Mock MT5 module for development on macOS.
Simulates fills, positions, account state, and candle data for XAUUSD.
"""

import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

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


class MockMT5:
    def __init__(self):
        self._balance = 10000.0
        self._equity = 10000.0
        self._positions: dict[int, dict] = {}
        self._next_ticket = 100001
        self._base_price = 2650.00  # Base XAUUSD price
        self._orders: dict[str, dict] = {}

    def reset(self, balance: float = 10000.0) -> dict:
        self._balance = float(balance)
        self._equity = float(balance)
        self._positions.clear()
        self._orders.clear()
        self._closed_history: dict[int, dict] = {}
        return {"balance": self._balance, "equity": self._equity, "positions": 0}

    def get_position_close_info(self, ticket: int):
        """Return close info from mock history (set on close_position)."""
        return getattr(self, "_closed_history", {}).get(ticket)

    def _current_price(self) -> float:
        """Simulate small price movements."""
        return self._base_price + random.uniform(-5.0, 5.0)

    def _bid_ask(self) -> tuple[float, float]:
        mid = self._current_price()
        spread = random.uniform(0.20, 0.50)  # 20-50 points spread
        return round(mid - spread / 2, 2), round(mid + spread / 2, 2)

    def place_order(self, request: OrderRequest) -> OrderResponse:
        order_id = str(uuid.uuid4())
        ticket = self._next_ticket
        self._next_ticket += 1

        # Simulate fill at current price
        bid, ask = self._bid_ask()
        fill_price = ask if request.side == Side.BUY else bid

        self._positions[ticket] = {
            "ticket": ticket,
            "symbol": request.symbol,
            "side": request.side.value,
            "lot_size": request.lot_size,
            "entry_price": fill_price,
            "sl": request.sl_price,
            "tp": request.tp_price,
            "open_time": datetime.now(timezone.utc).isoformat(),
            "comment": request.comment,
        }

        self._orders[order_id] = {
            "order_id": order_id,
            "ticket": ticket,
            "status": OrderStatus.FILLED.value,
        }

        return OrderResponse(
            orderId=order_id,
            mt5Ticket=ticket,
            status=OrderStatus.FILLED.value,
            message=f"Order filled at {fill_price}",
        )

    def get_positions(self, symbol: Optional[str] = None) -> list[Position]:
        positions = []
        for ticket, pos in self._positions.items():
            if symbol and pos["symbol"] != symbol:
                continue

            current_price = self._current_price()
            if pos["side"] == Side.BUY.value:
                pnl = (current_price - pos["entry_price"]) * pos["lot_size"] * 100
            else:
                pnl = (pos["entry_price"] - current_price) * pos["lot_size"] * 100

            positions.append(
                Position(
                    ticket=ticket,
                    symbol=pos["symbol"],
                    side=pos["side"],
                    lotSize=pos["lot_size"],
                    entryPrice=pos["entry_price"],
                    currentPrice=current_price,
                    sl=pos["sl"],
                    tp=pos["tp"],
                    pnl=round(pnl, 2),
                    openTime=pos["open_time"],
                )
            )
        return positions

    def _calculate_pnl(self, pos: dict) -> float:
        current_price = self._current_price()
        if pos["side"] == Side.BUY.value:
            return (current_price - pos["entry_price"]) * pos["lot_size"] * 100
        return (pos["entry_price"] - current_price) * pos["lot_size"] * 100

    def close_position(self, ticket: int, lot_size: Optional[float] = None) -> ClosePositionResponse:
        if ticket not in self._positions:
            return ClosePositionResponse(
                ticket=ticket,
                status="REJECTED",
                message=f"Position {ticket} not found",
            )
        pos = self._positions[ticket]
        bid, ask = self._bid_ask()
        close_price = bid if pos["side"] == Side.BUY.value else ask
        pnl = self._calculate_pnl(pos)
        # Record into mock history before deleting so reconcile can find it
        if not hasattr(self, "_closed_history"):
            self._closed_history = {}
        self._closed_history[ticket] = {
            "closePrice": round(close_price, 2),
            "realizedPnl": round(pnl, 2),
            "closeTime": datetime.now(timezone.utc).isoformat(),
            "exitReason": "MANUAL",
        }
        # Mock: full close only (lot_size param is ignored for now)
        del self._positions[ticket]
        self._balance += pnl
        return ClosePositionResponse(
            ticket=ticket,
            status="CLOSED",
            message=f"Closed at {close_price}",
            closePrice=round(close_price, 2),
            pnl=round(pnl, 2),
        )

    def modify_position(
        self,
        ticket: int,
        sl_price: Optional[float] = None,
        tp_price: Optional[float] = None,
    ) -> ClosePositionResponse:
        if ticket not in self._positions:
            return ClosePositionResponse(
                ticket=ticket,
                status="REJECTED",
                message=f"Position {ticket} not found",
            )
        if sl_price is not None:
            self._positions[ticket]["sl"] = sl_price
        if tp_price is not None:
            self._positions[ticket]["tp"] = tp_price
        return ClosePositionResponse(
            ticket=ticket,
            status="MODIFIED",
            message=f"sl={sl_price} tp={tp_price}",
        )

    def get_account_info(self) -> AccountInfo:
        total_pnl = sum(
            self._calculate_pnl(pos) for pos in self._positions.values()
        )
        equity = self._balance + total_pnl
        margin = len(self._positions) * 1000  # Simplified margin calc

        bid, ask = self._bid_ask()

        return AccountInfo(
            balance=round(self._balance, 2),
            equity=round(equity, 2),
            margin=round(margin, 2),
            freeMargin=round(equity - margin, 2),
            openPositions=len(self._positions),
        )

    def get_candles(
        self, symbol: str, timeframe: str, count: int
    ) -> list[CandleData]:
        """Generate mock candle data with realistic XAUUSD price action."""
        candles = []
        now = datetime.now(timezone.utc)

        # Determine timeframe interval in minutes
        tf_minutes = {"M1": 1, "M5": 5, "M15": 15, "H1": 60, "H4": 240, "D1": 1440}
        interval = tf_minutes.get(timeframe, 15)

        # Align to timeframe boundary
        minutes_since_midnight = now.hour * 60 + now.minute
        aligned_minutes = (minutes_since_midnight // interval) * interval
        base_time = now.replace(
            hour=aligned_minutes // 60,
            minute=aligned_minutes % 60,
            second=0,
            microsecond=0,
        )

        price = self._base_price

        for i in range(count - 1, -1, -1):
            open_time = base_time - timedelta(minutes=interval * i)

            # Simulate candle with random walk
            open_price = price
            volatility = 2.0 if interval <= 15 else 5.0
            change = random.gauss(0, volatility)
            close_price = open_price + change

            high_price = max(open_price, close_price) + abs(
                random.gauss(0, volatility * 0.5)
            )
            low_price = min(open_price, close_price) - abs(
                random.gauss(0, volatility * 0.5)
            )
            volume = random.uniform(100, 500)

            candles.append(
                CandleData(
                    symbol=symbol,
                    timeframe=timeframe,
                    openTime=open_time.isoformat(),
                    open=round(open_price, 2),
                    high=round(high_price, 2),
                    low=round(low_price, 2),
                    close=round(close_price, 2),
                    volume=round(volume, 2),
                )
            )

            price = close_price

        return candles

    def _calculate_pnl(self, pos: dict) -> float:
        current_price = self._current_price()
        if pos["side"] == Side.BUY.value:
            return (current_price - pos["entry_price"]) * pos["lot_size"] * 100
        else:
            return (pos["entry_price"] - current_price) * pos["lot_size"] * 100


# Singleton instance
mock_mt5 = MockMT5()
