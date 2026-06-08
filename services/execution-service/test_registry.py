import asyncio
import pytest
from registry import BrokerClientRegistry
from broker_base import Broker


class FakeClient(Broker):
    instances_created = 0

    def __init__(self):
        FakeClient.instances_created += 1
        self.initialized = False
        self.closed = False

    async def initialize(self): self.initialized = True
    async def place_order(self, request): return None
    async def get_positions(self, symbol=None): return []
    async def close_position(self, ticket): return {}
    async def modify_position(self, ticket, sl_price, tp_price): return {}
    async def get_account_info(self): return None
    async def get_position_close_info(self, ticket): return None
    async def close(self): self.closed = True


@pytest.fixture(autouse=True)
def reset_fake():
    FakeClient.instances_created = 0


async def test_get_or_create_returns_same_instance_per_account():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    a = await r.get_or_create('acct-1', {}, 'mock')
    b = await r.get_or_create('acct-1', {}, 'mock')
    assert a is b
    assert FakeClient.instances_created == 1


async def test_get_or_create_different_accounts():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    a = await r.get_or_create('acct-1', {}, 'mock')
    b = await r.get_or_create('acct-2', {}, 'mock')
    assert a is not b
    assert FakeClient.instances_created == 2


async def test_initialize_called_once():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    client = await r.get_or_create('acct-1', {}, 'mock')
    assert client.initialized is True


async def test_remove_closes_client():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    client = await r.get_or_create('acct-1', {}, 'mock')
    await r.remove('acct-1')
    assert client.closed is True
    assert 'acct-1' not in r._clients


async def test_concurrent_init_same_account_creates_one_client():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    results = await asyncio.gather(*[r.get_or_create('acct-1', {}, 'mock') for _ in range(5)])
    assert all(c is results[0] for c in results)
    assert FakeClient.instances_created == 1
