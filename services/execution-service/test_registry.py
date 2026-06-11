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
    r = BrokerClientRegistry(factory=lambda creds, broker, mode: FakeClient())
    a = await r.get_or_create('acct-1', {}, 'MOCK', 'mock')
    b = await r.get_or_create('acct-1', {}, 'MOCK', 'mock')
    assert a is b
    assert FakeClient.instances_created == 1


async def test_get_or_create_different_accounts():
    r = BrokerClientRegistry(factory=lambda creds, broker, mode: FakeClient())
    a = await r.get_or_create('acct-1', {}, 'MOCK', 'mock')
    b = await r.get_or_create('acct-2', {}, 'MOCK', 'mock')
    assert a is not b
    assert FakeClient.instances_created == 2


async def test_initialize_called_once():
    r = BrokerClientRegistry(factory=lambda creds, broker, mode: FakeClient())
    client = await r.get_or_create('acct-1', {}, 'MOCK', 'mock')
    assert client.initialized is True


async def test_remove_closes_client():
    r = BrokerClientRegistry(factory=lambda creds, broker, mode: FakeClient())
    client = await r.get_or_create('acct-1', {}, 'MOCK', 'mock')
    await r.remove('acct-1')
    assert client.closed is True
    assert 'acct-1' not in r._clients


async def test_concurrent_init_same_account_creates_one_client():
    r = BrokerClientRegistry(factory=lambda creds, broker, mode: FakeClient())
    results = await asyncio.gather(*[r.get_or_create('acct-1', {}, 'MOCK', 'mock') for _ in range(5)])
    assert all(c is results[0] for c in results)
    assert FakeClient.instances_created == 1


async def test_factory_receives_broker_arg():
    received = {}
    def factory(creds, broker, mode):
        received['broker'] = broker
        received['mode'] = mode
        return FakeClient()
    r = BrokerClientRegistry(factory=factory)
    await r.get_or_create('acct-1', {'foo': 'bar'}, 'CTRADER', 'metaapi')
    assert received['broker'] == 'CTRADER'
    assert received['mode'] == 'metaapi'


async def test_resolve_client_must_not_clobber_metaapi_account_id():
    """Regression: resolve_client injects the BrokerAccount row id into creds.
    It must use the 'brokerAccountId' key — overwriting 'accountId' broke
    every MetaApi call in prod (2026-06-10) because MetaApiMT5.from_creds
    reads creds['accountId'] as the MetaApi CLOUD account id."""
    import json
    from unittest.mock import AsyncMock, patch
    import routes

    captured = {}

    async def fake_get_or_create(account_id, creds, broker, mode):
        captured['creds'] = creds
        return AsyncMock()

    with patch.object(routes.registry, 'get_or_create', side_effect=fake_get_or_create):
        metaapi_creds = json.dumps({'accountId': 'metaapi-cloud-id-123', 'accessToken': 'tok'})
        await routes.resolve_client(
            account_id='db-row-uuid-456',
            x_broker_creds=metaapi_creds,
            x_broker_mode='metaapi',
            x_broker='METAAPI',
        )

    assert captured['creds']['accountId'] == 'metaapi-cloud-id-123'  # untouched
    assert captured['creds']['brokerAccountId'] == 'db-row-uuid-456'  # injected separately


async def test_factory_dispatches_mt5_direct():
    received = {}

    def factory(creds, broker, mode):
        received['broker'] = broker
        return FakeClient()

    r = BrokerClientRegistry(factory=factory)
    await r.get_or_create('acct-x', {'managerUrl': 'http://h:8100'}, 'MT5_DIRECT', 'metaapi')
    assert received['broker'] == 'MT5_DIRECT'
