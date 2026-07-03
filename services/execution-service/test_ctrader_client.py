"""CTraderClient unit tests. Canned responses mirror REAL frames captured from
the live Spotware demo API (2026-07-03 probe): tradeSide/executionType are
ints, position/order/deal prices are absolute doubles, trendbars are
low+delta ints at 1/100_000 scale, and volumes are in cents-of-units."""
import asyncio
import pytest
from ctrader_client import CTraderClient
from ctrader_protocol import PAYLOAD, CTraderApiError

# Real-shape symbol detail rows (SYMBOL_BY_ID_RES): FX lot = 10_000_000 cents
# of units; XAUUSD lot = 100 oz = 10_000 cents of units.
EURUSD_DETAILS = {'symbolId': 1, 'digits': 5, 'lotSize': 10_000_000, 'minVolume': 100_000, 'stepVolume': 100_000}
XAUUSD_DETAILS = {'symbolId': 41, 'digits': 2, 'lotSize': 10_000, 'minVolume': 100, 'stepVolume': 100}


class FakeTransport:
    """Records sent messages, returns canned responses keyed by expected
    response type (request) or by request payload type (request_until)."""

    def __init__(self, canned: dict[int, dict] | None = None, event_flows: dict[int, list] | None = None):
        self.canned = canned or {}
        # request payload type → list of envelopes to emit for request_until
        self.event_flows = event_flows or {}
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

    async def request_until(self, payload_type, payload, done, timeout=15.0):
        self.sent.append((payload_type, payload))
        flow = self.event_flows.get(payload_type)
        if flow is None:
            raise AssertionError(f'No canned event flow for {payload_type}')
        collected = []
        for env in flow:
            if isinstance(env, Exception):
                raise env
            collected.append(env)
            if done(env):
                return collected
        raise CTraderApiError('TIMEOUT', 'no terminal frame in canned flow')

    async def send_oneway(self, payload_type, payload):
        self.oneway.append((payload_type, payload))


def _client():
    return CTraderClient(
        access_token='at', refresh_token='rt', ctid_trader_account_id=42,
        expires_at=9999999999, account_kind='DEMO', account_id='abc',
    )


BASE_CANNED = {
    PAYLOAD['APP_AUTH_RES']: {},  # real 2101 has NO payload at all
    PAYLOAD['ACCOUNT_AUTH_RES']: {'ctidTraderAccountId': 42},
    PAYLOAD['SYMBOLS_LIST_RES']: {'symbol': [
        # Light list: NO digits/lotSize (verified live) — just id + name.
        {'symbolId': 1, 'symbolName': 'EURUSD', 'enabled': True},
        {'symbolId': 41, 'symbolName': 'XAUUSD', 'enabled': True},
    ]},
    PAYLOAD['SYMBOL_BY_ID_RES']: {'symbol': [EURUSD_DETAILS, XAUUSD_DETAILS]},
}


def _initialized_client(monkeypatch, extra_canned=None, event_flows=None):
    canned = dict(BASE_CANNED)
    canned.update(extra_canned or {})
    transport = FakeTransport(canned, event_flows)
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'x'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'y')
    monkeypatch.setattr('ctrader_client.CTraderTransport', lambda *a, **kw: transport)
    return transport


async def test_initialize_sends_auth_symbols_then_details(monkeypatch):
    transport = _initialized_client(monkeypatch)
    c = _client()
    await c.initialize()
    types_sent = [t for t, _ in transport.sent]
    assert types_sent == [
        PAYLOAD['APP_AUTH_REQ'], PAYLOAD['ACCOUNT_AUTH_REQ'],
        PAYLOAD['SYMBOLS_LIST_REQ'], PAYLOAD['SYMBOL_BY_ID_REQ'],
    ]
    assert c._symbol_id_by_name == {'EURUSD': 1, 'XAUUSD': 41}
    assert c._symbol_details[1]['lotSize'] == 10_000_000
    assert c._symbol_details[41]['lotSize'] == 10_000
    await c.close()


async def test_initialize_uses_live_endpoint_for_live_kind(monkeypatch):
    captured = {}
    def fake_transport(host, port=5036):
        captured['host'] = host
        return FakeTransport(dict(BASE_CANNED))
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'x'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'y')
    monkeypatch.setattr('ctrader_client.CTraderTransport', fake_transport)
    c = _client()
    c.account_kind = 'LIVE'
    await c.initialize()
    assert captured['host'] == 'live.ctraderapi.com'
    await c.close()


async def test_initialize_closes_transport_on_auth_failure(monkeypatch):
    class FailingTransport(FakeTransport):
        async def request(self, payload_type, payload, expected_response_type, timeout=10.0):
            self.sent.append((payload_type, payload))
            if payload_type == PAYLOAD['ACCOUNT_AUTH_REQ']:
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


# Real ORDER_ACCEPTED → ORDER_FILLED flow (trimmed from live capture).
def _order_flow(position_id=649155875, fill_price=1.14463, volume=100000):
    return [
        {'payloadType': 2126, 'payload': {
            'executionType': 2,  # ORDER_ACCEPTED
            'position': {'positionId': position_id, 'tradeData': {'symbolId': 1, 'volume': 0, 'tradeSide': 1}, 'price': 0.0},
            'order': {'orderId': 990178770, 'orderStatus': 1, 'positionId': position_id},
        }},
        {'payloadType': 2126, 'payload': {
            'executionType': 3,  # ORDER_FILLED
            'position': {'positionId': position_id,
                         'tradeData': {'symbolId': 1, 'volume': volume, 'tradeSide': 1},
                         'price': fill_price, 'moneyDigits': 2},
            'order': {'orderId': 990178770, 'orderStatus': 2, 'executionPrice': fill_price, 'positionId': position_id},
            'deal': {'dealId': 916431992, 'positionId': position_id, 'volume': volume,
                     'executionPrice': fill_price, 'tradeSide': 1, 'moneyDigits': 2},
        }},
    ]


def _amend_flow():
    return [{'payloadType': 2126, 'payload': {'executionType': 4}}]  # ORDER_REPLACED


async def test_place_order_real_semantics(monkeypatch):
    from models import OrderRequest
    transport = _initialized_client(monkeypatch, event_flows={
        PAYLOAD['NEW_ORDER_REQ']: _order_flow(volume=1_000_000),
        PAYLOAD['AMEND_POSITION_SLTP_REQ']: _amend_flow(),
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
    # 0.10 lots × lotSize 10_000_000 = 1_000_000 cents of units
    assert new_order_call['volume'] == 1_000_000
    # MARKET orders take RELATIVE SL/TP at 1/100_000 scale, no absolute prices
    assert 'stopLoss' not in new_order_call and 'takeProfit' not in new_order_call
    assert new_order_call['relativeStopLoss'] == 300   # |1.08300-1.08000|×1e5
    assert new_order_call['relativeTakeProfit'] == 700  # |1.09000-1.08300|×1e5

    # Post-fill amend pins the exact absolute strategy levels
    amend_call = next(p for t, p in transport.sent if t == PAYLOAD['AMEND_POSITION_SLTP_REQ'])
    assert amend_call['positionId'] == 649155875
    assert amend_call['stopLoss'] == pytest.approx(1.08000)
    assert amend_call['takeProfit'] == pytest.approx(1.09000)

    assert res.mt5_ticket == 649155875
    assert res.status == 'FILLED'
    await c.close()


async def test_place_order_xauusd_volume_uses_symbol_lot_size(monkeypatch):
    from models import OrderRequest
    flow = _order_flow()
    flow[1]['payload']['position']['tradeData']['symbolId'] = 41
    flow[1]['payload']['deal']['symbolId'] = 41
    transport = _initialized_client(monkeypatch, event_flows={
        PAYLOAD['NEW_ORDER_REQ']: flow,
        PAYLOAD['AMEND_POSITION_SLTP_REQ']: _amend_flow(),
    })
    c = _client()
    await c.initialize()
    req = OrderRequest(symbol='XAUUSD', side='SELL', lotSize=0.05,
                       entryPrice=2050.00, slPrice=2060.00, tpPrice=2030.00)
    await c.place_order(req)
    call = next(p for t, p in transport.sent if t == PAYLOAD['NEW_ORDER_REQ'])
    # 0.05 lots × lotSize 10_000 = 500 cents of units — NOT the FX conversion
    assert call['volume'] == 500
    await c.close()


async def test_place_order_rejected_via_order_error_event(monkeypatch):
    from models import OrderRequest
    transport = _initialized_client(monkeypatch, event_flows={
        PAYLOAD['NEW_ORDER_REQ']: [
            CTraderApiError('INVALID_REQUEST', 'SL/TP in absolute values are allowed only for ...'),
        ],
    })
    c = _client()
    await c.initialize()
    req = OrderRequest(symbol='EURUSD', side='BUY', lotSize=0.01,
                       entryPrice=1.1, slPrice=1.09, tpPrice=1.11)
    res = await c.place_order(req)
    assert res.status == 'REJECTED'
    assert 'INVALID_REQUEST' in res.message
    await c.close()


async def test_place_order_survives_amend_failure(monkeypatch):
    """If the post-fill absolute amend fails, the order is still FILLED —
    the relative protection from the order itself stays active."""
    from models import OrderRequest
    transport = _initialized_client(monkeypatch, event_flows={
        PAYLOAD['NEW_ORDER_REQ']: _order_flow(),
        PAYLOAD['AMEND_POSITION_SLTP_REQ']: [CTraderApiError('TIMEOUT', 'no frame')],
    })
    c = _client()
    await c.initialize()
    req = OrderRequest(symbol='EURUSD', side='BUY', lotSize=0.01,
                       entryPrice=1.14463, slPrice=1.13463, tpPrice=1.15463)
    res = await c.place_order(req)
    assert res.status == 'FILLED'
    assert res.mt5_ticket == 649155875
    await c.close()


async def test_close_position_sends_cached_volume(monkeypatch):
    transport = _initialized_client(monkeypatch, event_flows={
        PAYLOAD['CLOSE_POSITION_REQ']: [
            {'payloadType': 2126, 'payload': {'executionType': 2}},
            {'payloadType': 2126, 'payload': {
                'executionType': 3,
                'deal': {'executionPrice': 1.14464, 'moneyDigits': 2,
                         'closePositionDetail': {'grossProfit': 1, 'commission': -6, 'swap': 0}},
            }},
        ],
    })
    c = _client()
    await c.initialize()
    c._position_volume_cache[555] = 100000
    res = await c.close_position(555)
    close_call = next(p for t, p in transport.sent if t == PAYLOAD['CLOSE_POSITION_REQ'])
    assert close_call['positionId'] == 555
    assert close_call['volume'] == 100000  # real volume — 0 is rejected by the API
    assert res['status'] == 'CLOSED'
    assert res['closePrice'] == pytest.approx(1.14464)
    assert res['pnl'] == pytest.approx(0.01)
    await c.close()


async def test_close_position_reconciles_when_volume_unknown(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['RECONCILE_RES']: {'position': [
            {'positionId': 777, 'tradeData': {'symbolId': 1, 'tradeSide': 2, 'volume': 200000, 'openTimestamp': 1},
             'price': 1.1, 'stopLoss': 1.11, 'takeProfit': 1.09},
        ]},
    }, event_flows={
        PAYLOAD['CLOSE_POSITION_REQ']: [{'payloadType': 2126, 'payload': {'executionType': 3, 'deal': {}}}],
    })
    c = _client()
    await c.initialize()
    await c.close_position(777)
    close_call = next(p for t, p in transport.sent if t == PAYLOAD['CLOSE_POSITION_REQ'])
    assert close_call['volume'] == 200000
    await c.close()


async def test_modify_position_sends_absolute_doubles(monkeypatch):
    transport = _initialized_client(monkeypatch, event_flows={
        PAYLOAD['AMEND_POSITION_SLTP_REQ']: _amend_flow(),
    })
    c = _client()
    await c.initialize()
    await c.modify_position(555, sl_price=1.07500, tp_price=1.09500)
    amend_call = next(p for t, p in transport.sent if t == PAYLOAD['AMEND_POSITION_SLTP_REQ'])
    assert amend_call['positionId'] == 555
    assert amend_call['stopLoss'] == pytest.approx(1.07500)   # absolute double, NOT ×10^digits
    assert amend_call['takeProfit'] == pytest.approx(1.09500)
    await c.close()


async def test_get_positions_translates_real_response(monkeypatch):
    # Trimmed real RECONCILE_RES from the live capture
    _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['RECONCILE_RES']: {'ctidTraderAccountId': 42, 'position': [
            {'positionId': 649155875,
             'tradeData': {'symbolId': 1, 'volume': 100000, 'tradeSide': 1, 'openTimestamp': 1783075061310},
             'positionStatus': 1, 'price': 1.14463, 'stopLoss': 1.13463, 'takeProfit': 1.15463,
             'usedMargin': 572, 'moneyDigits': 2},
        ]},
    })
    c = _client()
    await c.initialize()
    positions = await c.get_positions()
    assert len(positions) == 1
    p = positions[0]
    assert p['ticket'] == 649155875
    assert p['symbol'] == 'EURUSD'
    assert p['side'] == 'BUY'                      # tradeSide 1 → BUY
    assert p['lotSize'] == pytest.approx(0.01)     # 100000 / 10_000_000
    assert p['entryPrice'] == pytest.approx(1.14463)  # already a double
    assert p['sl'] == pytest.approx(1.13463)
    assert p['tp'] == pytest.approx(1.15463)
    await c.close()


async def test_get_positions_filters_by_symbol(monkeypatch):
    _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['RECONCILE_RES']: {'position': [
            {'positionId': 100, 'tradeData': {'symbolId': 1, 'tradeSide': 1, 'volume': 100000, 'openTimestamp': 0},
             'price': 1.08, 'stopLoss': 0, 'takeProfit': 0},
            {'positionId': 101, 'tradeData': {'symbolId': 41, 'tradeSide': 2, 'volume': 100, 'openTimestamp': 0},
             'price': 2050.0, 'stopLoss': 0, 'takeProfit': 0},
        ]},
    })
    c = _client()
    await c.initialize()
    eur = await c.get_positions('EURUSD')
    xau = await c.get_positions('XAUUSD')
    assert [p['ticket'] for p in eur] == [100]
    assert [p['ticket'] for p in xau] == [101]
    assert xau[0]['side'] == 'SELL'
    assert xau[0]['lotSize'] == pytest.approx(0.01)  # 100 / 10_000
    await c.close()


async def test_get_account_info_translates(monkeypatch):
    _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['TRADER_RES']: {
            'trader': {'balance': 1000000, 'depositAssetId': 1, 'moneyDigits': 2},
        },
        PAYLOAD['RECONCILE_RES']: {'position': []},
    })
    c = _client()
    await c.initialize()
    info = await c.get_account_info()
    assert info.balance == pytest.approx(10000.0)
    assert info.open_positions == 0
    await c.close()


async def test_get_position_close_info_returns_close_detail(monkeypatch):
    # Real deal shape: executionPrice is a double on the DEAL; monetary values
    # scale by moneyDigits.
    _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['DEAL_LIST_RES']: {'deal': [
            {'positionId': 100, 'symbolId': 1, 'executionTimestamp': 1783075077340,
             'executionPrice': 1.14464, 'commission': -3, 'moneyDigits': 2,
             'closePositionDetail': {'grossProfit': 250, 'commission': -6, 'swap': 0,
                                     'closedVolume': 100000, 'moneyDigits': 2}},
        ]},
    })
    c = _client()
    await c.initialize()
    info = await c.get_position_close_info(100)
    assert info is not None
    assert info['ticket'] == 100
    assert info['closePrice'] == pytest.approx(1.14464)
    assert info['pnl'] == pytest.approx(2.50)
    assert info['commission'] == pytest.approx(-0.06)
    await c.close()


async def test_get_position_close_info_returns_none_when_no_match(monkeypatch):
    _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['DEAL_LIST_RES']: {'deal': []},
    })
    c = _client()
    await c.initialize()
    info = await c.get_position_close_info(999)
    assert info is None
    await c.close()


async def test_get_candles_decodes_trendbars(monkeypatch):
    # Real trendbar shape from the live capture: low + deltas at 1e5 scale,
    # openTime in utcTimestampInMinutes.
    _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['GET_TRENDBARS_RES']: {'period': 7, 'trendbar': [
            {'volume': 437, 'low': 114417, 'deltaOpen': 6, 'deltaClose': 32, 'deltaHigh': 37,
             'utcTimestampInMinutes': 29717550},
            {'volume': 373, 'low': 114440, 'deltaOpen': 8, 'deltaClose': 21, 'deltaHigh': 22,
             'utcTimestampInMinutes': 29717565},
        ]},
    })
    c = _client()
    await c.initialize()
    candles = await c.get_candles('EURUSD', 'M15', 10)
    assert len(candles) == 2
    first = candles[0]
    assert first.open == pytest.approx(1.14423)
    assert first.high == pytest.approx(1.14454)
    assert first.low == pytest.approx(1.14417)
    assert first.close == pytest.approx(1.14449)
    assert first.open_time == '2026-07-03T04:30:00.000Z'  # 29717550 min × 60_000 ms
    assert first.timeframe == 'M15'
    assert first.symbol == 'EURUSD'
    await c.close()


async def test_get_candles_rejects_unknown_timeframe(monkeypatch):
    _initialized_client(monkeypatch)
    c = _client()
    await c.initialize()
    with pytest.raises(ValueError):
        await c.get_candles('EURUSD', 'M7', 10)
    await c.close()
