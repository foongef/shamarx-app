"""CTraderTransport tests against REAL wire shapes captured from the live
Spotware demo API (2026-07-03): payload-less responses, the three error frame
types (50 / 2132 / 2142), and multi-frame order flows correlated by
clientMsgId."""
import asyncio
import json
import pytest
from ctrader_protocol import CTraderTransport, CTraderApiError, PAYLOAD


class FakeWS:
    """Async-iterable fake WebSocket. Frames fed via feed() reach the
    transport's reader loop exactly like real incoming messages."""

    def __init__(self):
        self.sent = []
        self._q: asyncio.Queue = asyncio.Queue()
        self.closed = False

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    def feed(self, env: dict):
        self._q.put_nowait(json.dumps(env))

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._q.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def close(self):
        self.closed = True
        self._q.put_nowait(None)


async def _transport():
    t = CTraderTransport('demo.example')
    t._ws = FakeWS()
    t._reader_task = asyncio.create_task(t._reader_loop())
    return t


async def test_request_tolerates_missing_payload_key():
    """APP_AUTH_RES (2101) arrives with NO payload key — verified live.
    request() must return {} instead of raising KeyError."""
    t = await _transport()
    t._ws.feed({'payloadType': PAYLOAD['APP_AUTH_RES'], 'clientMsgId': 'm1'})
    res = await t.request(PAYLOAD['APP_AUTH_REQ'], {'clientId': 'x'}, PAYLOAD['APP_AUTH_RES'])
    assert res == {}
    await t.close()


async def test_request_returns_payload_when_present():
    t = await _transport()
    t._ws.feed({'payloadType': PAYLOAD['ACCOUNT_AUTH_RES'], 'clientMsgId': 'm1',
                'payload': {'ctidTraderAccountId': 47561867}})
    res = await t.request(PAYLOAD['ACCOUNT_AUTH_REQ'], {}, PAYLOAD['ACCOUNT_AUTH_RES'])
    assert res == {'ctidTraderAccountId': 47561867}
    await t.close()


@pytest.mark.parametrize('error_pt', [50, 2132, 2142])
async def test_request_raises_on_all_error_frame_types(error_pt):
    t = await _transport()
    t._ws.feed({'payloadType': error_pt, 'clientMsgId': 'm1',
                'payload': {'errorCode': 'INVALID_REQUEST', 'description': 'nope'}})
    with pytest.raises(CTraderApiError) as exc:
        await t.request(PAYLOAD['NEW_ORDER_REQ'], {}, PAYLOAD['EXECUTION_EVENT'])
    assert exc.value.code == 'INVALID_REQUEST'
    await t.close()


async def test_request_raises_on_unexpected_type():
    t = await _transport()
    t._ws.feed({'payloadType': 9999, 'clientMsgId': 'm1', 'payload': {}})
    with pytest.raises(CTraderApiError) as exc:
        await t.request(PAYLOAD['TRADER_REQ'], {}, PAYLOAD['TRADER_RES'])
    assert exc.value.code == 'UNEXPECTED_TYPE'
    await t.close()


async def test_request_until_collects_accepted_then_filled():
    """A market order emits ORDER_ACCEPTED (2) then ORDER_FILLED (3), BOTH
    correlated to our clientMsgId — verified live. request_until must not
    stop at the first frame."""
    t = await _transport()
    t._ws.feed({'payloadType': 2126, 'clientMsgId': 'm1', 'payload': {'executionType': 2}})
    t._ws.feed({'payloadType': 2126, 'clientMsgId': 'm1', 'payload': {'executionType': 3, 'deal': {}}})
    envs = await t.request_until(
        PAYLOAD['NEW_ORDER_REQ'], {},
        done=lambda env: (env.get('payload') or {}).get('executionType') == 3,
    )
    assert [e['payload']['executionType'] for e in envs] == [2, 3]
    await t.close()


async def test_request_until_raises_on_order_error_event():
    t = await _transport()
    t._ws.feed({'payloadType': 2132, 'clientMsgId': 'm1',
                'payload': {'errorCode': 'INVALID_REQUEST',
                            'description': 'SL/TP in absolute values are allowed only for ...'}})
    with pytest.raises(CTraderApiError) as exc:
        await t.request_until(PAYLOAD['NEW_ORDER_REQ'], {}, done=lambda env: False)
    assert exc.value.code == 'INVALID_REQUEST'
    await t.close()


async def test_request_until_times_out_without_terminal_frame():
    t = await _transport()
    t._ws.feed({'payloadType': 2126, 'clientMsgId': 'm1', 'payload': {'executionType': 2}})
    with pytest.raises((CTraderApiError, asyncio.TimeoutError)):
        await t.request_until(PAYLOAD['NEW_ORDER_REQ'], {}, done=lambda env: False, timeout=0.2)
    await t.close()


async def test_uncorrelated_events_go_to_listeners():
    t = await _transport()
    seen = []
    t.on_event(2126, lambda payload: seen.append(payload))
    t._ws.feed({'payloadType': 2126, 'payload': {'executionType': 5}})  # server event, no msgId
    t._ws.feed({'payloadType': PAYLOAD['TRADER_RES'], 'clientMsgId': 'm1', 'payload': {}})
    await t.request(PAYLOAD['TRADER_REQ'], {}, PAYLOAD['TRADER_RES'])
    assert seen == [{'executionType': 5}]
    await t.close()


async def test_disconnect_fails_pending_requests():
    t = await _transport()
    task = asyncio.create_task(t.request(PAYLOAD['TRADER_REQ'], {}, PAYLOAD['TRADER_RES'], timeout=5))
    await asyncio.sleep(0.05)  # let the request register + send
    await t._ws.close()  # reader loop ends → pending get DISCONNECTED
    with pytest.raises(CTraderApiError) as exc:
        await task
    assert exc.value.code == 'DISCONNECTED'
