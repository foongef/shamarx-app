import os
from typing import Optional
from fastapi import APIRouter, Query

from models import OrderRequest, OrderResponse, Position, AccountInfo, CandleData
from mock_mt5 import mock_mt5

orders_router = APIRouter()
positions_router = APIRouter()
account_router = APIRouter()
candles_router = APIRouter()


def get_mode() -> str:
    return os.getenv("MT5_MODE", "mock")


def get_mock():
    return mock_mt5


def get_metaapi():
    from metaapi_mt5 import metaapi_mt5
    return metaapi_mt5


@orders_router.post("", response_model=OrderResponse)
async def place_order(request: OrderRequest):
    mode = get_mode()
    if mode == "metaapi":
        return await get_metaapi().place_order(request)
    return get_mock().place_order(request)


@positions_router.get("", response_model=list[Position])
async def get_positions(symbol: Optional[str] = Query(None)):
    mode = get_mode()
    if mode == "metaapi":
        return await get_metaapi().get_positions(symbol)
    return get_mock().get_positions(symbol)


@account_router.get("", response_model=AccountInfo)
async def get_account():
    mode = get_mode()
    if mode == "metaapi":
        return await get_metaapi().get_account_info()
    return get_mock().get_account_info()


@candles_router.get("", response_model=list[CandleData])
async def get_candles(
    symbol: str = Query(default="XAUUSD"),
    timeframe: str = Query(default="M15"),
    count: int = Query(default=100, ge=1, le=1000),
):
    mode = get_mode()
    if mode == "metaapi":
        return await get_metaapi().get_candles(symbol, timeframe, count)
    return get_mock().get_candles(symbol, timeframe, count)
