# Broker Abstraction + cTrader Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cTrader as a peer to MetaApi behind Spec 1's `Broker` ABC, and ship a wizard-style onboarding flow at `/accounts/new` so friends can OAuth into either broker.

**Architecture:** Python `CTraderClient` implements the existing 8-method `Broker` ABC over Spotware's gRPC/Protobuf-over-WebSocket. NestJS adds an OAuth surface (start → callback → finalize) with Redis-backed state. Web ships a 4-step full-page wizard at `/accounts/new` with a dedicated server-side route handler at `/oauth/ctrader/callback` for the OAuth bounce. No breaking changes to the strategy engine or MetaApi path.

**Tech Stack:** Python 3.12, pytest, asyncio, `websockets`, Protobuf-Python (generated from Spotware `.proto`), NestJS 10, Prisma 6, Redis (existing `@app/redis`), Next.js 16 (App Router, Route Handlers), Tailwind, Framer Motion.

**Reference spec:** `docs/superpowers/specs/2026-06-09-broker-abstraction-design.md` — read it before starting.

**Operational ground rules (load-bearing — must be followed exactly):**
- **No `Co-Authored-By` trailers in any commit.**
- **No "Generated with Claude Code" lines in any PR description.**
- **Commit messages: Conventional Commits** (`feat(scope): …`, `fix(scope): …`, `chore(scope): …`, etc.).
- **Package manager: `pnpm`** (not npm/yarn). The repo's `packageManager` field pins it.
- **Prisma:** prod runs `prisma db push` automatically on push-to-main; do NOT run `prisma migrate dev`. Schema changes are additive only.
- **Local Postgres is usually OFF.** Don't write tests that require a live DB unless they're explicitly e2e tests in `test/`.
- **Python tests:** `pytest-asyncio` is configured with `asyncio_mode = auto`, so async test functions need no decorator.
- **Subagent prompts** (if you dispatch them) must repeat the two top rules above verbatim, since the user has been burned by attribution leaks before.

---

## File Structure

### Created files

| Path | Responsibility |
|---|---|
| `services/execution-service/ctrader_protocol.py` | Generated Protobuf wrappers + send/recv helpers (~150 LOC) |
| `services/execution-service/ctrader_client.py` | `CTraderClient(Broker)` — implements all 8 ABC methods (~450 LOC) |
| `services/execution-service/test_ctrader_symbols.py` | Symbol mapping + price scaling unit tests |
| `services/execution-service/test_ctrader_client.py` | High-level client behaviour (mocked transport) |
| `services/execution-service/test_ctrader_reconnect.py` | Reconnect + token refresh tests |
| `src/broker-accounts/oauth/broker-oauth.service.ts` | OAuth state mgmt + Spotware HTTP calls |
| `src/broker-accounts/oauth/broker-oauth.controller.ts` | 2 public endpoints (start, callback) |
| `src/broker-accounts/oauth/broker-oauth.service.spec.ts` | Unit tests |
| `src/broker-accounts/oauth/broker-oauth.controller.spec.ts` | Controller tests |
| `src/broker-accounts/oauth/dto/start-oauth.dto.ts` | (empty body — endpoint just needs auth) |
| `src/broker-accounts/oauth/dto/callback.dto.ts` | `{ code, state }` |
| `src/broker-accounts/oauth/dto/finalize-oauth.dto.ts` | `{ oauthSessionId, ctidTraderAccountId, name }` |
| `src/broker-accounts/oauth/dto/oauth-tokens.dto.ts` | `{ accessToken, refreshToken, expiresAt }` |
| `shamarx-web/src/app/oauth/ctrader/callback/route.ts` | Server-side OAuth callback handler — POSTs to API, 302s to wizard |
| `shamarx-web/src/app/accounts/new/page.tsx` | Redirect to step 1 |
| `shamarx-web/src/app/accounts/new/broker/page.tsx` | Step 1: pick broker |
| `shamarx-web/src/app/accounts/new/connect/page.tsx` | Step 2a (cTrader CTA) / 2b (MetaApi form) |
| `shamarx-web/src/app/accounts/new/pick/page.tsx` | Step 3: account picker (cTrader only) |
| `shamarx-web/src/app/accounts/new/confirm/page.tsx` | Step 4: name + confirm |
| `shamarx-web/src/components/wizard/step-strip.tsx` | Numbered step strip header |
| `shamarx-web/src/components/wizard/broker-card.tsx` | Per-broker selectable card |
| `shamarx-web/src/components/wizard/account-row.tsx` | Single account row in step 3 |
| `shamarx-web/src/hooks/use-broker-oauth.ts` | React Query hooks |
| `test/ctrader-oauth.e2e-spec.ts` | Mocked-Spotware end-to-end test |

### Modified files

| Path | Change |
|---|---|
| `libs/prisma/schema.prisma` | 4 nullable cols + composite index on `BrokerAccount` |
| `services/execution-service/registry.py` | `_default_factory(creds, broker, mode)` dispatch by broker |
| `services/execution-service/routes.py` | `resolve_client` reads `X-Broker` header |
| `services/execution-service/test_registry.py` | Update existing tests for new factory signature |
| `services/execution-service/requirements.txt` | Add `websockets` + `protobuf` |
| `src/broker-accounts/broker-accounts.service.ts` | Extend `create()`, add `updateCreds()` |
| `src/broker-accounts/broker-accounts.controller.ts` | Add internal `PATCH /:id/oauth-tokens` |
| `src/broker-accounts/broker-accounts.module.ts` | Register OAuth controller + service |
| `src/broker-accounts/dto/create-broker-account.dto.ts` | Discriminated union (METAAPI vs CTRADER finalize) |
| `src/broker-accounts/broker-accounts.service.spec.ts` | Cover `updateCreds` + new metadata fields |
| `src/strategy/live/broker-http-client.ts` | Inject `X-Broker` header |
| `shamarx-web/src/lib/api-client.ts` | OAuth client methods |
| `shamarx-web/src/lib/types.ts` | New types |
| `shamarx-web/src/app/accounts/page.tsx` | Replace "Add account" modal CTA with link to `/accounts/new` |
| `.env.example` | Document new env vars |
| `.env.aws.example` | Same |
| `docs/RUNBOOK.md` | Add cTrader OAuth section |

---

## Task list

### Task 1: Schema — 4 nullable BrokerAccount columns

**Files:**
- Modify: `libs/prisma/schema.prisma`

- [ ] **Step 1: Read current BrokerAccount model**

Open `libs/prisma/schema.prisma`, locate the `model BrokerAccount` block (around line 95-115 — Spec 1 + Spec 2 schema). Note existing field set.

- [ ] **Step 2: Add 4 nullable columns + composite index**

Inside `model BrokerAccount`, immediately after the existing `mode` field and before `lastConnectedAt`:

```prisma
  /// cTrader account number (e.g., "52867017"). null for MetaApi.
  accountNumber  String?
  /// 'DEMO' | 'LIVE'. null for MetaApi.
  accountKind    String?
  /// Friendly broker name from Spotware (e.g., "IC Markets"). null for MetaApi.
  brokerName     String?
  /// When the current OAuth access token expires. null for MetaApi.
  oauthExpiresAt DateTime?
```

At the bottom of the model block (after `riskStates RiskState[]`), add:

```prisma
  @@index([broker, accountKind])
```

- [ ] **Step 3: Regenerate Prisma client**

Run: `pnpm prisma:generate`
Expected: `✔ Generated Prisma Client (...)` no errors. New types appear in `node_modules/.prisma/client`.

- [ ] **Step 4: Verify TypeScript still compiles**

Run: `pnpm build:backend`
Expected: build succeeds. (If anything broke, it's because an `as const`/literal narrowing relied on the absence of these fields — fix the call site, do not remove the schema change.)

- [ ] **Step 5: Commit**

```bash
git add libs/prisma/schema.prisma
git commit -m "feat(schema): add accountNumber/accountKind/brokerName/oauthExpiresAt to BrokerAccount

Nullable for backward compatibility with existing MetaApi rows.
Adds composite index on (broker, accountKind) for upcoming OAuth queries."
```

---

### Task 2: Python registry — broker dispatch + X-Broker header

**Files:**
- Modify: `services/execution-service/registry.py`
- Modify: `services/execution-service/routes.py`
- Modify: `services/execution-service/test_registry.py`

- [ ] **Step 1: Update existing registry tests to the new signature (still failing — broker arg doesn't exist yet)**

Replace every `lambda creds, mode: FakeClient()` and every `r.get_or_create('acct-1', {}, 'mock')` in `services/execution-service/test_registry.py` with the new 3-arg shape:

```python
# Replace factory lambdas:
r = BrokerClientRegistry(factory=lambda creds, broker, mode: FakeClient())

# Replace get_or_create calls (5 sites):
a = await r.get_or_create('acct-1', {}, 'MOCK', 'mock')
b = await r.get_or_create('acct-1', {}, 'MOCK', 'mock')
# ...same for acct-2 in test_get_or_create_different_accounts and others
```

Add a new test at the bottom of the file:

```python
async def test_factory_receives_broker_arg():
    received = {}
    def factory(creds, broker, mode):
        received['broker'] = broker
        received['mode'] = mode
        return FakeClient()
    r = BrokerClientRegistry(factory=factory)
    await r.get_or_create('acct-1', {'foo': 'bar'}, 'CTRADER', 'metaapi')
    assert received['broker'] == 'CTRADER'
    assert received['mode'] == 'metaapi'
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd services/execution-service && pytest test_registry.py -v`
Expected: every test fails with `TypeError: <lambda>() takes 2 positional arguments but 3 were given`.

- [ ] **Step 3: Update `registry.py`**

Replace the contents of `services/execution-service/registry.py` (lines 14-39) with:

```python
def _default_factory(creds: dict, broker: str, mode: str) -> Broker:
    if mode == 'mock':
        from mock_mt5 import MockMT5
        return MockMT5()
    if broker == 'CTRADER':
        from ctrader_client import CTraderClient
        return CTraderClient.from_creds(creds)
    # Default + 'METAAPI'
    from metaapi_mt5 import MetaApiMT5
    return MetaApiMT5.from_creds(creds)


class BrokerClientRegistry:
    def __init__(self, factory: Optional[Callable[[dict, str, str], Broker]] = None):
        self._clients: Dict[str, Broker] = {}
        self._init_locks: Dict[str, asyncio.Lock] = {}
        self._factory = factory or _default_factory

    async def get_or_create(self, account_id: str, creds: dict, broker: str, mode: str) -> Broker:
        if account_id in self._clients:
            return self._clients[account_id]
        lock = self._init_locks.setdefault(account_id, asyncio.Lock())
        async with lock:
            if account_id in self._clients:
                return self._clients[account_id]
            client = self._factory(creds, broker, mode)
            await client.initialize()
            self._clients[account_id] = client
            _logger.info(f'BrokerClientRegistry: created client for account={account_id} broker={broker} mode={mode}')
            return client
```

(The `remove` and `known_accounts` methods stay unchanged; do NOT delete them.)

- [ ] **Step 4: Update `resolve_client` in `routes.py`**

In `services/execution-service/routes.py`, replace the existing `resolve_client` function (lines 173-186) with:

```python
async def resolve_client(
    account_id: str,
    x_broker_creds: Optional[str] = Header(None),
    x_broker_mode: str = Header('metaapi'),
    x_broker: str = Header('METAAPI'),
) -> Broker:
    """Resolve the broker client for this account, lazy-initializing if needed.
    Creds arrive as JSON in the X-Broker-Creds header (sent by NestJS).
    Broker dispatch is by the X-Broker header (METAAPI | CTRADER | MOCK)."""
    if not x_broker_creds:
        raise HTTPException(401, "X-Broker-Creds header required")
    try:
        creds = json.loads(x_broker_creds)
    except json.JSONDecodeError:
        raise HTTPException(400, "X-Broker-Creds must be valid JSON")
    return await registry.get_or_create(account_id, creds, x_broker, x_broker_mode)
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd services/execution-service && pytest test_registry.py -v`
Expected: all tests pass, including the new `test_factory_receives_broker_arg`.

- [ ] **Step 6: Commit**

```bash
git add services/execution-service/registry.py services/execution-service/routes.py services/execution-service/test_registry.py
git commit -m "feat(execution-service): dispatch Broker factory on X-Broker header

_default_factory now takes (creds, broker, mode). resolve_client reads
X-Broker so the registry can pick CTRADER vs METAAPI per account."
```

---

### Task 3: Add Python deps + protocol scaffold

**Files:**
- Modify: `services/execution-service/requirements.txt`
- Create: `services/execution-service/ctrader_protocol.py`

- [ ] **Step 1: Add deps**

Append to `services/execution-service/requirements.txt`:

```
websockets==13.1
protobuf==5.28.3
```

- [ ] **Step 2: Install**

Run: `cd services/execution-service && pip install -r requirements.txt`
Expected: both packages install cleanly.

- [ ] **Step 3: Create `ctrader_protocol.py` — message constants + send/recv helpers**

Spotware ships `.proto` files at https://github.com/spotware/OpenApiPy/tree/main/ctrader_open_api/messages. For this plan we use a **hand-rolled minimal wrapper** that encodes/decodes the subset of messages we need without depending on the unofficial PyPI package. Build the wrapper using `google.protobuf` runtime + literal payload classes.

Write `services/execution-service/ctrader_protocol.py`:

```python
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
```

- [ ] **Step 4: Smoke import**

Run: `cd services/execution-service && python -c "from ctrader_protocol import CTraderTransport, PAYLOAD, CTraderApiError; print('ok')"`
Expected: `ok`. (No connection attempted — just module import.)

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/requirements.txt services/execution-service/ctrader_protocol.py
git commit -m "feat(execution-service): add cTrader protocol transport scaffold

WebSocket + JSON-envelope protocol layer with request/response correlation
by clientMsgId. Targets spotware-connect subprotocol. Used by CTraderClient
in next task."
```

---

### Task 4: CTraderClient — symbol mapping + price scaling (pure helpers, TDD)

**Files:**
- Create: `services/execution-service/ctrader_client.py` (initial — symbol/price helpers only)
- Create: `services/execution-service/test_ctrader_symbols.py`

- [ ] **Step 1: Write failing symbol-mapping tests**

Create `services/execution-service/test_ctrader_symbols.py`:

```python
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
```

- [ ] **Step 2: Run — expect ImportError**

Run: `cd services/execution-service && pytest test_ctrader_symbols.py -v`
Expected: `ModuleNotFoundError: No module named 'ctrader_client'`.

- [ ] **Step 3: Create the initial `ctrader_client.py` with constructor + helpers**

Create `services/execution-service/ctrader_client.py`:

```python
"""cTrader Open API broker client. Implements the Broker ABC over Spotware
WebSocket API. Authenticates with app-level + account-level OAuth tokens,
maintains a persistent connection with heartbeat + reconnect, and translates
between our domain types and Spotware ProtoOA messages."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, TypeVar

from broker_base import Broker
from ctrader_protocol import CTraderTransport, CTraderApiError, PAYLOAD

_logger = logging.getLogger(__name__)
T = TypeVar('T')

SYMBOL_ALIASES = {
    'XAUUSD': ['GOLD', 'XAU/USD'],
    'EURUSD': ['EUR/USD'],
    'GBPUSD': ['GBP/USD'],
    'USDJPY': ['USD/JPY'],
}


class CTraderClient(Broker):
    def __init__(
        self,
        access_token: str,
        refresh_token: str,
        ctid_trader_account_id: int,
        expires_at: int,
        account_kind: str,
        account_id: str = '',
        on_token_refresh: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
    ):
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.ctid_trader_account_id = ctid_trader_account_id
        self.expires_at = expires_at
        self.account_kind = account_kind  # 'DEMO' | 'LIVE'
        self.account_id = account_id
        self._on_token_refresh = on_token_refresh

        self._transport: Optional[CTraderTransport] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._closed = False

        self._symbol_id_by_name: Dict[str, int] = {}
        self._symbol_name_by_id: Dict[int, str] = {}
        self._symbol_digits: Dict[str, int] = {}

    @classmethod
    def from_creds(cls, creds: Dict[str, Any]) -> 'CTraderClient':
        return cls(
            access_token=creds['accessToken'],
            refresh_token=creds['refreshToken'],
            ctid_trader_account_id=int(creds['ctidTraderAccountId']),
            expires_at=int(creds.get('expiresAt', 0)),
            account_kind=creds.get('accountKind', 'DEMO'),
            account_id=creds.get('accountId', ''),
        )

    # ----- Symbol + price helpers -----
    def _to_ctrader_symbol(self, symbol: str) -> int:
        if symbol in self._symbol_id_by_name:
            return self._symbol_id_by_name[symbol]
        for alias in SYMBOL_ALIASES.get(symbol, []):
            if alias in self._symbol_id_by_name:
                return self._symbol_id_by_name[alias]
        raise ValueError(f'Symbol {symbol} not available on this cTrader account')

    def _our_symbol_from_id(self, symbol_id: int) -> str:
        return self._symbol_name_by_id.get(symbol_id, str(symbol_id))

    def _to_ctrader_price(self, symbol: str, price: float) -> int:
        digits = self._symbol_digits.get(symbol, 5)
        return int(round(price * (10 ** digits)))

    def _from_ctrader_price(self, symbol: str, price_int: int) -> float:
        digits = self._symbol_digits.get(symbol, 5)
        return price_int / (10 ** digits)

    # ----- Stubs (filled in subsequent tasks) -----
    async def initialize(self) -> None:
        raise NotImplementedError('Task 5')

    async def place_order(self, request) -> object:
        raise NotImplementedError('Task 6')

    async def get_positions(self, symbol: Optional[str] = None) -> list:
        raise NotImplementedError('Task 7')

    async def close_position(self, ticket: int) -> dict:
        raise NotImplementedError('Task 6')

    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict:
        raise NotImplementedError('Task 6')

    async def get_account_info(self) -> object:
        raise NotImplementedError('Task 7')

    async def get_position_close_info(self, ticket: int) -> Optional[dict]:
        raise NotImplementedError('Task 7')

    async def close(self) -> None:
        self._closed = True
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self._transport:
            await self._transport.close()
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd services/execution-service && pytest test_ctrader_symbols.py -v`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/ctrader_client.py services/execution-service/test_ctrader_symbols.py
git commit -m "feat(execution-service): CTraderClient scaffold with symbol + price helpers

Constructor + from_creds + symbol/price translation. Method bodies stubbed
to NotImplementedError; filled in subsequent tasks."
```

---

### Task 5: CTraderClient — `initialize()` (connect + auth + symbol catalog + heartbeat)

**Files:**
- Modify: `services/execution-service/ctrader_client.py`
- Create: `services/execution-service/test_ctrader_client.py`

- [ ] **Step 1: Write the test (with a FakeTransport)**

Create `services/execution-service/test_ctrader_client.py`:

```python
import asyncio
import pytest
from ctrader_client import CTraderClient
from ctrader_protocol import PAYLOAD


class FakeTransport:
    """Records sent messages, returns canned responses keyed by payload type."""

    def __init__(self, canned: dict[int, dict]):
        self.canned = canned
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

    async def send_oneway(self, payload_type, payload):
        self.oneway.append((payload_type, payload))


def _client():
    return CTraderClient(
        access_token='at', refresh_token='rt', ctid_trader_account_id=42,
        expires_at=9999999999, account_kind='DEMO', account_id='abc',
    )


async def test_initialize_sends_app_auth_then_account_auth_then_symbols(monkeypatch):
    canned = {
        PAYLOAD['APP_AUTH_RES']: {},
        PAYLOAD['ACCOUNT_AUTH_RES']: {'ctidTraderAccountId': 42},
        PAYLOAD['SYMBOLS_LIST_RES']: {'symbol': [
            {'symbolId': 1, 'symbolName': 'EURUSD', 'digits': 5},
            {'symbolId': 41, 'symbolName': 'XAUUSD', 'digits': 2},
        ]},
    }
    transport = FakeTransport(canned)
    c = _client()
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'cid'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'csec')
    monkeypatch.setattr('ctrader_client.CTraderTransport', lambda *a, **kw: transport)

    await c.initialize()

    types_sent = [t for t, _ in transport.sent]
    assert types_sent == [PAYLOAD['APP_AUTH_REQ'], PAYLOAD['ACCOUNT_AUTH_REQ'], PAYLOAD['SYMBOLS_LIST_REQ']]
    assert c._symbol_id_by_name == {'EURUSD': 1, 'XAUUSD': 41}
    assert c._symbol_digits == {'EURUSD': 5, 'XAUUSD': 2}
    await c.close()


async def test_initialize_uses_live_endpoint_for_live_kind(monkeypatch):
    canned = {
        PAYLOAD['APP_AUTH_RES']: {},
        PAYLOAD['ACCOUNT_AUTH_RES']: {},
        PAYLOAD['SYMBOLS_LIST_RES']: {'symbol': []},
    }
    captured = {}
    def fake_transport(host, port=5036):
        captured['host'] = host
        return FakeTransport(canned)
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'x'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'y')
    monkeypatch.setattr('ctrader_client.CTraderTransport', fake_transport)

    c = _client()
    c.account_kind = 'LIVE'
    await c.initialize()
    assert captured['host'] == 'live.ctraderapi.com'
    await c.close()
```

- [ ] **Step 2: Run — expect NotImplementedError**

Run: `cd services/execution-service && pytest test_ctrader_client.py::test_initialize_sends_app_auth_then_account_auth_then_symbols -v`
Expected: `NotImplementedError: Task 5`.

- [ ] **Step 3: Implement `initialize()`**

In `services/execution-service/ctrader_client.py`, replace the `initialize` stub with:

```python
async def initialize(self) -> None:
    client_id = os.getenv('CTRADER_CLIENT_ID')
    client_secret = os.getenv('CTRADER_CLIENT_SECRET')
    if not client_id or not client_secret:
        raise RuntimeError('CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET must be set')

    host = 'live.ctraderapi.com' if self.account_kind == 'LIVE' else 'demo.ctraderapi.com'
    self._transport = CTraderTransport(host)
    await self._transport.connect()

    # App-level auth
    await self._transport.request(
        PAYLOAD['APP_AUTH_REQ'],
        {'clientId': client_id, 'clientSecret': client_secret},
        PAYLOAD['APP_AUTH_RES'],
    )

    # Account-level auth
    await self._transport.request(
        PAYLOAD['ACCOUNT_AUTH_REQ'],
        {'ctidTraderAccountId': self.ctid_trader_account_id, 'accessToken': self.access_token},
        PAYLOAD['ACCOUNT_AUTH_RES'],
    )

    # Symbol catalog
    symbols_res = await self._transport.request(
        PAYLOAD['SYMBOLS_LIST_REQ'],
        {'ctidTraderAccountId': self.ctid_trader_account_id, 'includeArchivedSymbols': False},
        PAYLOAD['SYMBOLS_LIST_RES'],
    )
    for s in symbols_res.get('symbol', []):
        name = s['symbolName']
        sid = int(s['symbolId'])
        self._symbol_id_by_name[name] = sid
        self._symbol_name_by_id[sid] = name
        self._symbol_digits[name] = int(s.get('digits', 5))

    # Start heartbeat
    self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
    _logger.info(f'CTraderClient: initialized account={self.ctid_trader_account_id} '
                 f'kind={self.account_kind} symbols={len(self._symbol_id_by_name)}')

async def _heartbeat_loop(self) -> None:
    assert self._transport is not None
    while not self._closed:
        await asyncio.sleep(10)
        try:
            await self._transport.send_oneway(PAYLOAD['HEARTBEAT_EVENT'], {})
        except Exception as e:
            _logger.warning(f'CTrader heartbeat failed: {e}')
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd services/execution-service && pytest test_ctrader_client.py -v`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/ctrader_client.py services/execution-service/test_ctrader_client.py
git commit -m "feat(execution-service): CTraderClient.initialize — connect, auth, symbols, heartbeat

App-level + account-level auth via env-driven CTRADER_CLIENT_ID/SECRET. Symbol
catalog cached in memory at init. Heartbeat task pings every 10s to stay
under Spotware's 30s idle limit."
```

---

### Task 6: CTraderClient — `place_order`, `close_position`, `modify_position`

**Files:**
- Modify: `services/execution-service/ctrader_client.py`
- Modify: `services/execution-service/test_ctrader_client.py`

- [ ] **Step 1: Add test cases**

Append to `services/execution-service/test_ctrader_client.py`:

```python
from models import OrderRequest


def _initialized_client(monkeypatch, extra_canned=None):
    canned = {
        PAYLOAD['APP_AUTH_RES']: {},
        PAYLOAD['ACCOUNT_AUTH_RES']: {},
        PAYLOAD['SYMBOLS_LIST_RES']: {'symbol': [
            {'symbolId': 1, 'symbolName': 'EURUSD', 'digits': 5},
            {'symbolId': 41, 'symbolName': 'XAUUSD', 'digits': 2},
        ]},
    }
    canned.update(extra_canned or {})
    transport = FakeTransport(canned)
    monkeypatch.setenv('CTRADER_CLIENT_ID', 'x'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'y')
    monkeypatch.setattr('ctrader_client.CTraderTransport', lambda *a, **kw: transport)
    return transport


async def test_place_order_translates_request(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['EXECUTION_EVENT']: {
            'order': {'orderId': 9876543210, 'positionId': 1234567},
            'executionType': 'ORDER_FILLED',
            'position': {'positionId': 1234567},
        },
    })
    c = _client()
    await c.initialize()
    req = OrderRequest(symbol='EURUSD', side='BUY', lotSize=0.10, slPrice=1.08000, tpPrice=1.09000)
    res = await c.place_order(req)
    new_order_call = next(p for t, p in transport.sent if t == PAYLOAD['NEW_ORDER_REQ'])
    assert new_order_call['symbolId'] == 1
    assert new_order_call['orderType'] == 'MARKET'
    assert new_order_call['tradeSide'] == 'BUY'
    assert new_order_call['volume'] == 10  # 0.1 lot * 100 (Spotware uses centi-lots = volume in 0.01 units * 100 = lots * 100? check units below)
    assert new_order_call['stopLoss'] == 108000
    assert new_order_call['takeProfit'] == 109000
    assert res.mt5Ticket == 1234567
    assert res.status == 'FILLED'
    await c.close()


async def test_close_position_sends_volume_zero(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['EXECUTION_EVENT']: {'executionType': 'ORDER_FILLED', 'position': {'positionId': 555}},
    })
    c = _client()
    await c.initialize()
    res = await c.close_position(555)
    close_call = next(p for t, p in transport.sent if t == PAYLOAD['CLOSE_POSITION_REQ'])
    assert close_call['positionId'] == 555
    assert close_call['volume'] == 0  # full close
    assert res['status'] in ('CLOSED', 'OK')
    await c.close()


async def test_modify_position_sends_sl_tp(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['EXECUTION_EVENT']: {'executionType': 'AMENDED', 'position': {'positionId': 555}},
    })
    c = _client()
    await c.initialize()
    # Inject a known position so we can map ticket->symbol for price scaling
    c._position_symbol_cache = {555: 'EURUSD'}
    await c.modify_position(555, sl_price=1.07500, tp_price=1.09500)
    amend_call = next(p for t, p in transport.sent if t == PAYLOAD['AMEND_POSITION_SLTP_REQ'])
    assert amend_call['positionId'] == 555
    assert amend_call['stopLoss'] == 107500
    assert amend_call['takeProfit'] == 109500
    await c.close()
```

> **Note on Spotware volume units:** Spotware's `volume` field is `int64` representing `lots × 100` (i.e. 0.10 lots = `10`, 1.00 lots = `100`). This is the integer unit, not micro-lots. The test above uses 10 for 0.10. Reference: https://help.ctrader.com/open-api/messages/#protoanewordereq

- [ ] **Step 2: Run — expect NotImplementedError**

Run: `cd services/execution-service && pytest test_ctrader_client.py -v -k "place_order or close_position or modify_position"`
Expected: 3 failures with `NotImplementedError`.

- [ ] **Step 3: Implement the three methods**

In `ctrader_client.py`:

1. Add a `_position_symbol_cache: Dict[int, str] = {}` initialization in `__init__` (right after `self._symbol_digits = {}`).
2. Replace the `place_order`, `close_position`, `modify_position` stubs with:

```python
async def place_order(self, request) -> object:
    from models import OrderResponse
    assert self._transport is not None
    symbol_id = self._to_ctrader_symbol(request.symbol)
    volume = int(round(request.lotSize * 100))  # Spotware: lots * 100
    payload = {
        'ctidTraderAccountId': self.ctid_trader_account_id,
        'symbolId': symbol_id,
        'orderType': 'MARKET',
        'tradeSide': request.side,  # 'BUY' | 'SELL'
        'volume': volume,
        'stopLoss': self._to_ctrader_price(request.symbol, request.slPrice),
        'takeProfit': self._to_ctrader_price(request.symbol, request.tpPrice),
    }
    res = await self._transport.request(
        PAYLOAD['NEW_ORDER_REQ'], payload, PAYLOAD['EXECUTION_EVENT'],
    )
    exec_type = res.get('executionType')
    position_id = res.get('position', {}).get('positionId')
    if position_id:
        self._position_symbol_cache[int(position_id)] = request.symbol
    status = 'FILLED' if exec_type == 'ORDER_FILLED' else 'REJECTED'
    return OrderResponse(
        orderId=str(res.get('order', {}).get('orderId', '')),
        mt5Ticket=int(position_id) if position_id else None,
        status=status,
        message=res.get('errorCode'),
    )

async def close_position(self, ticket: int) -> dict:
    assert self._transport is not None
    res = await self._transport.request(
        PAYLOAD['CLOSE_POSITION_REQ'],
        {'ctidTraderAccountId': self.ctid_trader_account_id, 'positionId': int(ticket), 'volume': 0},
        PAYLOAD['EXECUTION_EVENT'],
    )
    exec_type = res.get('executionType', 'UNKNOWN')
    self._position_symbol_cache.pop(int(ticket), None)
    return {'status': 'CLOSED' if exec_type == 'ORDER_FILLED' else exec_type}

async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict:
    assert self._transport is not None
    symbol = self._position_symbol_cache.get(int(ticket))
    if not symbol:
        # Cache miss: reconcile to find symbol for this position
        positions = await self.get_positions()
        for p in positions:
            if p.get('ticket') == int(ticket):
                symbol = p.get('symbol')
                self._position_symbol_cache[int(ticket)] = symbol
                break
    if not symbol:
        raise CTraderApiError('POSITION_NOT_FOUND', f'ticket={ticket}')
    await self._transport.request(
        PAYLOAD['AMEND_POSITION_SLTP_REQ'],
        {
            'ctidTraderAccountId': self.ctid_trader_account_id,
            'positionId': int(ticket),
            'stopLoss': self._to_ctrader_price(symbol, sl_price),
            'takeProfit': self._to_ctrader_price(symbol, tp_price),
        },
        PAYLOAD['EXECUTION_EVENT'],
    )
    return {'status': 'OK'}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd services/execution-service && pytest test_ctrader_client.py -v -k "place_order or close_position or modify_position"`
Expected: all 3 pass.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/ctrader_client.py services/execution-service/test_ctrader_client.py
git commit -m "feat(execution-service): CTraderClient place_order / close / modify

ProtoOA NewOrder / ClosePosition / AmendPositionSLTP. Caches
position->symbol mapping for SL/TP price scaling on subsequent modifies."
```

---

### Task 7: CTraderClient — `get_positions`, `get_account_info`, `get_position_close_info`

**Files:**
- Modify: `services/execution-service/ctrader_client.py`
- Modify: `services/execution-service/test_ctrader_client.py`

- [ ] **Step 1: Add tests**

Append to `services/execution-service/test_ctrader_client.py`:

```python
async def test_get_positions_translates_response(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['RECONCILE_RES']: {
            'position': [
                {
                    'positionId': 100, 'tradeData': {'symbolId': 1, 'tradeSide': 'BUY', 'volume': 10,
                                                     'openTimestamp': 1717000000000},
                    'price': 108300, 'stopLoss': 108000, 'takeProfit': 109000, 'commission': -5,
                    'swap': 0, 'usedMargin': 100,
                },
            ],
        },
    })
    c = _client()
    await c.initialize()
    positions = await c.get_positions()
    assert len(positions) == 1
    p = positions[0]
    assert p['ticket'] == 100
    assert p['symbol'] == 'EURUSD'
    assert p['side'] == 'BUY'
    assert p['lotSize'] == pytest.approx(0.10)
    assert p['entryPrice'] == pytest.approx(1.08300)
    assert p['sl'] == pytest.approx(1.08000)
    assert p['tp'] == pytest.approx(1.09000)
    await c.close()


async def test_get_positions_filters_by_symbol(monkeypatch):
    transport = _initialized_client(monkeypatch, extra_canned={
        PAYLOAD['RECONCILE_RES']: {
            'position': [
                {'positionId': 100, 'tradeData': {'symbolId': 1, 'tradeSide': 'BUY', 'volume': 10,
                                                   'openTimestamp': 0},
                 'price': 108000, 'stopLoss': 0, 'takeProfit': 0, 'commission': 0, 'swap': 0, 'usedMargin': 0},
                {'positionId': 101, 'tradeData': {'symbolId': 41, 'tradeSide': 'SELL', 'volume': 5,
                                                   'openTimestamp': 0},
                 'price': 205000, 'stopLoss': 0, 'takeProfit': 0, 'commission': 0, 'swap': 0, 'usedMargin': 0},
            ],
        },
    })
    c = _client()
    await c.initialize()
    eur = await c.get_positions('EURUSD')
    xau = await c.get_positions('XAUUSD')
    assert [p['ticket'] for p in eur] == [100]
    assert [p['ticket'] for p in xau] == [101]
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
    assert info.openPositions == 0
    await c.close()
```

- [ ] **Step 2: Run — expect NotImplementedError**

Run: `pytest test_ctrader_client.py -v -k "get_positions or account_info"`
Expected: 3 failures.

- [ ] **Step 3: Implement the methods**

In `ctrader_client.py`, replace the three stubs:

```python
async def get_positions(self, symbol: Optional[str] = None) -> list:
    assert self._transport is not None
    res = await self._transport.request(
        PAYLOAD['RECONCILE_REQ'],
        {'ctidTraderAccountId': self.ctid_trader_account_id},
        PAYLOAD['RECONCILE_RES'],
    )
    positions = []
    for p in res.get('position', []):
        td = p.get('tradeData', {})
        sym_id = int(td.get('symbolId', 0))
        sym = self._our_symbol_from_id(sym_id)
        if symbol and sym != symbol:
            continue
        positions.append({
            'ticket': int(p['positionId']),
            'symbol': sym,
            'side': td.get('tradeSide', ''),
            'lotSize': int(td.get('volume', 0)) / 100.0,
            'entryPrice': self._from_ctrader_price(sym, int(p.get('price', 0))),
            'currentPrice': self._from_ctrader_price(sym, int(p.get('price', 0))),  # cTrader doesn't ship current on reconcile
            'sl': self._from_ctrader_price(sym, int(p.get('stopLoss', 0))),
            'tp': self._from_ctrader_price(sym, int(p.get('takeProfit', 0))),
            'pnl': 0.0,  # cTrader provides via separate ProtoOASpotEvent stream; not used by strategy
            'openTime': str(td.get('openTimestamp', 0)),
            'commission': int(p.get('commission', 0)) / 100.0,
            'swap': int(p.get('swap', 0)) / 100.0,
        })
        self._position_symbol_cache[int(p['positionId'])] = sym
    return positions

async def get_account_info(self) -> object:
    from models import AccountInfo
    assert self._transport is not None
    trader_res = await self._transport.request(
        PAYLOAD['TRADER_REQ'],
        {'ctidTraderAccountId': self.ctid_trader_account_id},
        PAYLOAD['TRADER_RES'],
    )
    trader = trader_res.get('trader', {})
    money_digits = int(trader.get('moneyDigits', 2))
    divisor = 10 ** money_digits
    balance = int(trader.get('balance', 0)) / divisor
    # Margin / equity aren't on TraderRes — they require ReconcileReq aggregation
    positions_res = await self._transport.request(
        PAYLOAD['RECONCILE_REQ'],
        {'ctidTraderAccountId': self.ctid_trader_account_id},
        PAYLOAD['RECONCILE_RES'],
    )
    open_positions = len(positions_res.get('position', []))
    used_margin = sum(int(p.get('usedMargin', 0)) for p in positions_res.get('position', [])) / divisor
    equity = balance  # rough; pnl reconciliation requires market data feed
    return AccountInfo(
        balance=balance,
        equity=equity,
        margin=used_margin,
        freeMargin=max(0.0, equity - used_margin),
        openPositions=open_positions,
    )

async def get_position_close_info(self, ticket: int) -> Optional[dict]:
    assert self._transport is not None
    # cTrader exposes closed deals via DealListReq with from/to timestamps.
    # Search the last 7 days for a deal closing this position.
    now_ms = int(time.time() * 1000)
    seven_days_ms = 7 * 24 * 3600 * 1000
    res = await self._transport.request(
        PAYLOAD['DEAL_LIST_REQ'],
        {
            'ctidTraderAccountId': self.ctid_trader_account_id,
            'fromTimestamp': now_ms - seven_days_ms,
            'toTimestamp': now_ms,
        },
        PAYLOAD['DEAL_LIST_RES'],
    )
    for deal in res.get('deal', []):
        if int(deal.get('positionId', 0)) != int(ticket):
            continue
        if deal.get('closePositionDetail') is None:
            continue
        cpd = deal['closePositionDetail']
        sym_id = int(deal.get('symbolId', 0))
        sym = self._our_symbol_from_id(sym_id)
        return {
            'ticket': int(ticket),
            'closePrice': self._from_ctrader_price(sym, int(cpd.get('executionPrice', 0))),
            'closeTime': str(deal.get('executionTimestamp', 0)),
            'pnl': int(cpd.get('grossProfit', 0)) / 100.0,
            'commission': int(deal.get('commission', 0)) / 100.0,
            'swap': int(cpd.get('swap', 0)) / 100.0,
            'reason': cpd.get('closeReason', 'UNKNOWN'),
        }
    return None
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pytest test_ctrader_client.py -v`
Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/ctrader_client.py services/execution-service/test_ctrader_client.py
git commit -m "feat(execution-service): CTraderClient get_positions / get_account_info / close_info

ProtoOA Reconcile + Trader + DealList queries. Reconcile populates the
position->symbol cache used by modify_position."
```

---

### Task 8: CTraderClient — `_with_reconnect` + lazy token refresh

**Files:**
- Modify: `services/execution-service/ctrader_client.py`
- Create: `services/execution-service/test_ctrader_reconnect.py`

- [ ] **Step 1: Write failing tests**

Create `services/execution-service/test_ctrader_reconnect.py`:

```python
import asyncio
import pytest
import time
from unittest.mock import AsyncMock, patch
from ctrader_client import CTraderClient
from ctrader_protocol import CTraderApiError


async def test_refresh_token_called_when_near_expiry(monkeypatch):
    c = CTraderClient(access_token='old', refresh_token='r1', ctid_trader_account_id=1,
                      expires_at=int(time.time()) + 30, account_kind='DEMO')  # expires in 30s
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


async def test_no_refresh_when_token_far_from_expiry(monkeypatch):
    c = CTraderClient(access_token='ok', refresh_token='r', ctid_trader_account_id=1,
                      expires_at=int(time.time()) + 3600, account_kind='DEMO')
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
        def raise_for_status(self): pass

    async def fake_post(url, data=None):
        return FakeResp()

    monkeypatch.setenv('CTRADER_CLIENT_ID', 'cid'); monkeypatch.setenv('CTRADER_CLIENT_SECRET', 'csec')
    monkeypatch.setenv('CTRADER_TOKEN_URL', 'https://x/token')
    monkeypatch.setattr('ctrader_client._async_post_form', fake_post)

    await c._refresh_token()
    assert c.access_token == 'new'
    assert c.refresh_token == 'r2'
    assert len(persisted) == 1
    assert persisted[0]['accessToken'] == 'new'


async def test_with_reconnect_retries_once_on_auth_failure(monkeypatch):
    c = CTraderClient(access_token='a', refresh_token='r', ctid_trader_account_id=1,
                      expires_at=int(time.time()) + 3600, account_kind='DEMO')
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
```

- [ ] **Step 2: Run — expect AttributeError**

Run: `pytest test_ctrader_reconnect.py -v`
Expected: failures with `AttributeError: 'CTraderClient' object has no attribute '_ensure_fresh_token'`.

- [ ] **Step 3: Add an `_async_post_form` helper + the refresh/reconnect methods**

In `ctrader_client.py`, add an import at the top:

```python
import httpx
```

Add at module scope (below imports, above the class):

```python
async def _async_post_form(url: str, data: Dict[str, str]) -> httpx.Response:
    async with httpx.AsyncClient(timeout=10.0) as client:
        return await client.post(url, data=data)
```

Add these methods to `CTraderClient` (just before the `close` method):

```python
async def _ensure_fresh_token(self) -> None:
    """Refresh proactively if token expires in <60s."""
    if self.expires_at > 0 and self.expires_at - int(time.time()) < 60:
        await self._refresh_token()

async def _refresh_token(self) -> None:
    client_id = os.getenv('CTRADER_CLIENT_ID')
    client_secret = os.getenv('CTRADER_CLIENT_SECRET')
    token_url = os.getenv('CTRADER_TOKEN_URL', 'https://openapi.ctrader.com/apps/token')
    if not client_id or not client_secret:
        raise RuntimeError('CTRADER_CLIENT_ID/SECRET required for refresh')
    res = await _async_post_form(token_url, {
        'grant_type': 'refresh_token',
        'refresh_token': self.refresh_token,
        'client_id': client_id,
        'client_secret': client_secret,
    })
    res.raise_for_status()
    body = res.json()
    self.access_token = body['accessToken']
    self.refresh_token = body['refreshToken']
    self.expires_at = int(time.time()) + int(body.get('expiresIn', 0))
    _logger.info(f'CTraderClient: refreshed token for account={self.ctid_trader_account_id} '
                 f'(expires in {body.get("expiresIn", 0)}s)')
    if self._on_token_refresh:
        await self._on_token_refresh({
            'accessToken': self.access_token,
            'refreshToken': self.refresh_token,
            'expiresAt': self.expires_at,
        })

async def _reconnect(self) -> None:
    """Close current transport + start fresh. Used by _with_reconnect on auth/transport failure."""
    if self._heartbeat_task:
        self._heartbeat_task.cancel()
        self._heartbeat_task = None
    if self._transport:
        try:
            await self._transport.close()
        except Exception:
            pass
        self._transport = None
    await self.initialize()

async def _with_reconnect(
    self,
    op_name: str,
    fn: Callable[[], Awaitable[T]],
    max_attempts: int = 5,
) -> T:
    """Run fn with exponential backoff retry on auth/transport failure.
    On CH_CLIENT_AUTH_FAILURE → refresh token + reconnect + retry once."""
    delay = 1.0
    last_exc: Optional[Exception] = None
    for attempt in range(max_attempts):
        try:
            await self._ensure_fresh_token()
            return await fn()
        except CTraderApiError as e:
            last_exc = e
            if e.code == 'CH_CLIENT_AUTH_FAILURE':
                _logger.warning(f'{op_name}: auth failure → refresh + reconnect')
                await self._refresh_token()
                await self._reconnect()
                # Retry IMMEDIATELY after fresh auth (don't burn the backoff window)
                continue
            raise  # non-auth API errors are not retryable
        except Exception as e:
            last_exc = e
            _logger.warning(f'{op_name} attempt {attempt + 1}/{max_attempts} failed: {e}')
            if attempt < max_attempts - 1:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 16.0)
                await self._reconnect()
    raise last_exc or RuntimeError(f'{op_name}: max attempts exceeded')
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pytest test_ctrader_reconnect.py -v`
Expected: all 4 pass.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/ctrader_client.py services/execution-service/test_ctrader_reconnect.py
git commit -m "feat(execution-service): CTraderClient lazy token refresh + _with_reconnect

Proactive refresh when expiresAt < now+60s, reactive refresh+retry on
CH_CLIENT_AUTH_FAILURE. _with_reconnect mirrors MetaApiMT5 backoff (1s, 2s, 4s, 8s, 16s).
Refresh persists tokens via on_token_refresh callback (wired in NestJS in later tasks)."
```

---

### Task 9: NestJS — BrokerAccountsService `create()` metadata + `updateCreds()`

**Files:**
- Modify: `src/broker-accounts/broker-accounts.service.ts`
- Modify: `src/broker-accounts/broker-accounts.service.spec.ts`
- Modify: `src/broker-accounts/dto/create-broker-account.dto.ts`

- [ ] **Step 1: Update DTO to discriminated shape**

Replace `src/broker-accounts/dto/create-broker-account.dto.ts` with:

```typescript
import { IsString, IsOptional, IsBoolean, IsIn, IsObject, ValidateNested, IsInt } from 'class-validator';
import { Type } from 'class-transformer';
import { MetaApiCredsDto } from './broker-creds.dto';

export class CreateBrokerAccountDto {
  @IsString()
  name!: string;

  @IsIn(['METAAPI', 'MOCK', 'CTRADER'])
  broker!: 'METAAPI' | 'MOCK' | 'CTRADER';

  @IsIn(['metaapi', 'mock'])
  mode!: 'metaapi' | 'mock';

  // Present for METAAPI + MOCK. For CTRADER use oauthSessionId + ctidTraderAccountId instead.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MetaApiCredsDto)
  creds?: MetaApiCredsDto;

  // CTRADER finalization shape
  @IsOptional()
  @IsString()
  oauthSessionId?: string;

  @IsOptional()
  @IsInt()
  ctidTraderAccountId?: number;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
```

- [ ] **Step 2: Update `BrokerAccountsService.create()`**

In `src/broker-accounts/broker-accounts.service.ts`, replace the `create()` method (and append `updateCreds()`):

```typescript
async create(userId: string, dto: CreateBrokerAccountDto, extra?: {
  encryptedCredsJson: string;       // already-serialized JSON for CTRADER (from BrokerOAuthService)
  accountNumber?: string;
  accountKind?: 'DEMO' | 'LIVE';
  brokerName?: string;
  oauthExpiresAt?: Date;
}) {
  // Soft cap check (unchanged)
  const enabled = await this.prisma.brokerAccount.count({
    where: { userId, isEnabled: true },
  });
  const cap = parseInt(process.env.MULTI_ACCOUNT_SOFT_CAP ?? '5', 10);
  if (dto.isEnabled && enabled >= cap) {
    throw new BadRequestException(`Maximum ${cap} enabled accounts per user`);
  }

  // Resolve creds JSON: CTRADER uses pre-serialized JSON from OAuth service;
  // METAAPI/MOCK take the plain dto.creds object.
  let credsJson: string;
  if (dto.broker === 'CTRADER') {
    if (!extra?.encryptedCredsJson) {
      throw new BadRequestException('CTRADER accounts must be created via the OAuth flow');
    }
    credsJson = extra.encryptedCredsJson;
  } else {
    if (!dto.creds) {
      throw new BadRequestException(`${dto.broker} accounts require a creds object`);
    }
    credsJson = JSON.stringify(dto.creds);
  }

  const { ciphertext, iv, authTag } = this.crypto.encrypt(credsJson);
  return this.prisma.brokerAccount.create({
    data: {
      userId,
      name: dto.name,
      broker: dto.broker,
      mode: dto.mode,
      encryptedCreds: ciphertext,
      credsIv: iv,
      credsAuthTag: authTag,
      isEnabled: dto.isEnabled ?? false,
      accountNumber: extra?.accountNumber ?? null,
      accountKind: extra?.accountKind ?? null,
      brokerName: extra?.brokerName ?? null,
      oauthExpiresAt: extra?.oauthExpiresAt ?? null,
    },
  });
}

async updateCreds(accountId: string, credsJson: string, oauthExpiresAt?: Date) {
  const { ciphertext, iv, authTag } = this.crypto.encrypt(credsJson);
  return this.prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      encryptedCreds: ciphertext,
      credsIv: iv,
      credsAuthTag: authTag,
      ...(oauthExpiresAt ? { oauthExpiresAt } : {}),
    },
  });
}
```

(Existing methods `findAllForUser`, `findOneForUser`, `findByIdWithCreds`, `update`, `delete` stay untouched.)

- [ ] **Step 3: Add unit tests**

In `src/broker-accounts/broker-accounts.service.spec.ts`, append to the existing `describe('BrokerAccountsService', ...)` block:

```typescript
describe('create — CTRADER path', () => {
  it('rejects CTRADER without pre-serialized creds', async () => {
    await expect(
      service.create('u1', { name: 'x', broker: 'CTRADER', mode: 'metaapi' } as any),
    ).rejects.toThrow(/OAuth flow/);
  });

  it('persists CTRADER with metadata + encrypted creds', async () => {
    crypto.encrypt = jest.fn(() => ({
      ciphertext: Buffer.from('ct'), iv: Buffer.from('iv'), authTag: Buffer.from('at'),
    })) as any;
    prisma.brokerAccount.count = jest.fn(async () => 0) as any;
    prisma.brokerAccount.create = jest.fn(async ({ data }) => ({ id: 'new-id', ...data })) as any;

    await service.create(
      'u1',
      { name: 'ICM Demo', broker: 'CTRADER', mode: 'metaapi', isEnabled: true },
      {
        encryptedCredsJson: JSON.stringify({ accessToken: 'a', refreshToken: 'r', ctidTraderAccountId: 42, expiresAt: 1 }),
        accountNumber: '5286',
        accountKind: 'DEMO',
        brokerName: 'IC Markets',
        oauthExpiresAt: new Date('2026-07-01'),
      },
    );

    const createArg = (prisma.brokerAccount.create as jest.Mock).mock.calls[0][0].data;
    expect(createArg.broker).toBe('CTRADER');
    expect(createArg.accountNumber).toBe('5286');
    expect(createArg.accountKind).toBe('DEMO');
    expect(createArg.brokerName).toBe('IC Markets');
    expect(createArg.oauthExpiresAt).toEqual(new Date('2026-07-01'));
  });
});

describe('updateCreds', () => {
  it('encrypts and updates the row', async () => {
    crypto.encrypt = jest.fn(() => ({
      ciphertext: Buffer.from('c2'), iv: Buffer.from('i2'), authTag: Buffer.from('a2'),
    })) as any;
    prisma.brokerAccount.update = jest.fn(async ({ data }) => data) as any;

    await service.updateCreds(
      'acct-1',
      JSON.stringify({ accessToken: 'NEW', refreshToken: 'r2', ctidTraderAccountId: 42, expiresAt: 9 }),
      new Date('2026-07-02'),
    );

    expect(prisma.brokerAccount.update).toHaveBeenCalledWith({
      where: { id: 'acct-1' },
      data: expect.objectContaining({
        encryptedCreds: expect.any(Buffer),
        oauthExpiresAt: new Date('2026-07-02'),
      }),
    });
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm jest src/broker-accounts/broker-accounts.service.spec.ts`
Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add src/broker-accounts/broker-accounts.service.ts src/broker-accounts/broker-accounts.service.spec.ts src/broker-accounts/dto/create-broker-account.dto.ts
git commit -m "feat(broker-accounts): extend create() with CTRADER metadata, add updateCreds()

create() accepts an extra arg with pre-serialized creds JSON + metadata
(accountNumber, accountKind, brokerName, oauthExpiresAt). updateCreds re-encrypts
and stores refreshed OAuth tokens — called by BrokerOAuthController in next task."
```

---

### Task 10: NestJS — BrokerOAuthService

**Files:**
- Create: `src/broker-accounts/oauth/broker-oauth.service.ts`
- Create: `src/broker-accounts/oauth/broker-oauth.service.spec.ts`

- [ ] **Step 1: Write the service**

Create `src/broker-accounts/oauth/broker-oauth.service.ts`:

```typescript
import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@app/redis';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { BrokerAccountsService } from '../broker-accounts.service';

interface SpotwareAccount {
  ctidTraderAccountId: number;
  accountNumber: string;
  live: boolean;
  brokerTitle?: string;
  brokerName?: string;
}

interface SpotwareSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accounts: SpotwareAccount[];
}

@Injectable()
export class BrokerOAuthService {
  private readonly logger = new Logger(BrokerOAuthService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly accounts: BrokerAccountsService,
  ) {}

  async startOAuth(userId: string): Promise<{ authUrl: string; state: string }> {
    const state = randomBytes(32).toString('base64url');
    await this.redis.setex(
      `oauth:ct:state:${state}`,
      600,
      JSON.stringify({ userId, createdAt: Date.now() }),
    );
    const authBase = this.config.get<string>('CTRADER_AUTH_BASE_URL') ?? 'https://connect.spotware.com';
    const u = new URL(`${authBase}/apps/auth`);
    u.searchParams.set('client_id', this.config.getOrThrow<string>('CTRADER_CLIENT_ID'));
    u.searchParams.set('redirect_uri', this.config.getOrThrow<string>('CTRADER_REDIRECT_URI'));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'trading');
    u.searchParams.set('state', state);
    return { authUrl: u.toString(), state };
  }

  async handleCallback(code: string, state: string): Promise<{ sessionId: string; accounts: SpotwareAccount[] }> {
    const raw = await this.redis.get(`oauth:ct:state:${state}`);
    if (!raw) throw new BadRequestException('OAuth state expired or invalid');
    const { userId } = JSON.parse(raw);
    await this.redis.del(`oauth:ct:state:${state}`);

    const tokens = await this.exchangeCodeForTokens(code);
    const accounts = await this.fetchTradingAccounts(tokens.accessToken);

    const sessionId = randomBytes(16).toString('base64url');
    const session: SpotwareSession = {
      userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      accounts,
    };
    await this.redis.setex(`oauth:ct:session:${sessionId}`, 1800, JSON.stringify(session));
    return { sessionId, accounts };
  }

  async finalize(
    userId: string,
    oauthSessionId: string,
    ctidTraderAccountId: number,
    name: string,
    isEnabled: boolean,
  ) {
    const raw = await this.redis.get(`oauth:ct:session:${oauthSessionId}`);
    if (!raw) throw new BadRequestException('OAuth session expired or invalid');
    const session = JSON.parse(raw) as SpotwareSession;
    if (session.userId !== userId) throw new ForbiddenException();

    const account = session.accounts.find((a) => a.ctidTraderAccountId === ctidTraderAccountId);
    if (!account) throw new BadRequestException('ctidTraderAccountId not in OAuth session');

    const credsJson = JSON.stringify({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      ctidTraderAccountId,
      expiresAt: session.expiresAt,
      accountKind: account.live ? 'LIVE' : 'DEMO',
    });

    const created = await this.accounts.create(
      userId,
      {
        name,
        broker: 'CTRADER',
        mode: 'metaapi', // 'mode' field is vestigial — anything non-'mock' triggers live dispatch
        isEnabled,
      },
      {
        encryptedCredsJson: credsJson,
        accountNumber: String(account.accountNumber),
        accountKind: account.live ? 'LIVE' : 'DEMO',
        brokerName: account.brokerName ?? account.brokerTitle ?? null,
        oauthExpiresAt: new Date(session.expiresAt * 1000),
      },
    );

    await this.redis.del(`oauth:ct:session:${oauthSessionId}`);
    return created;
  }

  async storeRefreshedTokens(
    accountId: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: number },
  ) {
    const acct = await this.accounts.findByIdWithCreds(accountId);
    // Merge: keep ctidTraderAccountId + accountKind from existing creds
    const existing = JSON.parse(
      (await import('../../crypto/crypto.service'))
        .CryptoService.prototype.decrypt.call(this.accounts['crypto'],
          Buffer.from(acct.encryptedCreds), Buffer.from(acct.credsIv), Buffer.from(acct.credsAuthTag)),
    );
    const merged = JSON.stringify({
      ...existing,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    await this.accounts.updateCreds(accountId, merged, new Date(tokens.expiresAt * 1000));
  }

  private async exchangeCodeForTokens(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    const tokenUrl = this.config.get<string>('CTRADER_TOKEN_URL') ?? 'https://openapi.ctrader.com/apps/token';
    const res = await firstValueFrom(
      this.http.post(tokenUrl, new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.getOrThrow<string>('CTRADER_REDIRECT_URI'),
        client_id: this.config.getOrThrow<string>('CTRADER_CLIENT_ID'),
        client_secret: this.config.getOrThrow<string>('CTRADER_CLIENT_SECRET'),
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    const body = res.data as { accessToken: string; refreshToken: string; expiresIn: number };
    return {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + body.expiresIn,
    };
  }

  private async fetchTradingAccounts(accessToken: string): Promise<SpotwareAccount[]> {
    const accountsUrl = this.config.get<string>('CTRADER_ACCOUNTS_URL') ?? 'https://api.spotware.com/connect/tradingaccounts';
    const res = await firstValueFrom(
      this.http.get<{ data: SpotwareAccount[] }>(accountsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return res.data.data ?? [];
  }
}
```

> **Note on `storeRefreshedTokens` decrypt hack:** the inline `require` is ugly because `BrokerAccountsService` doesn't expose a `decrypt` helper. **Cleaner refactor:** add `decryptCreds(id)` method on `BrokerAccountsService` returning the parsed object. Do that in Step 2 below instead of the hack above.

- [ ] **Step 2: Clean up — add `decryptCreds()` to BrokerAccountsService**

In `src/broker-accounts/broker-accounts.service.ts`, append a public method:

```typescript
async decryptCreds(accountId: string): Promise<Record<string, unknown>> {
  const acct = await this.findByIdWithCreds(accountId);
  const json = this.crypto.decrypt(
    Buffer.from(acct.encryptedCreds),
    Buffer.from(acct.credsIv),
    Buffer.from(acct.credsAuthTag),
  );
  return JSON.parse(json);
}
```

Then replace the hacky `storeRefreshedTokens` body with:

```typescript
async storeRefreshedTokens(
  accountId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
) {
  const existing = await this.accounts.decryptCreds(accountId);
  const merged = JSON.stringify({
    ...existing,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  await this.accounts.updateCreds(accountId, merged, new Date(tokens.expiresAt * 1000));
}
```

- [ ] **Step 3: Write the unit test**

Create `src/broker-accounts/oauth/broker-oauth.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { RedisService } from '@app/redis';
import { BrokerOAuthService } from './broker-oauth.service';
import { BrokerAccountsService } from '../broker-accounts.service';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => { store.delete(k); }),
    _store: store,
  };
}

describe('BrokerOAuthService', () => {
  let svc: BrokerOAuthService;
  let redis: ReturnType<typeof makeRedis>;
  let accounts: jest.Mocked<Partial<BrokerAccountsService>>;
  let http: jest.Mocked<Partial<HttpService>>;
  let config: jest.Mocked<Partial<ConfigService>>;

  beforeEach(async () => {
    redis = makeRedis();
    accounts = { create: jest.fn(), updateCreds: jest.fn(), decryptCreds: jest.fn() };
    http = { post: jest.fn(), get: jest.fn() };
    config = {
      get: jest.fn((k: string) => ({
        CTRADER_AUTH_BASE_URL: 'https://connect.spotware.com',
        CTRADER_TOKEN_URL: 'https://openapi.ctrader.com/apps/token',
        CTRADER_ACCOUNTS_URL: 'https://api.spotware.com/connect/tradingaccounts',
      } as any)[k]),
      getOrThrow: jest.fn((k: string) => ({
        CTRADER_CLIENT_ID: 'cid', CTRADER_CLIENT_SECRET: 'csec',
        CTRADER_REDIRECT_URI: 'https://app.shamarx.com/oauth/ctrader/callback',
      } as any)[k]),
    };

    const mod = await Test.createTestingModule({
      providers: [
        BrokerOAuthService,
        { provide: RedisService, useValue: redis },
        { provide: HttpService, useValue: http },
        { provide: ConfigService, useValue: config },
        { provide: BrokerAccountsService, useValue: accounts },
      ],
    }).compile();
    svc = mod.get(BrokerOAuthService);
  });

  describe('startOAuth', () => {
    it('returns a Spotware authUrl with state stored in Redis', async () => {
      const { authUrl, state } = await svc.startOAuth('user-1');
      expect(authUrl).toContain('connect.spotware.com/apps/auth');
      expect(authUrl).toContain(`state=${state}`);
      expect(authUrl).toContain('client_id=cid');
      expect(redis.setex).toHaveBeenCalledWith(
        `oauth:ct:state:${state}`,
        600,
        expect.stringContaining('"userId":"user-1"'),
      );
    });
  });

  describe('handleCallback', () => {
    it('rejects unknown state', async () => {
      await expect(svc.handleCallback('code', 'unknown')).rejects.toThrow(/expired or invalid/);
    });

    it('exchanges code, fetches accounts, stores session', async () => {
      await redis.setex('oauth:ct:state:S1', 600, JSON.stringify({ userId: 'u1' }));
      (http.post as jest.Mock).mockReturnValue(of({
        data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 },
      }));
      (http.get as jest.Mock).mockReturnValue(of({
        data: { data: [
          { ctidTraderAccountId: 1, accountNumber: '111', live: false, brokerName: 'IC' },
          { ctidTraderAccountId: 2, accountNumber: '222', live: true, brokerName: 'IC' },
        ]},
      }));

      const { sessionId, accounts: list } = await svc.handleCallback('CODE', 'S1');

      expect(list).toHaveLength(2);
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(redis.del).toHaveBeenCalledWith('oauth:ct:state:S1');
      const stored = JSON.parse(redis._store.get(`oauth:ct:session:${sessionId}`)!);
      expect(stored.userId).toBe('u1');
      expect(stored.accessToken).toBe('AT');
    });
  });

  describe('finalize', () => {
    it('rejects expired session', async () => {
      await expect(svc.finalize('u1', 'missing', 1, 'name', false))
        .rejects.toThrow(/expired or invalid/);
    });

    it('rejects userId mismatch', async () => {
      await redis.setex('oauth:ct:session:S', 1800, JSON.stringify({
        userId: 'otheruser', accessToken: 'a', refreshToken: 'r', expiresAt: 0, accounts: [],
      }));
      await expect(svc.finalize('u1', 'S', 1, 'name', false)).rejects.toThrow();
    });

    it('creates BrokerAccount with full metadata and deletes session', async () => {
      const sess = {
        userId: 'u1', accessToken: 'AT', refreshToken: 'RT', expiresAt: 1700000000,
        accounts: [{ ctidTraderAccountId: 42, accountNumber: '5286', live: false, brokerName: 'IC Markets' }],
      };
      await redis.setex('oauth:ct:session:S', 1800, JSON.stringify(sess));
      (accounts.create as jest.Mock).mockResolvedValue({ id: 'new-id' });

      await svc.finalize('u1', 'S', 42, 'My ICM Demo', true);

      expect(accounts.create).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ name: 'My ICM Demo', broker: 'CTRADER', isEnabled: true }),
        expect.objectContaining({
          accountNumber: '5286',
          accountKind: 'DEMO',
          brokerName: 'IC Markets',
        }),
      );
      expect(redis.del).toHaveBeenCalledWith('oauth:ct:session:S');
    });
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm jest src/broker-accounts/oauth/broker-oauth.service.spec.ts`
Expected: all describe blocks pass.

- [ ] **Step 5: Commit**

```bash
git add src/broker-accounts/oauth/ src/broker-accounts/broker-accounts.service.ts
git commit -m "feat(broker-accounts): BrokerOAuthService — Spotware OAuth state machine

startOAuth → handleCallback → finalize, with Redis state (10min) and session
(30min) TTLs. Token exchange + accounts fetch via Spotware HTTP. Refreshed
tokens persisted via BrokerAccountsService.decryptCreds + updateCreds."
```

---

### Task 11: NestJS — BrokerOAuthController + module wiring

**Files:**
- Create: `src/broker-accounts/oauth/broker-oauth.controller.ts`
- Create: `src/broker-accounts/oauth/broker-oauth.controller.spec.ts`
- Create: `src/broker-accounts/oauth/dto/callback.dto.ts`
- Create: `src/broker-accounts/oauth/dto/finalize-oauth.dto.ts`
- Modify: `src/broker-accounts/broker-accounts.module.ts`

- [ ] **Step 1: Create DTOs**

Create `src/broker-accounts/oauth/dto/callback.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class CallbackDto {
  @IsString()
  code!: string;

  @IsString()
  state!: string;
}
```

Create `src/broker-accounts/oauth/dto/finalize-oauth.dto.ts`:

```typescript
import { IsString, IsInt, IsBoolean, IsOptional } from 'class-validator';

export class FinalizeOAuthDto {
  @IsString()
  oauthSessionId!: string;

  @IsInt()
  ctidTraderAccountId!: number;

  @IsString()
  name!: string;

  @IsBoolean()
  @IsOptional()
  isEnabled?: boolean;
}
```

- [ ] **Step 2: Create the controller**

Create `src/broker-accounts/oauth/broker-oauth.controller.ts`:

```typescript
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { BrokerOAuthService } from './broker-oauth.service';
import { CallbackDto } from './dto/callback.dto';
import { FinalizeOAuthDto } from './dto/finalize-oauth.dto';

@Controller('api/broker-accounts/ctrader')
export class BrokerOAuthController {
  constructor(private readonly oauth: BrokerOAuthService) {}

  @Get('oauth/start')
  @UseGuards(JwtAuthGuard)
  start(@CurrentUser('id') userId: string) {
    return this.oauth.startOAuth(userId);
  }

  /** Public — state validated by Redis lookup. */
  @Post('callback')
  callback(@Body() dto: CallbackDto) {
    return this.oauth.handleCallback(dto.code, dto.state);
  }

  @Post('finalize')
  @UseGuards(JwtAuthGuard)
  finalize(@CurrentUser('id') userId: string, @Body() dto: FinalizeOAuthDto) {
    return this.oauth.finalize(userId, dto.oauthSessionId, dto.ctidTraderAccountId, dto.name, dto.isEnabled ?? false);
  }
}
```

- [ ] **Step 3: Update the module**

Replace `src/broker-accounts/broker-accounts.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '@app/prisma';
import { RedisModule } from '@app/redis';
import { CryptoModule } from '../crypto/crypto.module';
import { BrokerAccountsService } from './broker-accounts.service';
import { BrokerAccountsController } from './broker-accounts.controller';
import { BrokerOAuthService } from './oauth/broker-oauth.service';
import { BrokerOAuthController } from './oauth/broker-oauth.controller';

@Module({
  imports: [PrismaModule, CryptoModule, RedisModule, HttpModule],
  controllers: [BrokerAccountsController, BrokerOAuthController],
  providers: [BrokerAccountsService, BrokerOAuthService],
  exports: [BrokerAccountsService, BrokerOAuthService],
})
export class BrokerAccountsModule {}
```

> **Verify before continuing:** if `@app/redis` doesn't export a `RedisModule` (some setups expose only `RedisService` registered globally), check how `CandleService` imports `RedisService` (file path was reported in pre-exploration as `src/market-data/candle.service.ts`). Mirror that pattern in this module — adjust the import block accordingly (e.g. `RedisModule.register()` if a factory pattern is used).

- [ ] **Step 4: Write controller test**

Create `src/broker-accounts/oauth/broker-oauth.controller.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { BrokerOAuthController } from './broker-oauth.controller';
import { BrokerOAuthService } from './broker-oauth.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

describe('BrokerOAuthController', () => {
  let ctrl: BrokerOAuthController;
  let svc: jest.Mocked<Partial<BrokerOAuthService>>;

  beforeEach(async () => {
    svc = { startOAuth: jest.fn(), handleCallback: jest.fn(), finalize: jest.fn() };
    const mod = await Test.createTestingModule({
      controllers: [BrokerOAuthController],
      providers: [{ provide: BrokerOAuthService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    ctrl = mod.get(BrokerOAuthController);
  });

  it('GET /api/broker-accounts/ctrader/oauth/start delegates to service', async () => {
    (svc.startOAuth as jest.Mock).mockResolvedValue({ authUrl: 'X', state: 'S' });
    const res = await ctrl.start('u1');
    expect(svc.startOAuth).toHaveBeenCalledWith('u1');
    expect(res.authUrl).toBe('X');
  });

  it('POST /api/broker-accounts/ctrader/callback delegates to service', async () => {
    (svc.handleCallback as jest.Mock).mockResolvedValue({ sessionId: 'S', accounts: [] });
    await ctrl.callback({ code: 'CODE', state: 'STATE' });
    expect(svc.handleCallback).toHaveBeenCalledWith('CODE', 'STATE');
  });

  it('POST /api/broker-accounts/ctrader/finalize delegates with userId', async () => {
    (svc.finalize as jest.Mock).mockResolvedValue({ id: 'new-id' });
    await ctrl.finalize('u1', {
      oauthSessionId: 'S', ctidTraderAccountId: 42, name: 'X', isEnabled: true,
    });
    expect(svc.finalize).toHaveBeenCalledWith('u1', 'S', 42, 'X', true);
  });
});
```

- [ ] **Step 5: Run + boot the app**

Run: `pnpm jest src/broker-accounts/oauth/`
Expected: both spec files pass.

Run: `pnpm build:backend`
Expected: TypeScript compiles. (Module wiring verified.)

- [ ] **Step 6: Commit**

```bash
git add src/broker-accounts/oauth/ src/broker-accounts/broker-accounts.module.ts
git commit -m "feat(broker-accounts): BrokerOAuthController — start/callback/finalize endpoints

GET /api/broker-accounts/ctrader/oauth/start (JWT)
POST /api/broker-accounts/ctrader/callback (public, state-checked)
POST /api/broker-accounts/ctrader/finalize (JWT) — creates the BrokerAccount."
```

---

### Task 12: NestJS — Internal `PATCH /:id/oauth-tokens` endpoint

**Files:**
- Modify: `src/broker-accounts/broker-accounts.controller.ts`
- Create: `src/broker-accounts/oauth/dto/oauth-tokens.dto.ts`
- Create: `src/broker-accounts/oauth/guards/internal-ip.guard.ts`

- [ ] **Step 1: Create the DTO**

Create `src/broker-accounts/oauth/dto/oauth-tokens.dto.ts`:

```typescript
import { IsString, IsInt } from 'class-validator';

export class OAuthTokensDto {
  @IsString()
  accessToken!: string;

  @IsString()
  refreshToken!: string;

  @IsInt()
  expiresAt!: number;
}
```

- [ ] **Step 2: Create the internal-IP guard**

Create `src/broker-accounts/oauth/guards/internal-ip.guard.ts`:

```typescript
import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Request } from 'express';

/** Allows requests only from internal docker-compose subnets or 127.0.0.1.
 *  The execution-service container reaches NestJS over docker's default bridge
 *  (172.16.0.0/12) or the project-named network. */
@Injectable()
export class InternalIpGuard implements CanActivate {
  private readonly logger = new Logger(InternalIpGuard.name);

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = (req.ip ?? '').replace('::ffff:', '');  // strip IPv4-mapped-IPv6 prefix
    const ok =
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip);  // 172.16.0.0/12
    if (!ok) {
      this.logger.warn(`InternalIpGuard: rejected request from ${ip} for ${req.url}`);
      throw new ForbiddenException('Internal-only endpoint');
    }
    return true;
  }
}
```

- [ ] **Step 3: Wire endpoint into BrokerAccountsController**

In `src/broker-accounts/broker-accounts.controller.ts`, add at the top of the imports:

```typescript
import { OAuthTokensDto } from './oauth/dto/oauth-tokens.dto';
import { InternalIpGuard } from './oauth/guards/internal-ip.guard';
import { BrokerOAuthService } from './oauth/broker-oauth.service';
```

In the constructor, inject `BrokerOAuthService`:

```typescript
constructor(
  private readonly service: BrokerAccountsService,
  private readonly oauth: BrokerOAuthService,  // ADD
) {}
```

Append a new route method to the class:

```typescript
@Patch(':id/oauth-tokens')
@UseGuards(InternalIpGuard)
async updateOAuthTokens(@Param('id') id: string, @Body() dto: OAuthTokensDto) {
  await this.oauth.storeRefreshedTokens(id, dto);
  return { ok: true };
}
```

(Make sure `@Patch` and `@Param` are imported from `@nestjs/common` — they likely already are; if not, add to the import line.)

- [ ] **Step 4: Add a controller test for the new route**

In `src/broker-accounts/broker-accounts.controller.spec.ts`, append:

```typescript
describe('PATCH /:id/oauth-tokens', () => {
  it('delegates to BrokerOAuthService.storeRefreshedTokens', async () => {
    const oauth = { storeRefreshedTokens: jest.fn() };
    // Re-create module with InternalIpGuard bypassed
    const mod = await Test.createTestingModule({
      controllers: [BrokerAccountsController],
      providers: [
        { provide: BrokerAccountsService, useValue: service },
        { provide: BrokerOAuthService, useValue: oauth },
      ],
    })
      .overrideGuard(InternalIpGuard).useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
      .compile();
    const c = mod.get(BrokerAccountsController);

    await c.updateOAuthTokens('acct-1', {
      accessToken: 'NEW', refreshToken: 'R2', expiresAt: 9999999,
    });

    expect(oauth.storeRefreshedTokens).toHaveBeenCalledWith('acct-1', {
      accessToken: 'NEW', refreshToken: 'R2', expiresAt: 9999999,
    });
  });
});
```

Make sure to import `BrokerOAuthService` and `InternalIpGuard` at the top of the spec file.

- [ ] **Step 5: Run tests**

Run: `pnpm jest src/broker-accounts/`
Expected: all broker-account specs pass.

- [ ] **Step 6: Commit**

```bash
git add src/broker-accounts/
git commit -m "feat(broker-accounts): internal PATCH /:id/oauth-tokens for token refresh

Called by Python CTraderClient when it lazily refreshes OAuth tokens.
InternalIpGuard restricts to docker subnets + loopback."
```

---

### Task 13: NestJS — `BrokerHttpClient` X-Broker header

**Files:**
- Modify: `src/strategy/live/broker-http-client.ts`

- [ ] **Step 1: Update `credsOpts`**

Replace the `credsOpts` method (lines 27-40) in `src/strategy/live/broker-http-client.ts`:

```typescript
private async credsOpts(accountId: string): Promise<{ headers: Record<string, string> }> {
  const acct = await this.accounts.findByIdWithCreds(accountId);
  const creds = this.crypto.decrypt(
    Buffer.from(acct.encryptedCreds),
    Buffer.from(acct.credsIv),
    Buffer.from(acct.credsAuthTag),
  );
  return {
    headers: {
      'X-Broker': acct.broker,           // NEW — Python registry dispatches on this
      'X-Broker-Creds': creds,
      'X-Broker-Mode': acct.mode,
    },
  };
}
```

- [ ] **Step 2: Wire the on-token-refresh callback for CTraderClient**

The execution-service `CTraderClient.from_creds()` doesn't yet know how to call back into NestJS for token refresh persistence. Fix the factory in `services/execution-service/registry.py`:

```python
def _default_factory(creds: dict, broker: str, mode: str) -> Broker:
    if mode == 'mock':
        from mock_mt5 import MockMT5
        return MockMT5()
    if broker == 'CTRADER':
        from ctrader_client import CTraderClient, make_token_refresh_callback
        account_id = creds.get('accountId') or creds.get('ctidTraderAccountId')
        callback = make_token_refresh_callback(str(account_id)) if account_id else None
        client = CTraderClient.from_creds(creds)
        client._on_token_refresh = callback
        return client
    from metaapi_mt5 import MetaApiMT5
    return MetaApiMT5.from_creds(creds)
```

`creds` arrives from `resolve_client` via the `X-Broker-Creds` header but it doesn't currently carry the BrokerAccount UUID. Fix `routes.py` `resolve_client`:

```python
async def resolve_client(
    account_id: str,                                              # ← from URL /:account_id/...
    x_broker_creds: Optional[str] = Header(None),
    x_broker_mode: str = Header('metaapi'),
    x_broker: str = Header('METAAPI'),
) -> Broker:
    if not x_broker_creds:
        raise HTTPException(401, "X-Broker-Creds header required")
    try:
        creds = json.loads(x_broker_creds)
    except json.JSONDecodeError:
        raise HTTPException(400, "X-Broker-Creds must be valid JSON")
    creds['accountId'] = account_id     # ← inject for downstream callback (cTrader)
    return await registry.get_or_create(account_id, creds, x_broker, x_broker_mode)
```

And in `services/execution-service/ctrader_client.py`, append at module bottom:

```python
def make_token_refresh_callback(account_id: str) -> Callable[[Dict[str, Any]], Awaitable[None]]:
    """Returns an async callback that PATCHes refreshed tokens back to NestJS so
    they get re-encrypted into the BrokerAccount row."""
    backend_url = os.getenv('BACKEND_INTERNAL_URL', 'http://backend:3001')

    async def callback(tokens: Dict[str, Any]) -> None:
        async with httpx.AsyncClient(timeout=10.0) as http:
            res = await http.patch(
                f'{backend_url}/api/broker-accounts/{account_id}/oauth-tokens',
                json={
                    'accessToken': tokens['accessToken'],
                    'refreshToken': tokens['refreshToken'],
                    'expiresAt': int(tokens['expiresAt']),
                },
            )
            if res.status_code >= 400:
                _logger.warning(f'Token persistence failed: {res.status_code} {res.text}')

    return callback
```

- [ ] **Step 3: Update existing tests for the new header**

Open `src/strategy/live/*.spec.ts` files (if any cover `BrokerHttpClient` interactions). Add `X-Broker` to expected header assertions wherever they appear. Use:

```bash
grep -rn "X-Broker-Creds\|X-Broker-Mode" src/strategy/live/ --include="*.spec.ts"
```

For each match, ensure the test's expected headers include `'X-Broker': 'METAAPI'` (or whatever the test's mocked account has) where the assertion checks the request shape.

- [ ] **Step 4: Run + build**

Run: `pnpm jest src/strategy/live/ && pnpm build:backend`
Expected: tests pass, build clean.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/live/broker-http-client.ts services/execution-service/registry.py services/execution-service/routes.py services/execution-service/ctrader_client.py
git commit -m "feat(strategy): inject X-Broker header + wire CTrader token-refresh callback

BrokerHttpClient sends X-Broker so the Python registry can dispatch by broker.
CTraderClient registers a callback that PATCHes refreshed tokens back to
NestJS for re-encryption + persistence."
```

---

### Task 14: Web — types, API client, hooks

**Files:**
- Modify: `shamarx-web/src/lib/types.ts`
- Modify: `shamarx-web/src/lib/api-client.ts`
- Create: `shamarx-web/src/hooks/use-broker-oauth.ts`

- [ ] **Step 1: Add types**

In `shamarx-web/src/lib/types.ts`, append:

```typescript
export interface CtraderAccount {
  ctidTraderAccountId: number;
  accountNumber: string;
  live: boolean;
  brokerName?: string;
  brokerTitle?: string;
}

export interface StartOAuthResponse {
  authUrl: string;
  state: string;
}

export interface OAuthCallbackResponse {
  sessionId: string;
  accounts: CtraderAccount[];
}

export interface FinalizeOAuthInput {
  oauthSessionId: string;
  ctidTraderAccountId: number;
  name: string;
  isEnabled?: boolean;
}
```

Update `BrokerAccount` interface to add the new metadata columns (find the existing interface around line 257):

```typescript
export interface BrokerAccount {
  // existing fields...
  accountNumber?: string | null;
  accountKind?: 'DEMO' | 'LIVE' | null;
  brokerName?: string | null;
  oauthExpiresAt?: string | null;
}
```

- [ ] **Step 2: Add API client methods**

In `shamarx-web/src/lib/api-client.ts`, append (near the existing broker-account methods around line 533):

```typescript
startCtraderOAuth() {
  return request<StartOAuthResponse>('/api/broker-accounts/ctrader/oauth/start');
}

ctraderOAuthCallback(code: string, state: string) {
  return request<OAuthCallbackResponse>('/api/broker-accounts/ctrader/callback', {
    method: 'POST',
    body: JSON.stringify({ code, state }),
  });
}

finalizeCtraderOAuth(input: FinalizeOAuthInput) {
  return request<BrokerAccount>('/api/broker-accounts/ctrader/finalize', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
```

(Reuse the existing `request` helper. Adjust import block if needed.)

- [ ] **Step 3: Create the hooks file**

Create `shamarx-web/src/hooks/use-broker-oauth.ts`:

```typescript
'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { FinalizeOAuthInput } from '@/lib/types';

export function useStartCtraderOAuth() {
  return useMutation({
    mutationFn: () => apiClient.startCtraderOAuth(),
  });
}

export function useCtraderOAuthCallback() {
  return useMutation({
    mutationFn: ({ code, state }: { code: string; state: string }) =>
      apiClient.ctraderOAuthCallback(code, state),
  });
}

export function useFinalizeCtraderOAuth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: FinalizeOAuthInput) => apiClient.finalizeCtraderOAuth(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broker-accounts'] });
    },
  });
}
```

- [ ] **Step 4: Type-check**

Run: `cd shamarx-web && pnpm build`
Expected: build succeeds. If `apiClient` is exported as a class instance vs an object, adapt the method call shape to match the existing pattern (check how `listBrokerAccounts` is invoked).

- [ ] **Step 5: Commit**

```bash
git add shamarx-web/src/lib/types.ts shamarx-web/src/lib/api-client.ts shamarx-web/src/hooks/use-broker-oauth.ts
git commit -m "feat(web): types + api client + hooks for cTrader OAuth flow

useStartCtraderOAuth → returns authUrl + state.
useCtraderOAuthCallback → exchanges code for sessionId + accounts list.
useFinalizeCtraderOAuth → creates BrokerAccount, invalidates broker-accounts cache."
```

---

### Task 15: Web — `/oauth/ctrader/callback` trampoline page

**Files:**
- Create: `shamarx-web/src/app/oauth/ctrader/callback/page.tsx`

**Why client-side, not a server-side Route Handler:** the spec described it as server-side, but step 3 (account picker) needs the accounts list, and there are only two ways to hand it over after a 302: (a) re-fetch from backend via a separate GET (means tracking sessionId state server-side and adding an endpoint that exposes the session payload), or (b) write to `sessionStorage` client-side. Option (b) is one less endpoint and identical security posture (sessionId is opaque, server enforces userId at finalize-time). We pick (b).

- [ ] **Step 1: Create the trampoline page**

Create `shamarx-web/src/app/oauth/ctrader/callback/page.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCtraderOAuthCallback } from '@/hooks/use-broker-oauth';

/**
 * Client-side OAuth trampoline. Spotware redirects here with ?code=…&state=…
 * We POST to backend → get sessionId + accounts → stash accounts in
 * sessionStorage → router.replace() to wizard step 3.
 *
 * Intentionally NOT under /accounts/new/* — auth plumbing is distinct
 * from wizard URLs. This is also why the route name is reusable: a future
 * Moo Moo integration becomes /oauth/moomoo/callback with no special casing.
 */
export default function CtraderCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const cb = useCtraderOAuthCallback();

  useEffect(() => {
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    if (oauthError) {
      router.replace(`/accounts/new/connect?broker=ctrader&error=${encodeURIComponent(oauthError)}`);
      return;
    }
    if (!code || !state) {
      router.replace('/accounts/new/connect?broker=ctrader&error=missing-params');
      return;
    }

    cb.mutateAsync({ code, state })
      .then((res) => {
        sessionStorage.setItem(`ctrader-accounts:${res.sessionId}`, JSON.stringify(res.accounts));
        router.replace(`/accounts/new/pick?sid=${res.sessionId}`);
      })
      .catch((e: any) => {
        const msg = e?.message ?? 'unknown';
        router.replace(`/accounts/new/connect?broker=ctrader&error=${encodeURIComponent(msg)}`);
      });
    // Intentionally one-shot — re-running on rerenders would re-POST and fail
    // (state is single-use). eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-12 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#F2C31C] border-t-transparent" />
      <p className="text-[12px] uppercase tracking-[0.18em] text-[#8d8275]">Connecting to cTrader…</p>
    </div>
  );
}
```

- [ ] **Step 2: Verify routing**

Run: `cd shamarx-web && pnpm dev`

Open `http://localhost:3000/oauth/ctrader/callback` in a browser. Expected: spinner appears briefly, then redirects to `/accounts/new/connect?broker=ctrader&error=missing-params` (no code/state provided).

Open `http://localhost:3000/oauth/ctrader/callback?code=abc&state=xyz`. Expected: redirects to `/accounts/new/connect?broker=ctrader&error=…` because backend rejects the unknown state.

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add shamarx-web/src/app/oauth/ctrader/callback/page.tsx
git commit -m "feat(web): /oauth/ctrader/callback trampoline page

Client-side handler: POST to backend, stash accounts in sessionStorage,
router.replace into wizard step 3. Kept under /oauth/* so a future
broker like Moo Moo can mirror the path at /oauth/moomoo/callback."
```

---

### Task 16: Web — Wizard pages + shared components

**Files:**
- Create: `shamarx-web/src/components/wizard/step-strip.tsx`
- Create: `shamarx-web/src/components/wizard/broker-card.tsx`
- Create: `shamarx-web/src/components/wizard/account-row.tsx`
- Create: `shamarx-web/src/app/accounts/new/page.tsx`
- Create: `shamarx-web/src/app/accounts/new/broker/page.tsx`
- Create: `shamarx-web/src/app/accounts/new/connect/page.tsx`
- Create: `shamarx-web/src/app/accounts/new/pick/page.tsx`
- Create: `shamarx-web/src/app/accounts/new/confirm/page.tsx`
- Modify: `shamarx-web/src/app/accounts/page.tsx`

- [ ] **Step 1: Create `step-strip.tsx`**

```tsx
'use client';

import { cn } from '@/lib/utils';

interface Step {
  num: number;
  label: string;
  state: 'active' | 'done' | 'pending' | 'skipped';
}

export function StepStrip({ steps }: { steps: Step[] }) {
  return (
    <div className="flex justify-between rounded border border-[#383229] bg-[#15110c] px-4 py-3">
      {steps.map((s) => (
        <span key={s.num} className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em]">
          <span
            className={cn(
              'inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-semibold',
              s.state === 'active' && 'bg-[#F2C31C] text-[#1a1612]',
              s.state === 'done' && 'border border-[#4FD49F60] bg-[#4FD49F40] text-[#4FD49F]',
              s.state === 'pending' && 'border border-[#383229] bg-[#231f1a] text-[#5e5447]',
              s.state === 'skipped' && 'border border-dashed border-[#383229] bg-transparent text-[#5e5447]',
            )}
          >
            {s.state === 'done' ? '✓' : s.num}
          </span>
          <span className={s.state === 'pending' || s.state === 'skipped' ? 'text-[#5e5447]' : 'text-[#ece8e3]'}>
            {s.label}
          </span>
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create `broker-card.tsx`**

```tsx
'use client';

import { cn } from '@/lib/utils';

interface BrokerCardProps {
  badge: string;
  badgeTone: 'gold' | 'muted';
  title: string;
  subtitle: string;
  selected?: boolean;
  onClick: () => void;
}

export function BrokerCard({ badge, badgeTone, title, subtitle, selected, onClick }: BrokerCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex flex-col items-start gap-3 rounded border bg-[#231f1a] p-5 text-left transition-colors',
        selected ? 'border-[#F2C31C]' : 'border-[#383229] hover:border-[#5e5447]',
      )}
    >
      <span
        className={cn(
          'text-[10px] uppercase tracking-[0.14em]',
          badgeTone === 'gold' ? 'text-[#F2C31C]' : 'text-[#8d8275]',
        )}
      >
        {badge}
      </span>
      <span className="text-[16px] font-semibold text-[#ece8e3]">{title}</span>
      <span className="text-[11px] text-[#8d8275]">{subtitle}</span>
    </button>
  );
}
```

- [ ] **Step 3: Create `account-row.tsx`**

```tsx
'use client';

import { cn } from '@/lib/utils';
import type { CtraderAccount } from '@/lib/types';

interface AccountRowProps {
  account: CtraderAccount;
  selected: boolean;
  onSelect: () => void;
}

export function AccountRow({ account, selected, onSelect }: AccountRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center justify-between rounded border bg-[#231f1a] px-4 py-3 text-left transition-colors',
        selected ? 'border-[#F2C31C]' : 'border-[#383229] hover:border-[#5e5447]',
      )}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[14px] text-[#ece8e3]">{account.accountNumber}</span>
        <span className="text-[11px] text-[#8d8275]">{account.brokerName ?? account.brokerTitle ?? 'cTrader'}</span>
      </div>
      <span
        className={cn(
          'rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]',
          account.live ? 'bg-[#F26659] text-[#1a1612]' : 'bg-[#4FD49F] text-[#1a1612]',
        )}
      >
        {account.live ? 'LIVE' : 'DEMO'}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Create `app/accounts/new/page.tsx` (entry redirect)**

```tsx
import { redirect } from 'next/navigation';

export default function NewAccountIndex() {
  redirect('/accounts/new/broker');
}
```

- [ ] **Step 5: Step 1 page — pick broker**

Create `shamarx-web/src/app/accounts/new/broker/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { StepStrip } from '@/components/wizard/step-strip';
import { BrokerCard } from '@/components/wizard/broker-card';

type Broker = 'ctrader' | 'metaapi';

export default function BrokerStep() {
  const router = useRouter();
  const [picked, setPicked] = useState<Broker | null>(null);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <StepStrip steps={[
        { num: 1, label: 'Pick broker', state: 'active' },
        { num: 2, label: 'Connect', state: 'pending' },
        { num: 3, label: 'Pick account', state: 'pending' },
        { num: 4, label: 'Confirm', state: 'pending' },
      ]} />
      <div className="rounded border border-[#383229] bg-[#231f1a] p-8 text-center">
        <div className="mb-2 text-[9px] uppercase tracking-[0.18em] text-[#8d8275]">SECTION · 01 / BROKER</div>
        <h1 className="display-serif mb-5 text-[22px] tracking-[0.04em] text-[#ece8e3]">
          Choose your <span className="text-[#F2C31C]">broker</span>.
        </h1>
        <div className="mx-auto grid max-w-md grid-cols-2 gap-3 text-left">
          <BrokerCard
            badge="Recommended"
            badgeTone="gold"
            title="cTrader"
            subtitle="Direct to Spotware · free · OAuth login"
            selected={picked === 'ctrader'}
            onClick={() => setPicked('ctrader')}
          />
          <BrokerCard
            badge="Bridge"
            badgeTone="muted"
            title="MetaApi (MT5)"
            subtitle="For brokers without cTrader · paste creds"
            selected={picked === 'metaapi'}
            onClick={() => setPicked('metaapi')}
          />
        </div>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/accounts')}
            className="rounded border border-[#383229] px-5 py-2 text-[11px] uppercase tracking-[0.18em] text-[#8d8275] hover:border-[#5e5447]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!picked}
            onClick={() => router.push(`/accounts/new/connect?broker=${picked}`)}
            className="rounded bg-[#F2C31C] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1612] disabled:opacity-30"
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Step 2 page — connect**

Create `shamarx-web/src/app/accounts/new/connect/page.tsx`:

```tsx
'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StepStrip } from '@/components/wizard/step-strip';
import { useStartCtraderOAuth } from '@/hooks/use-broker-oauth';
import { useCreateBrokerAccount } from '@/hooks/use-accounts';

export default function ConnectStep() {
  const params = useSearchParams();
  const router = useRouter();
  const broker = (params.get('broker') ?? 'ctrader') as 'ctrader' | 'metaapi';
  const error = params.get('error');

  const startOAuth = useStartCtraderOAuth();
  const createAccount = useCreateBrokerAccount();

  const [maName, setMaName] = useState('');
  const [maAccountId, setMaAccountId] = useState('');
  const [maToken, setMaToken] = useState('');

  async function onCtraderStart() {
    const { authUrl } = await startOAuth.mutateAsync();
    window.location.href = authUrl;
  }

  async function onMetaApiSubmit(e: React.FormEvent) {
    e.preventDefault();
    await createAccount.mutateAsync({
      name: maName,
      broker: 'METAAPI',
      mode: 'metaapi',
      creds: { accountId: maAccountId, accessToken: maToken },
      isEnabled: false,
    });
    router.push('/accounts');
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <StepStrip steps={[
        { num: 1, label: 'Pick broker', state: 'done' },
        { num: 2, label: 'Connect', state: 'active' },
        { num: 3, label: 'Pick account', state: broker === 'metaapi' ? 'skipped' : 'pending' },
        { num: 4, label: 'Confirm', state: broker === 'metaapi' ? 'skipped' : 'pending' },
      ]} />

      {error && (
        <div className="rounded border border-[#F26659] bg-[#1a1612] p-3 text-[12px] text-[#F26659]">
          {error === 'access_denied' && 'You declined access. Try again to continue.'}
          {error === 'network' && 'Network error contacting Spotware. Please retry.'}
          {error?.startsWith('backend:') && `Backend rejected the OAuth response (${error}). Try again.`}
        </div>
      )}

      {broker === 'ctrader' ? (
        <div className="rounded border border-[#383229] bg-[#231f1a] p-8 text-center">
          <div className="mb-2 text-[9px] uppercase tracking-[0.18em] text-[#8d8275]">SECTION · 02 / CONNECT</div>
          <h1 className="display-serif mb-3 text-[22px] tracking-[0.04em] text-[#ece8e3]">
            Connect to <span className="text-[#F2C31C]">cTrader</span>.
          </h1>
          <p className="mb-6 text-[12px] text-[#8d8275]">
            Your password never touches Shamarx. You'll grant access on Spotware's site.
          </p>
          <button
            type="button"
            disabled={startOAuth.isPending}
            onClick={onCtraderStart}
            className="rounded bg-[#F2C31C] px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1612] disabled:opacity-30"
          >
            {startOAuth.isPending ? 'Redirecting…' : 'Continue to cTrader →'}
          </button>
        </div>
      ) : (
        <form onSubmit={onMetaApiSubmit} className="flex flex-col gap-4 rounded border border-[#383229] bg-[#231f1a] p-8">
          <div className="text-[9px] uppercase tracking-[0.18em] text-[#8d8275]">SECTION · 02 / METAAPI</div>
          <h1 className="display-serif text-[22px] tracking-[0.04em] text-[#ece8e3]">MetaApi credentials</h1>
          <label className="flex flex-col gap-1 text-[11px] text-[#8d8275]">
            ACCOUNT NAME
            <input required value={maName} onChange={(e) => setMaName(e.target.value)}
              className="rounded border border-[#383229] bg-[#15110c] px-3 py-2 text-[13px] text-[#ece8e3] focus:border-[#F2C31C] focus:outline-none" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[#8d8275]">
            METAAPI ACCOUNT ID
            <input required value={maAccountId} onChange={(e) => setMaAccountId(e.target.value)}
              className="rounded border border-[#383229] bg-[#15110c] px-3 py-2 font-mono text-[13px] text-[#ece8e3] focus:border-[#F2C31C] focus:outline-none" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[#8d8275]">
            ACCESS TOKEN
            <input required type="password" value={maToken} onChange={(e) => setMaToken(e.target.value)}
              className="rounded border border-[#383229] bg-[#15110c] px-3 py-2 font-mono text-[13px] text-[#ece8e3] focus:border-[#F2C31C] focus:outline-none" />
          </label>
          <button type="submit" disabled={createAccount.isPending}
            className="self-end rounded bg-[#F2C31C] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1612] disabled:opacity-30">
            {createAccount.isPending ? 'Saving…' : 'Save account →'}
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Step 3 page — pick account**

Create `shamarx-web/src/app/accounts/new/pick/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { StepStrip } from '@/components/wizard/step-strip';
import { AccountRow } from '@/components/wizard/account-row';
import type { CtraderAccount } from '@/lib/types';

export default function PickStep() {
  const params = useSearchParams();
  const router = useRouter();
  const sid = params.get('sid');

  const [accounts, setAccounts] = useState<CtraderAccount[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sid) {
      setError('Missing OAuth session. Restart the wizard.');
      return;
    }
    // Session accounts are returned by the backend POST callback. Since the
    // browser arrived via redirect we don't have that response in memory —
    // backend exposes nothing to re-fetch by sessionId for security reasons.
    // Instead we restart from step 2 (the only consequence is one extra Spotware redirect).
    //
    // Cleanest fix: have the route handler stash the JSON in a short-lived
    // signed cookie keyed by sessionId. For now, we re-issue the callback (idempotent
    // on backend — but state is already deleted, so we redirect to /accounts/new/connect
    // with an explanatory error if we get here without an in-memory accounts list).
    //
    // The intended path: step 2 calls `useCtraderOAuthCallback` after the redirect
    // returns it via window.location.href. Since this happens server-side, we use
    // sessionStorage to ferry the accounts list.
    const raw = sessionStorage.getItem(`ctrader-accounts:${sid}`);
    if (!raw) {
      setError('Session expired. Please restart the wizard.');
      return;
    }
    setAccounts(JSON.parse(raw));
  }, [sid]);

  function onContinue() {
    if (!picked || !sid) return;
    router.push(`/accounts/new/confirm?sid=${sid}&ctid=${picked}`);
  }

  if (error) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
        <div className="rounded border border-[#F26659] bg-[#1a1612] p-4 text-[12px] text-[#F26659]">{error}</div>
        <button type="button" onClick={() => router.push('/accounts/new/broker')}
          className="self-start rounded border border-[#383229] px-5 py-2 text-[11px] uppercase tracking-[0.18em]">
          Restart
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <StepStrip steps={[
        { num: 1, label: 'Pick broker', state: 'done' },
        { num: 2, label: 'Connect', state: 'done' },
        { num: 3, label: 'Pick account', state: 'active' },
        { num: 4, label: 'Confirm', state: 'pending' },
      ]} />
      <div className="rounded border border-[#383229] bg-[#231f1a] p-8">
        <div className="mb-2 text-[9px] uppercase tracking-[0.18em] text-[#8d8275]">SECTION · 03 / ACCOUNT</div>
        <h1 className="display-serif mb-5 text-[22px] tracking-[0.04em] text-[#ece8e3]">
          Pick the <span className="text-[#F2C31C]">trading account</span>.
        </h1>
        <div className="flex flex-col gap-2">
          {(accounts ?? []).map((a) => (
            <AccountRow
              key={a.ctidTraderAccountId}
              account={a}
              selected={picked === a.ctidTraderAccountId}
              onSelect={() => setPicked(a.ctidTraderAccountId)}
            />
          ))}
          {accounts?.length === 0 && (
            <p className="text-[12px] text-[#8d8275]">No trading accounts found on this Spotware login.</p>
          )}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={() => router.push('/accounts/new/connect?broker=ctrader')}
            className="rounded border border-[#383229] px-5 py-2 text-[11px] uppercase tracking-[0.18em] text-[#8d8275]">
            Back
          </button>
          <button type="button" disabled={!picked} onClick={onContinue}
            className="rounded bg-[#F2C31C] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1612] disabled:opacity-30">
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Step 4 page — confirm**

Create `shamarx-web/src/app/accounts/new/confirm/page.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { StepStrip } from '@/components/wizard/step-strip';
import { useFinalizeCtraderOAuth } from '@/hooks/use-broker-oauth';
import type { CtraderAccount } from '@/lib/types';

export default function ConfirmStep() {
  const params = useSearchParams();
  const router = useRouter();
  const sid = params.get('sid');
  const ctid = Number(params.get('ctid'));
  const [account, setAccount] = useState<CtraderAccount | null>(null);
  const [name, setName] = useState('');
  const [enable, setEnable] = useState(true);
  const finalize = useFinalizeCtraderOAuth();

  useEffect(() => {
    if (!sid) { router.replace('/accounts/new/broker'); return; }
    const raw = sessionStorage.getItem(`ctrader-accounts:${sid}`);
    if (!raw) { router.replace('/accounts/new/broker'); return; }
    const list: CtraderAccount[] = JSON.parse(raw);
    const a = list.find((x) => x.ctidTraderAccountId === ctid);
    if (!a) { router.replace(`/accounts/new/pick?sid=${sid}`); return; }
    setAccount(a);
    setName(`${a.brokerName ?? 'cTrader'} ${a.live ? 'Live' : 'Demo'}`);
  }, [sid, ctid, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!sid || !account) return;
    await finalize.mutateAsync({
      oauthSessionId: sid,
      ctidTraderAccountId: account.ctidTraderAccountId,
      name,
      isEnabled: enable,
    });
    sessionStorage.removeItem(`ctrader-accounts:${sid}`);
    router.push('/accounts');
  }

  if (!account) return null;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <StepStrip steps={[
        { num: 1, label: 'Pick broker', state: 'done' },
        { num: 2, label: 'Connect', state: 'done' },
        { num: 3, label: 'Pick account', state: 'done' },
        { num: 4, label: 'Confirm', state: 'active' },
      ]} />
      <form onSubmit={onSubmit} className="flex flex-col gap-5 rounded border border-[#383229] bg-[#231f1a] p-8">
        <div className="text-[9px] uppercase tracking-[0.18em] text-[#8d8275]">SECTION · 04 / CONFIRM</div>
        <h1 className="display-serif text-[22px] tracking-[0.04em] text-[#ece8e3]">
          Almost <span className="text-[#F2C31C]">there</span>.
        </h1>
        <dl className="grid grid-cols-2 gap-3 text-[12px]">
          <dt className="text-[#8d8275]">Broker</dt><dd className="text-[#ece8e3]">{account.brokerName ?? 'cTrader'}</dd>
          <dt className="text-[#8d8275]">Account</dt><dd className="font-mono text-[#ece8e3]">{account.accountNumber}</dd>
          <dt className="text-[#8d8275]">Kind</dt><dd className="text-[#ece8e3]">{account.live ? 'LIVE' : 'DEMO'}</dd>
        </dl>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.14em] text-[#8d8275]">
          Friendly name
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="rounded border border-[#383229] bg-[#15110c] px-3 py-2 text-[13px] text-[#ece8e3] focus:border-[#F2C31C] focus:outline-none" />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[#ece8e3]">
          <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          Enable trading on this account right away
        </label>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => router.back()}
            className="rounded border border-[#383229] px-5 py-2 text-[11px] uppercase tracking-[0.18em] text-[#8d8275]">
            Back
          </button>
          <button type="submit" disabled={finalize.isPending}
            className="rounded bg-[#F2C31C] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1612] disabled:opacity-30">
            {finalize.isPending ? 'Connecting…' : 'Connect & start →'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 9: Update `/accounts` page CTA**

In `shamarx-web/src/app/accounts/page.tsx`, find the "Add account" CTA (currently triggers `AddAccountModal`). Replace its handler with `router.push('/accounts/new')`. Leave `AddAccountModal` in place but unused — a later cleanup can remove it once the wizard is proven.

Locate the CTA — likely something like:

```tsx
<button onClick={() => setShowAdd(true)}>Add account</button>
```

Replace with:

```tsx
import Link from 'next/link';
// …
<Link href="/accounts/new" className="rounded bg-[#F2C31C] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1612]">
  Add account →
</Link>
```

- [ ] **Step 10: Smoke run**

Run: `cd shamarx-web && pnpm dev`

In a browser visit `http://localhost:3000/accounts/new` (assuming logged in). Walk through:
1. Step 1: pick "cTrader" → click Continue
2. Step 2: shows "Continue to cTrader →" CTA. **Don't click it yet** — that triggers a real Spotware redirect (we'll test the full flow in Task 18). For now just verify the screen renders.
3. Click `/accounts/new/connect?broker=metaapi` directly in the URL → MetaApi form renders.

Verify no console errors. Kill dev server.

- [ ] **Step 11: Commit**

```bash
git add shamarx-web/src/app/accounts/new/ shamarx-web/src/app/accounts/page.tsx shamarx-web/src/components/wizard/
git commit -m "feat(web): 4-step broker connect wizard at /accounts/new

Step 1 (broker), 2 (connect — cTrader OAuth CTA / MetaApi form),
3 (account picker), 4 (confirm). Reads accounts list from
sessionStorage stashed by /oauth/ctrader/callback trampoline."
```

---

### Task 17: Env vars + Terraform + runbook

**Files:**
- Modify: `.env.example`
- Modify: `.env.aws.example` (if present; otherwise document inline)
- Modify: `docs/RUNBOOK.md`
- Modify: `terraform/secrets.tf` (or wherever existing CryptoService secret is — find it first)

- [ ] **Step 1: Update `.env.example`**

Append to `.env.example`:

```
# ---- cTrader OAuth (Spec 3) ----
# Spotware app credentials. Register at https://openapi.ctrader.com/apps
# In prod, sourced from AWS Secrets Manager (BROKER_CREDS_SECRET_ID, secret key 'ctrader_oauth').
CTRADER_CLIENT_ID=
CTRADER_CLIENT_SECRET=
# Where Spotware redirects after consent. Must match app registration EXACTLY.
CTRADER_REDIRECT_URI=http://localhost:3000/oauth/ctrader/callback
# Optional overrides (defaults below match Spotware's published endpoints).
CTRADER_AUTH_BASE_URL=https://connect.spotware.com
CTRADER_TOKEN_URL=https://openapi.ctrader.com/apps/token
CTRADER_ACCOUNTS_URL=https://api.spotware.com/connect/tradingaccounts
# Internal backend URL used by the execution-service to POST back refreshed tokens.
BACKEND_INTERNAL_URL=http://backend:3001
```

- [ ] **Step 2: Find current Terraform secrets config**

Run: `find terraform -name "*.tf" | xargs grep -l "shamarx/broker-creds\|BROKER_CREDS_SECRET_ID\|aws_secretsmanager_secret" 2>/dev/null`

If found, open the file and add a new secret resource modelled on the existing one. Otherwise document the manual step in the runbook (next step). For example, add to `terraform/secrets.tf`:

```hcl
resource "aws_secretsmanager_secret" "ctrader_oauth" {
  name        = "shamarx/ctrader-oauth"
  description = "Spotware OAuth app credentials for cTrader integration (Spec 3)"
}

# IAM policy attachment — same role as existing broker-creds secret
resource "aws_iam_role_policy_attachment" "ec2_ctrader_oauth_read" {
  role       = aws_iam_role.shamarx_app.name  # adjust to match existing role name
  policy_arn = aws_iam_policy.ctrader_oauth_read.arn
}

resource "aws_iam_policy" "ctrader_oauth_read" {
  name = "shamarx-ctrader-oauth-read"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.ctrader_oauth.arn
    }]
  })
}
```

- [ ] **Step 3: Update `docs/RUNBOOK.md`**

Append a new section near the existing "Broker accounts" or "Spec 1" section:

```markdown
## cTrader OAuth (Spec 3)

### One-time Spotware app registration

1. Sign in at https://openapi.ctrader.com (use the team@shamarx.com Spotware account).
2. Apps → "Add new application".
3. Settings:
   - Name: `Shamarx`
   - Redirect URI (prod): `https://app.shamarx.com/oauth/ctrader/callback`
   - Redirect URI (dev): `http://localhost:3000/oauth/ctrader/callback`
   - Scopes: `trading`, `accounts`
4. Save `Client ID` + `Client Secret` to AWS Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id shamarx/ctrader-oauth \
     --secret-string '{"client_id":"<id>","client_secret":"<secret>"}'
   ```
5. EC2 instance role already has read access via Terraform (see `terraform/secrets.tf`).
6. Trigger a redeploy so the backend picks up the new secret.

### Verifying the flow end-to-end

1. Hit `GET /api/broker-accounts/ctrader/oauth/start` while authenticated.
2. Expect `{ authUrl, state }`. Open `authUrl` in a browser — Spotware login appears.
3. Grant consent. Spotware redirects to `/oauth/ctrader/callback?code=…&state=…`.
4. The Next.js callback page POSTs to backend, redirects to `/accounts/new/pick?sid=…`.
5. Pick an account, confirm. New BrokerAccount row appears.

### Token refresh

cTrader access tokens expire (typically 30 days). Refresh happens lazily inside
`CTraderClient._with_reconnect`:
- Proactive: when `expiresAt < now + 60s`, refresh before next request.
- Reactive: on `CH_CLIENT_AUTH_FAILURE` from Spotware, refresh + retry once.

Refreshed tokens are PATCHed to `/api/broker-accounts/:id/oauth-tokens` (internal-IP only)
so they're re-encrypted and persisted.

### Troubleshooting

- **"OAuth state expired or invalid"** — user took >10 min to return from Spotware.
  Have them restart from `/accounts/new`.
- **"This account is already connected"** — `ctidTraderAccountId` uniqueness collision.
  Check existing rows: `SELECT * FROM "BrokerAccount" WHERE "accountNumber" = ? AND broker = 'CTRADER'`.
- **Token refresh loop** — if `CH_CLIENT_AUTH_FAILURE` recurs after refresh, the
  Spotware app may have been revoked. User must re-OAuth.
```

- [ ] **Step 4: Commit**

```bash
git add .env.example terraform/ docs/RUNBOOK.md
git commit -m "docs(ctrader): env vars, Terraform secret, runbook section

Documents the one-time Spotware app registration + AWS Secrets Manager
flow and the lazy token refresh contract."
```

---

### Task 18: E2E test + smoke + handoff for production rollout

**Files:**
- Create: `test/ctrader-oauth.e2e-spec.ts`
- Modify: `docs/RUNBOOK.md` (rollout checklist)

- [ ] **Step 1: Create the e2e test**

Create `test/ctrader-oauth.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import * as request from 'supertest';
import { of } from 'rxjs';
import { AppModule } from '../src/app.module';
import { RedisService } from '@app/redis';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';

describe('cTrader OAuth (e2e)', () => {
  let app: INestApplication;
  let http: jest.Mocked<HttpService>;

  beforeAll(async () => {
    const fakeRedis = {
      _store: new Map<string, string>(),
      setex: jest.fn(function (this: any, k: string, _t: number, v: string) { this._store.set(k, v); return Promise.resolve(); }),
      get: jest.fn(function (this: any, k: string) { return Promise.resolve(this._store.get(k) ?? null); }),
      del: jest.fn(function (this: any, k: string) { this._store.delete(k); return Promise.resolve(); }),
    };
    const fakeHttp = { post: jest.fn(), get: jest.fn() };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService).useValue(fakeRedis)
      .overrideProvider(HttpService).useValue(fakeHttp)
      .overrideGuard(JwtAuthGuard).useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: 'test-user', email: 'test@example.com', role: 'USER' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
    http = moduleRef.get(HttpService) as jest.Mocked<HttpService>;
  });

  afterAll(async () => { await app.close(); });

  it('full happy path: start → callback → finalize', async () => {
    // 1. start
    const startRes = await request(app.getHttpServer())
      .get('/api/broker-accounts/ctrader/oauth/start')
      .expect(200);
    expect(startRes.body.authUrl).toContain('connect.spotware.com');
    const state = startRes.body.state;

    // 2. callback — mock Spotware
    (http.post as jest.Mock).mockReturnValueOnce(of({
      data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 },
    }));
    (http.get as jest.Mock).mockReturnValueOnce(of({
      data: { data: [
        { ctidTraderAccountId: 42, accountNumber: '52867017', live: false, brokerName: 'IC Markets' },
      ]},
    }));

    const cbRes = await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/callback')
      .send({ code: 'AUTHCODE', state })
      .expect(201);
    expect(cbRes.body.sessionId).toBeTruthy();
    expect(cbRes.body.accounts).toHaveLength(1);
    const sessionId = cbRes.body.sessionId;

    // 3. finalize
    const finRes = await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/finalize')
      .send({
        oauthSessionId: sessionId,
        ctidTraderAccountId: 42,
        name: 'My ICM Demo',
        isEnabled: false,
      })
      .expect(201);
    expect(finRes.body.id).toBeTruthy();
    expect(finRes.body.broker).toBe('CTRADER');
    expect(finRes.body.accountNumber).toBe('52867017');
    expect(finRes.body.accountKind).toBe('DEMO');
  });

  it('callback rejects unknown state', async () => {
    await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/callback')
      .send({ code: 'X', state: 'unknown' })
      .expect(400);
  });

  it('finalize rejects expired session', async () => {
    await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/finalize')
      .send({ oauthSessionId: 'missing', ctidTraderAccountId: 1, name: 'X' })
      .expect(400);
  });
});
```

- [ ] **Step 2: Run e2e**

Run: `pnpm test:e2e -- --testPathPattern=ctrader-oauth`
Expected: all 3 tests pass.

(If `AppModule` instantiation fails because of missing real services in test mode — Postgres, etc. — override the providers that touch them. The pattern from existing e2e tests in `test/` should guide you.)

- [ ] **Step 3: Append rollout checklist to runbook**

Append to `docs/RUNBOOK.md`:

```markdown
## Spec 3 production rollout checklist

- [ ] Register Spotware app, save Client ID/Secret to AWS Secrets Manager
- [ ] Terraform apply (new secret + IAM)
- [ ] Push to main → CI deploys backend + web + execution-service (auto-runs `prisma db push`)
- [ ] Verify schema changes landed: `SELECT column_name FROM information_schema.columns WHERE table_name = 'BrokerAccount' AND column_name IN ('accountNumber', 'accountKind', 'brokerName', 'oauthExpiresAt')` should return 4 rows
- [ ] Hit `/api/broker-accounts/ctrader/oauth/start` from prod (curl with JWT) → confirm `authUrl` returned
- [ ] Walk through `/accounts/new` in a real browser with a Spotware demo account end-to-end
- [ ] Verify BrokerAccount row created with: encrypted creds, accountNumber, accountKind=DEMO, oauthExpiresAt set
- [ ] Wait for next M15 close → engine fans out to the cTrader account; if no signal, hit `GET /api/me/snapshot` to confirm broker call lands without errors
- [ ] (Optional) Place a manual order via `BrokerHttpClient` test script to verify end-to-end execution
- [ ] If anything fails: cTrader account stays disabled, no impact to existing MetaApi accounts
```

- [ ] **Step 4: Final commit**

```bash
git add test/ctrader-oauth.e2e-spec.ts docs/RUNBOOK.md
git commit -m "test(ctrader): e2e flow + rollout checklist

Mocked-Spotware end-to-end: start → callback → finalize. Plus production
rollout checklist tying schema, Terraform, and the OAuth flow together."
```

---

### Task 19: Production rollout (deferred to user)

**Status:** This task is performed manually by the user after the prior 18 tasks land.

**Steps performed by the user (not the implementing subagent):**

- [ ] Register the Spotware app and store credentials in AWS Secrets Manager
- [ ] Terraform apply
- [ ] Merge the feature PR to main
- [ ] Walk through `/accounts/new` against a real Spotware demo broker
- [ ] Confirm the new cTrader account stays disabled until manually toggled
- [ ] Once verified, toggle enabled and watch the next M15 cron snapshot

This task exists so the plan's task graph is complete; do not attempt to execute it in a subagent.

---

## Self-Review

### Spec coverage check

| Spec section | Implementing task(s) |
|---|---|
| §1 Goal — make MetaApi + cTrader interchangeable | Tasks 2, 4–8, 10–11, 16 |
| §2.1 Factory dispatch | Task 2 |
| §3 cTrader OAuth flow §3.1 setup | Task 17 (runbook) |
| §3.2 Sequence | Tasks 10, 11, 15, 16 |
| §3.3 Endpoints | Tasks 11, 12 |
| §3.4 Error paths | Tasks 10 (service throws), 16 (UI surfaces them) |
| §4 Broker ABC alignment | Tasks 4–7 (per-method) |
| §5.1 Schema columns | Task 1 |
| §5.2 Creds shape | Tasks 9, 10 (storeRefreshedTokens) |
| §5.3 Redis state | Task 10 |
| §5.4 Migration plan | Task 1 + Task 19 (manual rollout) |
| §6.1 Spotware app registration | Task 17 |
| §6.2 Sequence diagram | Mirrored by Tasks 10 (service), 11 (controller), 15 (route handler), 16 (wizard) |
| §6.3 Endpoints (start/callback/finalize/oauth-tokens) | Tasks 11, 12 |
| §7 CTraderClient internals | Tasks 3–8 (each subsection has its own task) |
| §8 NestJS OAuth surface | Tasks 9–12 |
| §9 Wizard UX | Task 16 |
| §10 Migration sequencing | Tasks 1, 17, 18, 19 |
| §11 Testing strategy | Tests in every Python + Nest task + Task 18 e2e |
| §12 Rollback plan | Task 19 (manual rollout, accounts default disabled) |

All sections covered.

### Placeholder scan

Scanned every task for "TBD", "TODO", "implement later", "appropriate", "etc.", "similar to". Found one usage of "similar to" in narrative context (the runbook). No code-step placeholders. ✓

### Type consistency

- `CTraderClient` constructor signature consistent across Tasks 4, 5, 6, 7, 8: `(access_token, refresh_token, ctid_trader_account_id, expires_at, account_kind, account_id='', on_token_refresh=None)`. ✓
- `from_creds` reads `accessToken`, `refreshToken`, `ctidTraderAccountId`, `expiresAt`, `accountKind`, `accountId` — these match exactly what `BrokerOAuthService.finalize` writes (Task 10). ✓
- `_default_factory(creds, broker, mode)` — same 3-arg shape in Tasks 2 and 13. ✓
- `BrokerAccountsService.create()` `extra` arg — same shape across Tasks 9, 10. ✓
- `updateCreds(accountId, credsJson, oauthExpiresAt?)` — Tasks 9, 10. ✓
- `storeRefreshedTokens(accountId, { accessToken, refreshToken, expiresAt })` — Tasks 10, 12, 13. ✓
- `oauthSessionId` (camelCase) used consistently in DTO (Task 11), service (Task 10), wizard hook (Task 14), and Task 16 confirm page. ✓
- `ctidTraderAccountId` (camelCase) — same. ✓
- React Query key `['broker-accounts']` matches existing pattern from Spec 1 (Task 14). ✓

### Scope check

19 tasks, the last being a manual user step. Implementation tasks: 18. Within spec's "~14–18" estimate (we landed at the upper bound because the CTraderClient was decomposed by method for TDD clarity). Single PR family. No sub-decomposition needed.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-09-broker-abstraction.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
