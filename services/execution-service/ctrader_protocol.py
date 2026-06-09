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
}


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
        self._pending: Dict[str, asyncio.Future] = {}
        self._listeners: Dict[int, Callable[[Dict[str, Any]], None]] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._msg_seq = 0

    async def connect(self) -> None:
        self._ws = await websockets.connect(self.url, subprotocols=['spotware-connect'])
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def close(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
        if self._ws:
            await self._ws.close()

    def on_event(self, payload_type: int, handler: Callable[[Dict[str, Any]], None]) -> None:
        self._listeners[payload_type] = handler

    async def request(
        self,
        payload_type: int,
        payload: Dict[str, Any],
        expected_response_type: int,
        timeout: float = 10.0,
    ) -> Dict[str, Any]:
        if not self._ws:
            raise RuntimeError('Transport not connected')
        self._msg_seq += 1
        msg_id = f'm{self._msg_seq}'
        msg = ProtoMessage(payload_type=payload_type, payload=payload, client_msg_id=msg_id)
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = fut
        try:
            await self._ws.send(msg.to_wire())
            response = await asyncio.wait_for(fut, timeout=timeout)
            if response.get('payloadType') == PAYLOAD['ERROR_RES']:
                raise CTraderApiError(response['payload'].get('errorCode', 'UNKNOWN'),
                                      response['payload'].get('description', ''))
            if response.get('payloadType') != expected_response_type:
                raise CTraderApiError('UNEXPECTED_TYPE',
                                      f"expected {expected_response_type}, got {response.get('payloadType')}")
            return response['payload']
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
                env = json.loads(raw)
                msg_id = env.get('clientMsgId')
                payload_type = env.get('payloadType')
                if msg_id and msg_id in self._pending:
                    self._pending[msg_id].set_result(env)
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


class CTraderApiError(Exception):
    def __init__(self, code: str, description: str):
        self.code = code
        self.description = description
        super().__init__(f'{code}: {description}')
