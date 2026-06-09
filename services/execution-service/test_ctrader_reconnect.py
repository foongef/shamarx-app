import asyncio
import time
import pytest
from unittest.mock import AsyncMock
from ctrader_client import CTraderClient
from ctrader_protocol import CTraderApiError


def _client(expires_at=None):
    return CTraderClient(
        access_token='at', refresh_token='rt', ctid_trader_account_id=1,
        expires_at=expires_at if expires_at is not None else int(time.time()) + 3600,
        account_kind='DEMO',
    )


async def test_refresh_token_called_when_near_expiry():
    c = _client(expires_at=int(time.time()) + 30)  # expires in 30s
    refresh_calls = []

    async def fake_refresh():
        refresh_calls.append(1)
        c.access_token = 'new'
        c.refresh_token = 'r2'
        c.expires_at = int(time.time()) + 3600

    c._refresh_token = fake_refresh
    await c._ensure_fresh_token()
    assert len(refresh_calls) == 1
    assert c.access_token == 'new'


async def test_no_refresh_when_token_far_from_expiry():
    c = _client(expires_at=int(time.time()) + 3600)
    refresh_calls = []

    async def fake_refresh():
        refresh_calls.append(1)

    c._refresh_token = fake_refresh
    await c._ensure_fresh_token()
    assert len(refresh_calls) == 0


async def test_no_refresh_when_expires_at_zero():
    """expires_at=0 means we don't track expiry — never proactively refresh."""
    c = _client(expires_at=0)
    refresh_calls = []

    async def fake_refresh():
        refresh_calls.append(1)

    c._refresh_token = fake_refresh
    await c._ensure_fresh_token()
    assert len(refresh_calls) == 0


async def test_refresh_token_persists_via_callback(monkeypatch):
    persisted = []

    async def on_refresh(tokens):
        persisted.append(tokens)

    c = CTraderClient(access_token='a', refresh_token='r1', ctid_trader_account_id=1,
                      expires_at=0, account_kind='DEMO', on_token_refresh=on_refresh)

    class FakeResp:
        status_code = 200

        def json(self):
            return {'accessToken': 'new', 'refreshToken': 'r2', 'expiresIn': 3600}

        def raise_for_status(self):
            pass

    async def fake_post(url, data=None):
        return FakeResp()

    monkeypatch.setenv('CTRADER_CLIENT_ID', 'cid')
    monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'csec')
    monkeypatch.setenv('CTRADER_TOKEN_URL', 'https://x/token')
    monkeypatch.setattr('ctrader_client._async_post_form', fake_post)

    await c._refresh_token()
    assert c.access_token == 'new'
    assert c.refresh_token == 'r2'
    assert len(persisted) == 1
    assert persisted[0]['accessToken'] == 'new'
    assert persisted[0]['refreshToken'] == 'r2'


async def test_with_reconnect_retries_once_on_auth_failure():
    c = _client()
    refreshed = []

    async def fake_refresh():
        refreshed.append(1)

    c._refresh_token = fake_refresh
    c._reconnect = AsyncMock()

    attempts = [0]

    async def op():
        attempts[0] += 1
        if attempts[0] == 1:
            raise CTraderApiError('CH_CLIENT_AUTH_FAILURE', 'token expired')
        return 'ok'

    result = await c._with_reconnect('test', op)
    assert result == 'ok'
    assert attempts[0] == 2
    assert len(refreshed) == 1


async def test_with_reconnect_propagates_non_auth_api_error():
    c = _client()
    c._reconnect = AsyncMock()

    async def op():
        raise CTraderApiError('SYMBOL_NOT_FOUND', 'BAD')

    with pytest.raises(CTraderApiError) as exc:
        await c._with_reconnect('test', op)
    assert exc.value.code == 'SYMBOL_NOT_FOUND'
    c._reconnect.assert_not_called()
