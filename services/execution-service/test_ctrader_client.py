import asyncio
import pytest
from ctrader_client import CTraderClient
from ctrader_protocol import PAYLOAD


class FakeTransport:
    """Records sent messages, returns canned responses keyed by expected response type."""

    def __init__(self, canned: dict[int, dict]):
        self.canned = canned
        self.sent: list[tuple[int, dict]] = []
        self.oneway: list[tuple[int, dict]] = []
        self.connected = False
        self.closed = False
        self.event_handlers: dict[int, callable] = {}

    async def connect(self):
        self.connected = True

    async def close(self):
        self.closed = True

    def on_event(self, payload_type, handler):
        self.event_handlers[payload_type] = handler

    async def request(self, payload_type, payload, expected_response_type, timeout=10.0):
        self.sent.append((payload_type, payload))
        if expected_response_type not in self.canned:
            raise AssertionError(f'No canned response for {expected_response_type}')
        return self.canned[expected_response_type]

    async def send_oneway(self, payload_type, payload):
        self.oneway.append((payload_type, payload))


def _client():
    return CTraderClient(
        access_token='at', refresh_token='rt', ctid_trader_account_id=42,
        expires_at=9999999999, account_kind='DEMO', account_id='abc',
    )


async def test_initialize_sends_app_auth_then_account_auth_then_symbols(monkeypatch):
    canned = {
        PAYLOAD['APP_AUTH_RES']: {},
        PAYLOAD['ACCOUNT_AUTH_RES']: {'ctidTraderAccountId': 42},
        PAYLOAD['SYMBOLS_LIST_RES']: {'symbol': [
            {'symbolId': 1, 'symbolName': 'EURUSD', 'digits': 5},
            {'symbolId': 41, 'symbolName': 'XAUUSD', 'digits': 2},
        ]},
    }
    transport = FakeTransport(canned)
    c = _client()
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'cid'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'csec')
    monkeypatch.setattr('ctrader_client.CTraderTransport', lambda *a, **kw: transport)

    await c.initialize()

    types_sent = [t for t, _ in transport.sent]
    assert types_sent == [PAYLOAD['APP_AUTH_REQ'], PAYLOAD['ACCOUNT_AUTH_REQ'], PAYLOAD['SYMBOLS_LIST_REQ']]
    assert c._symbol_id_by_name == {'EURUSD': 1, 'XAUUSD': 41}
    assert c._symbol_digits == {'EURUSD': 5, 'XAUUSD': 2}
    await c.close()


async def test_initialize_uses_live_endpoint_for_live_kind(monkeypatch):
    canned = {
        PAYLOAD['APP_AUTH_RES']: {},
        PAYLOAD['ACCOUNT_AUTH_RES']: {},
        PAYLOAD['SYMBOLS_LIST_RES']: {'symbol': []},
    }
    captured = {}
    def fake_transport(host, port=5036):
        captured['host'] = host
        return FakeTransport(canned)
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'x'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'y')
    monkeypatch.setattr('ctrader_client.CTraderTransport', fake_transport)

    c = _client()
    c.account_kind = 'LIVE'
    await c.initialize()
    assert captured['host'] == 'live.ctraderapi.com'
    await c.close()


async def test_initialize_closes_transport_on_auth_failure(monkeypatch):
    """If auth fails, transport must be closed and self._transport reset to None."""
    class FailingTransport(FakeTransport):
        async def request(self, payload_type, payload, expected_response_type, timeout=10.0):
            self.sent.append((payload_type, payload))
            if payload_type == PAYLOAD['ACCOUNT_AUTH_REQ']:
                from ctrader_protocol import CTraderApiError
                raise CTraderApiError('CH_CLIENT_AUTH_FAILURE', 'bad token')
            return self.canned.get(expected_response_type, {})

    transport = FailingTransport({PAYLOAD['APP_AUTH_RES']: {}})
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'x'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'y')
    monkeypatch.setattr('ctrader_client.CTraderTransport', lambda *a, **kw: transport)

    c = _client()
    with pytest.raises(Exception):
        await c.initialize()
    assert transport.closed is True
    assert c._transport is None
    assert c._heartbeat_task is None


def _initialized_client(monkeypatch, extra_canned=None):
    canned = {
        PAYLOAD['APP_AUTH_RES']: {},
        PAYLOAD['ACCOUNT_AUTH_RES']: {},
        PAYLOAD['SYMBOLS_LIST_RES']: {'symbol': [
            {'symbolId': 1, 'symbolName': 'EURUSD', 'digits': 5},
            {'symbolId': 41, 'symbolName': 'XAUUSD', 'digits': 2},
        ]},
    }
    canned.update(extra_canned or {})
    transport = FakeTransport(canned)
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'x'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'y')
    monkeypatch.setattr('ctrader_client.CTraderTransport', lambda *a, **kw: transport)
    return transport


async def test_place_order_translates_request(monkeypatch):
    from models import OrderRequest
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['EXECUTION_EVENT']: {
            'order': {'orderId': 9876543210, 'positionId': 1234567},
            'executionType': 'ORDER_FILLED',
            'position': {'positionId': 1234567},
        },
    })
    c = _client()
    await c.initialize()
    req = OrderRequest(symbol='EURUSD', side='BUY', lotSize=0.10,
                       entryPrice=1.08300, slPrice=1.08000, tpPrice=1.09000)
    res = await c.place_order(req)
    new_order_call = next(p for t, p in transport.sent if t == PAYLOAD['NEW_ORDER_REQ'])
    assert new_order_call['symbolId'] == 1
    assert new_order_call['orderType'] == 'MARKET'
    assert new_order_call['tradeSide'] == 'BUY'
    assert new_order_call['volume'] == 10
    assert new_order_call['stopLoss'] == 108000
    assert new_order_call['takeProfit'] == 109000
    assert res.mt5_ticket == 1234567
    assert res.status == 'FILLED'
    await c.close()


async def test_close_position_sends_volume_zero(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['EXECUTION_EVENT']: {'executionType': 'ORDER_FILLED', 'position': {'positionId': 555}},
    })
    c = _client()
    await c.initialize()
    res = await c.close_position(555)
    close_call = next(p for t, p in transport.sent if t == PAYLOAD['CLOSE_POSITION_REQ'])
    assert close_call['positionId'] == 555
    assert close_call['volume'] == 0
    assert res['status'] in ('CLOSED', 'OK')
    await c.close()


async def test_modify_position_sends_sl_tp(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['EXECUTION_EVENT']: {'executionType': 'AMENDED', 'position': {'positionId': 555}},
    })
    c = _client()
    await c.initialize()
    c._position_symbol_cache = {555: 'EURUSD'}
    await c.modify_position(555, sl_price=1.07500, tp_price=1.09500)
    amend_call = next(p for t, p in transport.sent if t == PAYLOAD['AMEND_POSITION_SLTP_REQ'])
    assert amend_call['positionId'] == 555
    assert amend_call['stopLoss'] == 107500
    assert amend_call['takeProfit'] == 109500
    await c.close()
