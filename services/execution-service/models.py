from enum import Enum
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class OrderStatus(str, Enum):
    CREATED = "CREATED"
    SUBMITTED = "SUBMITTED"
    FILLED = "FILLED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class OrderRequest(BaseModel):
    symbol: str = "XAUUSD"
    side: Side
    lot_size: float = Field(alias="lotSize")
    entry_price: float = Field(alias="entryPrice")
    sl_price: float = Field(alias="slPrice")
    tp_price: float = Field(alias="tpPrice")
    comment: Optional[str] = None

    model_config = {"populate_by_name": True}


class OrderResponse(BaseModel):
    order_id: str = Field(alias="orderId")
    mt5_ticket: Optional[int] = Field(alias="mt5Ticket", default=None)
    status: str
    message: str

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class Position(BaseModel):
    ticket: int
    symbol: str
    side: str
    lot_size: float = Field(alias="lotSize")
    entry_price: float = Field(alias="entryPrice")
    current_price: float = Field(alias="currentPrice")
    sl: float
    tp: float
    pnl: float
    open_time: str = Field(alias="openTime")

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class AccountInfo(BaseModel):
    balance: float
    equity: float
    margin: float
    free_margin: float = Field(alias="freeMargin")
    open_positions: int = Field(alias="openPositions")

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class CandleData(BaseModel):
    symbol: str
    timeframe: str
    open_time: str = Field(alias="openTime")
    open: float
    high: float
    low: float
    close: float
    volume: float

    model_config = {"populate_by_name": True, "serialize_by_alias": True}
