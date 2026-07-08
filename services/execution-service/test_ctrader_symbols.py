import pytest
from ctrader_client import CTraderClient


def _client_with_symbols():
    c = CTraderClient(access_token='', refresh_token='', ctid_trader_account_id=0,
                      expires_at=0, account_kind='DEMO')
    c._symbol_id_by_name = {'EURUSD': 1, 'XAUUSD': 41, 'GBPUSD': 2, 'USDJPY': 3}
    c._symbol_name_by_id = {1: 'EURUSD', 41: 'XAUUSD', 2: 'GBPUSD', 3: 'USDJPY'}
    c._symbol_details = {
        1: {'symbolId': 1, 'digits': 5, 'lotSize': 10_000_000, 'minVolume': 100_000, 'stepVolume': 100_000},
        41: {'symbolId': 41, 'digits': 2, 'lotSize': 10_000, 'minVolume': 100, 'stepVolume': 100},
        3: {'symbolId': 3, 'digits': 3, 'lotSize': 10_000_000},
    }
    return c


def test_to_ctrader_symbol_exact_match():
    c = _client_with_symbols()
    assert c._to_ctrader_symbol('EURUSD') == 1
    assert c._to_ctrader_symbol('XAUUSD') == 41


def test_to_ctrader_symbol_alias_resolution():
    c = _client_with_symbols()
    c._symbol_id_by_name['GOLD'] = 41
    c._symbol_id_by_name.pop('XAUUSD')
    assert c._to_ctrader_symbol('XAUUSD') == 41  # via alias GOLD


def test_to_ctrader_symbol_unknown_raises():
    c = _client_with_symbols()
    with pytest.raises(ValueError) as exc:
        c._to_ctrader_symbol('NZDCHF')
    assert 'NZDCHF' in str(exc.value)


def test_lots_to_volume_uses_symbol_lot_size():
    c = _client_with_symbols()
    # FX: 1 lot = 100_000 units = 10_000_000 cents of units
    assert c._lots_to_volume(1, 0.01) == 100_000
    assert c._lots_to_volume(1, 0.10) == 1_000_000
    # XAUUSD: 1 lot = 100 oz = 10_000 cents of units
    assert c._lots_to_volume(41, 0.05) == 500
    assert c._lots_to_volume(41, 1.0) == 10_000


def test_lots_to_volume_clamps_to_min_and_step():
    c = _client_with_symbols()
    # Below minVolume → clamped up
    assert c._lots_to_volume(1, 0.001) == 100_000
    # Snapped to stepVolume
    assert c._lots_to_volume(1, 0.0149) == 100_000
    assert c._lots_to_volume(1, 0.015) == 200_000


def test_lots_to_volume_defaults_when_details_missing():
    c = _client_with_symbols()
    # symbolId 2 (GBPUSD) has no details row → FX default lotSize applies
    assert c._lots_to_volume(2, 0.01) == 100_000


def test_volume_to_lots_round_trip():
    c = _client_with_symbols()
    for sid, lots in [(1, 0.01), (1, 0.5), (41, 0.05), (41, 2.0)]:
        assert c._volume_to_lots(sid, c._lots_to_volume(sid, lots)) == pytest.approx(lots)


def test_our_symbol_from_id():
    c = _client_with_symbols()
    assert c._our_symbol_from_id(1) == 'EURUSD'
    assert c._our_symbol_from_id(41) == 'XAUUSD'


def test_lots_to_volume_clamps_to_max():
    c = _client_with_symbols()
    c._symbol_details[1]['maxVolume'] = 5_000_000  # 0.5 lot cap
    assert c._lots_to_volume(1, 10.0) == 5_000_000


def _limit_request(**over):
    from models import OrderRequest
    base = dict(
        symbol='GBPUSD', side='BUY', lotSize=0.1, entryPrice=1.3000,
        slPrice=1.2990, tpPrice=1.3040, orderType='LIMIT',
        limitPrice=1.2995, expirationMs=1783000000000,
    )
    base.update(over)
    return OrderRequest(**base)


def test_limit_order_request_parses_and_defaults():
    from models import OrderRequest
    req = _limit_request()
    assert req.order_type == 'LIMIT'
    assert req.limit_price == 1.2995
    assert req.expiration_ms == 1783000000000
    # market default untouched
    m = OrderRequest(symbol='GBPUSD', side='BUY', lotSize=0.1,
                     entryPrice=1.3, slPrice=1.299, tpPrice=1.301)
    assert m.order_type == 'MARKET'
    assert m.limit_price is None


class _FakeTransport:
    """Captures request_until payloads; replies with a scripted envelope."""
    def __init__(self, reply):
        self.reply = reply
        self.sent = None

    async def request_until(self, payload_type, payload, done, timeout=None):
        self.sent = (payload_type, payload)
        return [self.reply]

    async def request(self, *a, **k):
        raise AssertionError('unexpected request()')


def test_limit_order_sends_absolute_sltp_and_gtd(monkeypatch):
    import asyncio
    c = _client_with_symbols()
    c.ctid_trader_account_id = 777
    c._transport = _FakeTransport({'payload': {
        'executionType': 2,  # ACCEPTED
        'order': {'orderId': 424242},
    }})
    res = asyncio.get_event_loop().run_until_complete(
        c._place_order_impl(_limit_request())
    )
    ptype, sent = c._transport.sent
    assert sent['orderType'] == 'LIMIT'
    assert sent['limitPrice'] == 1.2995
    assert sent['timeInForce'] == 'GOOD_TILL_DATE'
    assert sent['expirationTimestamp'] == 1783000000000
    assert sent['stopLoss'] == 1.2990      # ABSOLUTE — allowed on LIMIT
    assert sent['takeProfit'] == 1.3040
    assert 'relativeStopLoss' not in sent  # the MARKET-only mechanism
    assert res.status == 'PENDING'
    assert res.order_id == '424242'
    assert res.mt5_ticket is None


def test_limit_order_instant_fill_falls_through(monkeypatch):
    import asyncio
    c = _client_with_symbols()
    c.ctid_trader_account_id = 777
    c._transport = _FakeTransport({'payload': {
        'executionType': 3,  # FILLED immediately (price already through)
        'order': {'orderId': 5},
        'deal': {'positionId': 999, 'executionPrice': 1.2995},
        'position': {'positionId': 999, 'tradeData': {'volume': 1_000_000}},
    }})
    res = asyncio.get_event_loop().run_until_complete(
        c._place_order_impl(_limit_request())
    )
    assert res.status == 'FILLED'
    assert res.mt5_ticket == 999
