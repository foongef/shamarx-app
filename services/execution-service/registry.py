"""
Per-account broker client registry. Replaces the module-level
metaapi_mt5 / mock_mt5 singletons. One client per accountId; lazy
initialized; thread-safe init via per-key asyncio.Lock.
"""
import asyncio
import logging
from typing import Callable, Dict, Optional
from broker_base import Broker

_logger = logging.getLogger(__name__)


def _default_factory(creds: dict, broker: str, mode: str) -> Broker:
    if mode == 'mock':
        from mock_mt5 import MockMT5
        return MockMT5()
    if broker == 'CTRADER':
        from ctrader_client import CTraderClient, make_token_refresh_callback
        client = CTraderClient.from_creds(creds)
        # Wire the refresh callback so the Python client can persist refreshed
        # tokens back to NestJS. brokerAccountId (the DB row id) is injected
        # into creds by resolve_client — distinct from any broker-side accountId.
        broker_account_id = creds.get('brokerAccountId')
        if broker_account_id:
            client._on_token_refresh = make_token_refresh_callback(str(broker_account_id))
        return client
    # Default + 'METAAPI'
    from metaapi_mt5 import MetaApiMT5
    return MetaApiMT5.from_creds(creds)


class BrokerClientRegistry:
    def __init__(self, factory: Optional[Callable[[dict, str, str], Broker]] = None):
        self._clients: Dict[str, Broker] = {}
        self._init_locks: Dict[str, asyncio.Lock] = {}
        self._factory = factory or _default_factory

    async def get_or_create(self, account_id: str, creds: dict, broker: str, mode: str) -> Broker:
        if account_id in self._clients:
            return self._clients[account_id]
        lock = self._init_locks.setdefault(account_id, asyncio.Lock())
        async with lock:
            if account_id in self._clients:
                return self._clients[account_id]
            client = self._factory(creds, broker, mode)
            await client.initialize()
            self._clients[account_id] = client
            _logger.info(f'BrokerClientRegistry: created client for account={account_id} broker={broker} mode={mode}')
            return client

    async def remove(self, account_id: str) -> None:
        client = self._clients.pop(account_id, None)
        if client:
            try:
                await client.close()
            except Exception as e:
                _logger.warning(f'Error closing client for account={account_id}: {e}')
        self._init_locks.pop(account_id, None)

    def known_accounts(self) -> list:
        return list(self._clients.keys())


# Module-level singleton — main.py / routes.py imports this.
registry = BrokerClientRegistry()
