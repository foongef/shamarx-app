"""
Tests for the circuit-breaker + backoff added to MetaApiMT5.initialize().

The motivation is the 429-spiral observed in prod: MetaApi rate-limits our
reconnect attempts, our app keeps retrying instantly, MetaApi keeps refusing,
loop forever until a manual container restart. The breaker breaks the loop.
"""
import os
import asyncio
import pytest

os.environ.setdefault("METAAPI_ACCESS_TOKEN", "test-token")
os.environ.setdefault("METAAPI_ACCOUNT_ID_DEMO", "test-account-id")

from metaapi_mt5 import MetaApiMT5


def _make_instance():
    """Construct an instance with thresholds tightened for fast tests."""
    inst = MetaApiMT5()
    # Lower the breaker thresholds + sleep windows so tests stay fast.
    inst.CB_THRESHOLD = 2  # type: ignore[misc]
    inst.CB_BASE_SLEEP_S = 0.2  # type: ignore[misc]
    inst.CB_MAX_SLEEP_S = 1.0  # type: ignore[misc]
    inst.MIN_FORCED_REINIT_INTERVAL_S = 0.0  # disable throttle for breaker tests
    return inst


async def _fail_once(inst, monkeypatch, exc_factory):
    """Force one init call to fail with the given exception."""
    async def boom():
        raise exc_factory()
    monkeypatch.setattr(inst, "initialize", boom.__get__(inst, MetaApiMT5))


async def test_circuit_breaker_opens_after_threshold_failures(monkeypatch):
    """After CB_THRESHOLD consecutive failures, the breaker is open and
    further initialize() calls raise immediately without hitting MetaApi."""
    inst = _make_instance()
    call_count = 0

    async def fake_metaapi_init():
        nonlocal call_count
        call_count += 1
        raise RuntimeError("simulated MetaApi 429")

    # Replace the inner work — we'll force exceptions inside the lock.
    # Patch get_account so the real `MetaApi(token)` path throws.
    class _FakeApi:
        @property
        def metatrader_account_api(self):
            return self
        async def get_account(self, account_id):
            await fake_metaapi_init()

    monkeypatch.setattr("metaapi_mt5.MetaApi", lambda token: _FakeApi())

    # First failure
    with pytest.raises(RuntimeError, match="simulated MetaApi 429"):
        await inst.initialize()
    assert inst._consecutive_failures == 1
    assert inst._circuit_breaker_until is None  # below threshold

    # Second failure crosses threshold → breaker opens, SDK torn down.
    with pytest.raises(RuntimeError, match="simulated MetaApi 429"):
        await inst.initialize()
    assert inst._consecutive_failures == 2
    assert inst._circuit_breaker_until is not None
    assert inst._api is None  # SDK destroyed to halt internal reconnects

    # Third call hits the open breaker → no MetaApi call, fast-fail.
    metaapi_calls_before = call_count
    with pytest.raises(RuntimeError, match="circuit breaker open"):
        await inst.initialize()
    assert call_count == metaapi_calls_before  # MetaApi NOT called


async def test_breaker_closes_after_cooldown(monkeypatch):
    """Once the cooldown window elapses, initialize() is allowed again."""
    inst = _make_instance()

    async def fake_init():
        raise RuntimeError("simulated 429")

    class _FakeApi:
        @property
        def metatrader_account_api(self):
            return self
        async def get_account(self, _id):
            await fake_init()

    monkeypatch.setattr("metaapi_mt5.MetaApi", lambda token: _FakeApi())

    # Trip the breaker (2 failures with CB_THRESHOLD=2).
    for _ in range(2):
        with pytest.raises(RuntimeError):
            await inst.initialize()
    assert inst._circuit_breaker_until is not None

    # Wait out the cooldown window (CB_BASE_SLEEP_S = 0.2s).
    await asyncio.sleep(0.3)

    # Breaker should now be closed → next call attempts MetaApi again
    # (and fails with the simulated error, NOT the breaker-open error).
    with pytest.raises(RuntimeError, match="simulated 429"):
        await inst.initialize()


async def test_successful_init_resets_failure_counter(monkeypatch):
    """One success after a failure clears the counter."""
    inst = _make_instance()

    state = {"should_fail": True}

    class _FakeAccount:
        state_attr = "DEPLOYED"

        @property
        def state(self):
            return self.state_attr

        def get_rpc_connection(self):
            class _Conn:
                async def connect(self): pass
                async def wait_synchronized(self): pass
                async def get_symbols(self): return ["EURUSD.s", "XAUUSD.x"]
            return _Conn()

    class _FakeApi:
        @property
        def metatrader_account_api(self):
            return self
        async def get_account(self, _id):
            if state["should_fail"]:
                raise RuntimeError("simulated 429")
            return _FakeAccount()

    monkeypatch.setattr("metaapi_mt5.MetaApi", lambda token: _FakeApi())

    # First call fails.
    with pytest.raises(RuntimeError):
        await inst.initialize()
    assert inst._consecutive_failures == 1

    # Flip the switch; next call succeeds.
    state["should_fail"] = False
    await inst.initialize()
    assert inst._consecutive_failures == 0
    assert inst._circuit_breaker_until is None
    assert inst._initialized is True


async def test_forced_reinit_throttle(monkeypatch):
    """Two force=True calls in rapid succession get throttled."""
    inst = _make_instance()
    inst.MIN_FORCED_REINIT_INTERVAL_S = 0.3  # type: ignore[misc]
    inst._initialized = True  # bypass first-init path so we exercise force-only

    # Make initialize() return cleanly once the lock is acquired (no MetaApi call).
    # We test ONLY that the throttle sleep ran between successive force calls.
    class _FakeAccount:
        @property
        def state(self): return "DEPLOYED"
        def get_rpc_connection(self):
            class _Conn:
                async def connect(self): pass
                async def wait_synchronized(self): pass
                async def get_symbols(self): return []
            return _Conn()

    class _FakeApi:
        @property
        def metatrader_account_api(self):
            return self
        async def get_account(self, _id):
            return _FakeAccount()

    monkeypatch.setattr("metaapi_mt5.MetaApi", lambda token: _FakeApi())

    loop = asyncio.get_event_loop()
    t0 = loop.time()
    await inst.initialize(force=True)
    await inst.initialize(force=True)
    elapsed = loop.time() - t0
    # Second forced call should have been delayed by the throttle window.
    assert elapsed >= 0.25, f"expected ≥0.25s throttle, got {elapsed:.3f}s"
