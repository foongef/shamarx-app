import pytest
from ctrader_client import CTraderClient


def _client_with_symbols():
    c = CTraderClient(access_token='', refresh_token='', ctid_trader_account_id=0,
                      expires_at=0, account_kind='DEMO')
    c._symbol_id_by_name = {'EURUSD': 1, 'XAUUSD': 41, 'GBPUSD': 2, 'USDJPY': 3}
    c._symbol_name_by_id = {1: 'EURUSD', 41: 'XAUUSD', 2: 'GBPUSD', 3: 'USDJPY'}
    c._symbol_digits = {'EURUSD': 5, 'XAUUSD': 2, 'GBPUSD': 5, 'USDJPY': 3}
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


def test_to_ctrader_price_rounding():
    c = _client_with_symbols()
    assert c._to_ctrader_price('EURUSD', 1.08345) == 108345
    assert c._to_ctrader_price('XAUUSD', 2050.55) == 205055
    assert c._to_ctrader_price('USDJPY', 149.123) == 149123


def test_from_ctrader_price_round_trip():
    c = _client_with_symbols()
    for sym, price in [('EURUSD', 1.08345), ('XAUUSD', 2050.55), ('USDJPY', 149.123)]:
        scaled = c._to_ctrader_price(sym, price)
        assert c._from_ctrader_price(sym, scaled) == pytest.approx(price)


def test_our_symbol_from_id():
    c = _client_with_symbols()
    assert c._our_symbol_from_id(1) == 'EURUSD'
    assert c._our_symbol_from_id(41) == 'XAUUSD'
