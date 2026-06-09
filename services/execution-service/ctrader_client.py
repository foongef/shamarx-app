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
        raise NotImplementedError('Task 5')

    async def place_order(self, request) -> object:
        raise NotImplementedError('Task 6')

    async def get_positions(self, symbol: Optional[str] = None) -> list:
        raise NotImplementedError('Task 7')

    async def close_position(self, ticket: int) -> dict:
        raise NotImplementedError('Task 6')

    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict:
        raise NotImplementedError('Task 6')

    async def get_account_info(self) -> object:
        raise NotImplementedError('Task 7')

    async def get_position_close_info(self, ticket: int) -> Optional[dict]:
        raise NotImplementedError('Task 7')

    async def close(self) -> None:
        self._closed = True
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self._transport:
            await self._transport.close()
