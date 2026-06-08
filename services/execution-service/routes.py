import os
import json
import logging
from typing import Optional
from fastapi import APIRouter, Body, Depends, Header, Query, HTTPException

from models import (
    OrderRequest,
    OrderResponse,
    Position,
    AccountInfo,
    CandleData,
    ClosePositionRequest,
    ModifyPositionRequest,
    ClosePositionResponse,
)
from mock_mt5 import mock_mt5
from registry import registry
from broker_base import Broker

_logger = logging.getLogger(__name__)
_redis = None


def _get_redis():
    """Lazy redis client. Returns None if redis unavailable so caller can fall back."""
    global _redis
    if _redis is None:
        try:
            import redis as _redis_lib

            _redis = _redis_lib.Redis(
                host=os.getenv("REDIS_HOST", "redis"),
                port=int(os.getenv("REDIS_PORT", "6379")),
                decode_responses=True,
                socket_connect_timeout=1,
            )
        except Exception as e:
            _logger.warning(f"Redis unavailable: {e}")
            _redis = False
    return _redis if _redis else None

orders_router = APIRouter()
positions_router = APIRouter()
account_router = APIRouter()
candles_router = APIRouter()


def get_mode() -> str:
    """Mode resolution order: Redis runtime override > env var > default 'mock'."""
    r = _get_redis()
    if r:
        try:
            override = r.get("live:engine:mode")
            if override and override in ("mock", "metaapi"):
                return override
        except Exception:
            pass
    return os.getenv("MT5_MODE", "mock")


def get_mock():
    return mock_mt5


def get_metaapi():
    from metaapi_mt5 import metaapi_mt5
    return metaapi_mt5


@orders_router.post("", response_model=OrderResponse)
async def place_order(request: OrderRequest):
    mode = get_mode()
    try:
        if mode == "metaapi":
            return await get_metaapi().place_order(request)
        return get_mock().place_order(request)
    except Exception as e:
        _logger.error(f"place_order failed: {e}")
        return OrderResponse(
            orderId="",
            mt5Ticket=None,
            status="REJECTED",
            message=f"execution error: {e}",
        )


@positions_router.get("", response_model=list[Position])
async def get_positions(symbol: Optional[str] = Query(None)):
    mode = get_mode()
    try:
        if mode == "metaapi":
            return await get_metaapi().get_positions(symbol)
        return get_mock().get_positions(symbol)
    except Exception as e:
        _logger.warning(f"get_positions failed: {e}")
        return []


@positions_router.post("/{ticket}/close", response_model=ClosePositionResponse)
async def close_position(ticket: int, request: ClosePositionRequest = ClosePositionRequest()):
    mode = get_mode()
    target = get_metaapi() if mode == "metaapi" else get_mock()
    if not hasattr(target, "close_position"):
        raise HTTPException(status_code=501, detail=f"close_position not implemented for {mode}")
    try:
        fn = target.close_position
        return await fn(ticket, request.lot_size) if mode == "metaapi" else fn(ticket, request.lot_size)
    except Exception as e:
        _logger.error(f"close_position({ticket}) failed: {e}")
        return ClosePositionResponse(
            ticket=ticket, status="REJECTED", message=f"execution error: {e}"
        )


@positions_router.get("/{ticket}/history")
async def get_position_history(ticket: int):
    """Look up the actual close info for a closed position from broker history.
    Returns null if no closing deal exists yet (broker hasn't registered the close)."""
    mode = get_mode()
    target = get_metaapi() if mode == "metaapi" else get_mock()
    if not hasattr(target, "get_position_close_info"):
        return None
    try:
        fn = target.get_position_close_info
        result = await fn(ticket) if mode == "metaapi" else fn(ticket)
        return result
    except Exception as e:
        _logger.warning(f"get_position_history({ticket}) failed: {e}")
        return None


@positions_router.post("/{ticket}/modify", response_model=ClosePositionResponse)
async def modify_position(ticket: int, request: ModifyPositionRequest):
    mode = get_mode()
    target = get_metaapi() if mode == "metaapi" else get_mock()
    if not hasattr(target, "modify_position"):
        raise HTTPException(status_code=501, detail=f"modify_position not implemented for {mode}")
    try:
        fn = target.modify_position
        return await fn(ticket, request.sl_price, request.tp_price) if mode == "metaapi" else fn(ticket, request.sl_price, request.tp_price)
    except Exception as e:
        _logger.error(f"modify_position({ticket}) failed: {e}")
        return ClosePositionResponse(
            ticket=ticket, status="REJECTED", message=f"execution error: {e}"
        )


@account_router.get("", response_model=AccountInfo)
async def get_account():
    mode = get_mode()
    try:
        if mode == "metaapi":
            return await get_metaapi().get_account_info()
        return get_mock().get_account_info()
    except Exception as e:
        _logger.warning(f"get_account failed: {e}")
        # Return a clearly-zeroed snapshot rather than 500ing — frontend handles it
        return AccountInfo(balance=0, equity=0, margin=0, freeMargin=0, openPositions=0)


@account_router.post("/mock/reset")
async def reset_mock(payload: dict = Body(default={})):
    """Reset the in-memory mock account to a fresh balance. Mock mode only."""
    if get_mode() != "mock":
        raise HTTPException(status_code=400, detail="Not in mock mode")
    balance = float(payload.get("balance", 10000))
    if balance <= 0 or balance > 1_000_000:
        raise HTTPException(status_code=400, detail="balance must be between 1 and 1,000,000")
    return get_mock().reset(balance)


async def resolve_client(
    account_id: str,
    x_broker_creds: Optional[str] = Header(None),
    x_broker_mode: str = Header('metaapi'),
) -> Broker:
    """Resolve the broker client for this account, lazy-initializing if needed.
    Creds arrive as JSON in the X-Broker-Creds header (sent by NestJS)."""
    if not x_broker_creds:
        raise HTTPException(401, "X-Broker-Creds header required")
    try:
        creds = json.loads(x_broker_creds)
    except json.JSONDecodeError:
        raise HTTPException(400, "X-Broker-Creds must be valid JSON")
    return await registry.get_or_create(account_id, creds, x_broker_mode)


@candles_router.get("", response_model=list[CandleData])
async def get_candles(
    symbol: str = Query(default="XAUUSD"),
    timeframe: str = Query(default="M15"),
    count: int = Query(default=100, ge=1, le=1000),
):
    mode = get_mode()
    try:
        if mode == "metaapi":
            return await get_metaapi().get_candles(symbol, timeframe, count)
        return get_mock().get_candles(symbol, timeframe, count)
    except Exception as e:
        _logger.warning(f"get_candles failed for {symbol} {timeframe}: {e}")
        # Return empty list — calling code should preserve last-known data
        return []


account_scoped_router = APIRouter()


@account_scoped_router.get("/{account_id}/positions", response_model=list[Position])
async def get_account_positions(
    account_id: str,
    client: Broker = Depends(resolve_client),
    symbol: Optional[str] = Query(None),
):
    return await client.get_positions(symbol)


@account_scoped_router.post("/{account_id}/orders", response_model=OrderResponse)
async def place_account_order(
    account_id: str,
    request: OrderRequest,
    client: Broker = Depends(resolve_client),
):
    try:
        return await client.place_order(request)
    except Exception as e:
        _logger.error(f"place_order failed for account={account_id}: {e}")
        return OrderResponse(
            orderId="", mt5Ticket=None, status="REJECTED", message=f"execution error: {e}",
        )


@account_scoped_router.post("/{account_id}/positions/{ticket}/modify", response_model=ClosePositionResponse)
async def modify_account_position(
    account_id: str,
    ticket: int,
    body: ModifyPositionRequest,
    client: Broker = Depends(resolve_client),
):
    return await client.modify_position(ticket, body.sl_price, body.tp_price)


@account_scoped_router.get("/{account_id}/positions/{ticket}/history")
async def get_account_position_history(
    account_id: str,
    ticket: int,
    client: Broker = Depends(resolve_client),
):
    info = await client.get_position_close_info(ticket)
    if info is None:
        raise HTTPException(404, "Position history not found")
    return info


@account_scoped_router.get("/{account_id}/account-info", response_model=AccountInfo)
async def get_account_info_for_account(
    account_id: str,
    client: Broker = Depends(resolve_client),
):
    return await client.get_account_info()


@account_scoped_router.post("/{account_id}/positions/{ticket}/close", response_model=ClosePositionResponse)
async def close_account_position(
    account_id: str,
    ticket: int,
    client: Broker = Depends(resolve_client),
):
    return await client.close_position(ticket)


@account_scoped_router.post("/{account_id}/disconnect")
async def disconnect_account(account_id: str):
    await registry.remove(account_id)
    return {"ok": True}
