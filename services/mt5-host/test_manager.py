"""Manager logic tests — registry, capacity math. MT5 + subprocess layers
are untouched by these tests so they run on any OS."""
import pytest

from manager import TerminalRegistry, capacity_verdict


def test_registry_provision_assigns_unique_ports():
    r = TerminalRegistry(base_port=9000, max_terminals=4)
    a = r.allocate('acct-a')
    b = r.allocate('acct-b')
    assert a != b
    assert r.port_for('acct-a') == a


def test_registry_rejects_beyond_capacity():
    r = TerminalRegistry(base_port=9000, max_terminals=2)
    r.allocate('a')
    r.allocate('b')
    with pytest.raises(RuntimeError, match='fleet full'):
        r.allocate('c')


def test_registry_allocate_is_idempotent_per_account():
    r = TerminalRegistry(base_port=9000, max_terminals=2)
    assert r.allocate('a') == r.allocate('a')
    assert len(r.slots) == 1


def test_registry_release_frees_slot():
    r = TerminalRegistry(base_port=9000, max_terminals=1)
    r.allocate('a')
    r.release('a')
    r.allocate('b')  # must not raise


def test_registry_persistence_roundtrip(tmp_path):
    f = tmp_path / 'state.json'
    r = TerminalRegistry(base_port=9000, max_terminals=4)
    r.allocate('acct-a')
    r.save(f)
    r2 = TerminalRegistry.load(f)
    assert r2.port_for('acct-a') == r.port_for('acct-a')


def test_capacity_verdict_ok():
    v = capacity_verdict(running=1, max_terminals=4, free_mb=1400, avg_rss_mb=400,
                         load15=0.2, vcpus=2, free_gb=30)
    assert v['verdict'] == 'OK'
    assert v['headroom']['additionalAccounts'] >= 1


def test_capacity_verdict_near_capacity_on_slots():
    v = capacity_verdict(running=3, max_terminals=4, free_mb=2000, avg_rss_mb=400,
                         load15=0.2, vcpus=2, free_gb=30)
    assert v['verdict'] == 'NEAR_CAPACITY'


def test_capacity_verdict_scale_up_when_full_or_starved():
    assert capacity_verdict(4, 4, 2000, 400, 0.2, 2, 30)['verdict'] == 'SCALE_UP'
    assert capacity_verdict(1, 4, 300, 400, 0.2, 2, 30)['verdict'] == 'SCALE_UP'   # RAM starved
    assert capacity_verdict(1, 4, 2000, 400, 1.8, 2, 30)['verdict'] == 'SCALE_UP'  # CPU pinned
    assert capacity_verdict(1, 4, 2000, 400, 0.2, 2, 3)['verdict'] == 'SCALE_UP'   # disk < 5GB


# ── worker bridge-protocol helpers ───────────────────────────────────────────
from worker import position_row_to_dict, timeframe_check


def test_position_row_translation():
    d = position_row_to_dict('111,EURUSD,BUY,0.10,1.08500,1.08600,1.08000,1.09000,10.00,1717000000')
    assert d == {'ticket': 111, 'symbol': 'EURUSD', 'side': 'BUY', 'lotSize': 0.10,
                 'entryPrice': 1.085, 'currentPrice': 1.086, 'sl': 1.08, 'tp': 1.09,
                 'pnl': 10.0, 'openTime': '1717000000'}


def test_timeframe_check():
    assert timeframe_check('M15') == 'M15'
    assert timeframe_check('D1') == 'D1'
    import pytest as _pytest
    with _pytest.raises(ValueError):
        timeframe_check('M5')
