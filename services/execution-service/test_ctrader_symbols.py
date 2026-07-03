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
