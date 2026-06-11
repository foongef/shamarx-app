"""Mt5DirectClient — Broker ABC over the mt5-host terminal-manager.

The manager (services/mt5-host/manager.py) reverse-proxies
/t/{accountId}/* to the per-terminal worker, which speaks the same verb
shapes as the other brokers. creds carry:
  brokerAccountId — Spec 3 convention, injected by resolve_client
  managerUrl      — injected by BrokerHttpClient from the Mt5Host row
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx

from broker_base import Broker
from models import AccountInfo, OrderResponse


class Mt5DirectClient(Broker):
    def __init__(self, base_url: str, account_id: str, secret: str):
        self.base_url = base_url.rstrip('/')
        self.account_id = account_id
        self.secret = secret
        self._http: Any = None  # injected in tests; real client built in initialize

    @classmethod
    def from_creds(cls, creds: Dict[str, Any]) -> 'Mt5DirectClient':
        return cls(base_url=creds['managerUrl'],
                   account_id=str(creds['brokerAccountId']),
                   secret=os.getenv('MT5_MANAGER_SECRET', ''))

    async def initialize(self) -> None:
        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=30.0, headers={'X-Manager-Secret': self.secret})
        # liveness probe — provisioning already happened via the NestJS side
        r = await self._req('GET', 'account-info')
        if r.status_code >= 400:
            raise RuntimeError(
                f'mt5-host unreachable for {self.account_id}: {r.status_code}')

    async def _req(self, method: str, path: str, **kw):
        return await self._http.request(
            method, f'{self.base_url}/t/{self.account_id}/{path}', **kw)

    async def place_order(self, request) -> OrderResponse:
        side = request.side.value if hasattr(request.side, 'value') else str(request.side)
        r = await self._req('POST', 'orders', json={
            'symbol': request.symbol, 'side': side,
            'lotSize': request.lot_size, 'slPrice': request.sl_price,
            'tpPrice': request.tp_price, 'comment': request.comment,
        })
        d = r.json()
        return OrderResponse(orderId=d.get('orderId', ''),
                             mt5Ticket=d.get('mt5Ticket'),
                             status=d.get('status', 'REJECTED'),
                             message=d.get('message', ''))

    async def get_positions(self, symbol: Optional[str] = None) -> list:
        path = f'positions?symbol={symbol}' if symbol else 'positions'
        r = await self._req('GET', path)
        return r.json()

    async def close_position(self, ticket: int) -> dict:
        r = await self._req('POST', f'positions/{ticket}/close')
        return r.json()

    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict:
        r = await self._req('POST', f'positions/{ticket}/modify',
                            json={'slPrice': sl_price, 'tpPrice': tp_price})
        return r.json()

    async def get_account_info(self) -> AccountInfo:
        r = await self._req('GET', 'account-info')
        return AccountInfo(**r.json())

    async def get_position_close_info(self, ticket: int) -> Optional[dict]:
        r = await self._req('GET', f'positions/{ticket}/history')
        body = r.json()
        return body or None

    async def get_candles(self, symbol: str, timeframe: str, count: int) -> list:
        r = await self._req('GET',
                            f'candles?symbol={symbol}&timeframe={timeframe}&count={count}')
        return r.json()

    async def get_historical_candles(self, symbol, timeframe, start, end) -> list:
        return []  # historical backfill stays Dukascopy-only

    async def close(self) -> None:
        if self._http is not None and hasattr(self._http, 'aclose'):
            await self._http.aclose()
