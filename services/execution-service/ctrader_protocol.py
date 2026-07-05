"""cTrader Open API message protocol over WebSocket.

This module encodes ProtoOA*Req messages and decodes ProtoOA*Res / *Event responses.
We use raw Protobuf encoding (google.protobuf) against message types we declare here
inline rather than pulling Spotware's full schema — only the subset we need.

Endpoint URLs:
  - LIVE:  wss://live.ctraderapi.com:5036
  - DEMO:  wss://demo.ctraderapi.com:5036
"""
from __future__ import annotations

import asyncio
import json
import logging
import struct
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

import websockets
from websockets.client import WebSocketClientProtocol

_logger = logging.getLogger(__name__)

# Payload type IDs from Spotware ProtoPayloadType enum.
# https://help.ctrader.com/open-api/messages/
PAYLOAD = {
    'APP_AUTH_REQ': 2100,
    'APP_AUTH_RES': 2101,
    'ACCOUNT_AUTH_REQ': 2102,
    'ACCOUNT_AUTH_RES': 2103,
    'HEARTBEAT_EVENT': 51,
    'ERROR_RES': 50,
    'SYMBOLS_LIST_REQ': 2114,
    'SYMBOLS_LIST_RES': 2115,
    'NEW_ORDER_REQ': 2106,
    'EXECUTION_EVENT': 2126,
    'CLOSE_POSITION_REQ': 2111,
    'AMEND_POSITION_SLTP_REQ': 2110,
    'RECONCILE_REQ': 2124,
    'RECONCILE_RES': 2125,
    'TRADER_REQ': 2121,
    'TRADER_RES': 2122,
    'DEAL_LIST_REQ': 2133,
    'DEAL_LIST_RES': 2134,
    'SYMBOL_BY_ID_REQ': 2116,
    'SYMBOL_BY_ID_RES': 2117,
    'ORDER_ERROR_EVENT': 2132,
    'GET_TRENDBARS_REQ': 2137,
    'GET_TRENDBARS_RES': 2138,
    'OA_ERROR_RES': 2142,
}

# Any of these payload types is an error reply to a request. Verified live:
# order rejections arrive as ORDER_ERROR_EVENT (2132), OA-level failures as
# OA_ERROR_RES (2142), and framework failures as ERROR_RES (50).
ERROR_PAYLOAD_TYPES = {50, 2132, 2142}


@dataclass
class ProtoMessage:
    """Wire-format message. Spotware sends a length-prefixed protobuf envelope.
    For simplicity we send/receive JSON over WebSocket using the spotware-connect
    subprotocol's JSON variant — see `ctraderapi.com` connect spec.
    (Production may switch to binary Protobuf later; this stays the boundary.)"""
    payload_type: int
    payload: Dict[str, Any]
    client_msg_id: Optional[str] = None

    def to_wire(self) -> str:
        env = {
            'payloadType': self.payload_type,
            'payload': self.payload,
        }
        if self.client_msg_id:
            env['clientMsgId'] = self.client_msg_id
        return json.dumps(env)

    @classmethod
    def from_wire(cls, raw: str) -> 'ProtoMessage':
        env = json.loads(raw)
        return cls(
            payload_type=env.get('payloadType', 0),
            payload=env.get('payload', {}),
            client_msg_id=env.get('clientMsgId'),
        )


class CTraderTransport:
    """Persistent WebSocket connection with request/response correlation by clientMsgId."""

    def __init__(self, host: str, port: int = 5036):
        self.url = f'wss://{host}:{port}'
        self._ws: Optional[WebSocketClientProtocol] = None
        # msg_id → Queue of correlated envelopes. A queue (not a future) because
        # one request can produce several correlated frames — a market order
        # yields ORDER_ACCEPTED then ORDER_FILLED, both with our clientMsgId.
        self._pending: Dict[str, asyncio.Queue] = {}
        self._listeners: Dict[int, Callable[[Dict[str, Any]], None]] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._msg_seq = 0

    async def connect(self) -> None:
        self._ws = await websockets.connect(self.url, subprotocols=['spotware-connect'])
        self._reader_task = asyncio.create_task(self._reader_loop())

    @property
    def is_alive(self) -> bool:
        """False once the reader loop has exited — i.e. the server closed the
        socket (cTrader demo sends 1000 'Bye' over the weekend) or it errored.
        Used by the client to reconnect-on-demand instead of serving 500s
        forever from a cached-but-dead connection."""
        return (
            self._ws is not None
            and self._reader_task is not None
            and not self._reader_task.done()
        )

    async def close(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
        if self._ws:
            await self._ws.close()

    def on_event(self, payload_type: int, handler: Callable[[Dict[str, Any]], None]) -> None:
        self._listeners[payload_type] = handler

    @staticmethod
    def _raise_if_error(env: Dict[str, Any]) -> None:
        if isinstance(env, Exception):
            raise env
        if env.get('payloadType') in ERROR_PAYLOAD_TYPES:
            p = env.get('payload') or {}
            raise CTraderApiError(p.get('errorCode', 'UNKNOWN'), p.get('description', ''))

    def _register(self, payload_type: int, payload: Dict[str, Any]) -> tuple:
        self._msg_seq += 1
        msg_id = f'm{self._msg_seq}'
        q: asyncio.Queue = asyncio.Queue()
        self._pending[msg_id] = q
        msg = ProtoMessage(payload_type=payload_type, payload=payload, client_msg_id=msg_id)
        return msg_id, q, msg

    async def request(
        self,
        payload_type: int,
        payload: Dict[str, Any],
        expected_response_type: int,
        timeout: float = 10.0,
    ) -> Dict[str, Any]:
        if not self._ws:
            raise RuntimeError('Transport not connected')
        msg_id, q, msg = self._register(payload_type, payload)
        try:
            await self._ws.send(msg.to_wire())
            response = await asyncio.wait_for(q.get(), timeout=timeout)
            self._raise_if_error(response)
            if response.get('payloadType') != expected_response_type:
                raise CTraderApiError('UNEXPECTED_TYPE',
                                      f"expected {expected_response_type}, got {response.get('payloadType')}")
            # Responses with an empty message body (e.g. APP_AUTH_RES 2101) omit
            # the `payload` key entirely — verified against the live demo API.
            return response.get('payload') or {}
        finally:
            self._pending.pop(msg_id, None)

    async def request_until(
        self,
        payload_type: int,
        payload: Dict[str, Any],
        done: Callable[[Dict[str, Any]], bool],
        timeout: float = 15.0,
    ) -> list:
        """Send a request and keep consuming correlated frames until `done(env)`
        returns truthy. Needed for order flows: a market order emits
        ORDER_ACCEPTED then ORDER_FILLED, both correlated to our clientMsgId.
        Returns every collected envelope; raises on error frames / timeout."""
        if not self._ws:
            raise RuntimeError('Transport not connected')
        msg_id, q, msg = self._register(payload_type, payload)
        collected: list = []
        try:
            await self._ws.send(msg.to_wire())
            loop = asyncio.get_running_loop()
            deadline = loop.time() + timeout
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise CTraderApiError('TIMEOUT', f'no terminal frame within {timeout}s')
                env = await asyncio.wait_for(q.get(), timeout=remaining)
                self._raise_if_error(env)
                collected.append(env)
                if done(env):
                    return collected
        finally:
            self._pending.pop(msg_id, None)

    async def send_oneway(self, payload_type: int, payload: Dict[str, Any]) -> None:
        if not self._ws:
            raise RuntimeError('Transport not connected')
        await self._ws.send(ProtoMessage(payload_type=payload_type, payload=payload).to_wire())

    async def _reader_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                try:
                    env = json.loads(raw)
                except json.JSONDecodeError as e:
                    _logger.warning(f'cTrader: malformed frame, skipping: {e}')
                    continue
                msg_id = env.get('clientMsgId')
                payload_type = env.get('payloadType')
                pending_q = self._pending.get(msg_id) if msg_id else None
                if pending_q is not None:
                    pending_q.put_nowait(env)
                    continue
                handler = self._listeners.get(payload_type)
                if handler:
                    try:
                        handler(env.get('payload', {}))
                    except Exception as e:
                        _logger.error(f'cTrader event handler error: {e}')
        except websockets.ConnectionClosed:
            _logger.warning('cTrader WebSocket closed')
        except asyncio.CancelledError:
            pass
        except Exception as e:
            _logger.error(f'cTrader reader loop crashed: {e}')
        finally:
            # Fail any pending requests so callers don't hang on a dead connection
            for q in self._pending.values():
                q.put_nowait(CTraderApiError('DISCONNECTED', 'WebSocket closed'))
            self._pending.clear()


class CTraderApiError(Exception):
    def __init__(self, code: str, description: str):
        self.code = code
        self.description = description
        super().__init__(f'{code}: {description}')
