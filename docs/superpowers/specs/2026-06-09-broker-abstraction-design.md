# Broker Abstraction + cTrader Integration — Design Spec

**Status:** Draft for review
**Date:** 2026-06-09
**Position:** Spec 3 of the original 3-spec arc. Independent of Spec 4 (Moo Moo / stocks).
**Scope:** Single spec, single implementation plan. No sub-decomposition needed.

## 1. Goal

Make MetaApi and cTrader interchangeable broker backends behind the existing `Broker` ABC from Spec 1. Ship a wizard-style onboarding flow at `/accounts/new` so friends can connect either broker without touching env vars or credentials in JSON.

Today, MetaApi is a single point of failure. Today's outage (broker disconnected for 90 min as of writing) is exactly the scenario this spec defends against — once cTrader is wired up, the same friend can have a cTrader account next to their MetaApi account, and the engine fans out to both. If one bridge dies, the other keeps trading.

Spec 1 already built the foundation: Python `Broker` ABC, `BrokerClientRegistry`, factory dispatch, per-account encrypted creds. Spec 3 adds a second implementation (cTrader) and the OAuth onboarding UX.

## 2. Decisions captured during brainstorming

| # | Decision | Reason |
|---|---|---|
| 1 | **Scope: FX only** — MetaApi + cTrader for the same 4 pairs. Moo Moo / stocks defers to Spec 4. | Ships sooner; the SMC strategy is broker-agnostic but instrument-specific. |
| 2 | **Wizard layout: full-page route at `/accounts/new`** | Each step is its own URL — survives the OAuth redirect bounce naturally. Modal and drawer would lose state when Spotware redirects back. |
| 3 | **Account picker: one at a time** | After cTrader OAuth, friend picks ONE of their accessible accounts per wizard run. Returning to the wizard adds more. Clean 1:1 mental model. |
| 4 | **Token refresh: lazy** | Catch `CH_CLIENT_AUTH_FAILURE` → refresh → retry. Standard OAuth pattern, no extra cron. |
| 5 | **Demo + Live: both first-class** | Both stored as BrokerAccount rows with `DEMO`/`LIVE` badge. Friends may want to test on demo first. |
| 6 | **Multi-broker per user** | Already supported by Spec 1's per-account fan-out — one user can mix cTrader + MetaApi accounts. No change. |
| 7 | **Adapter at Python layer** | New `CTraderClient` implements existing `Broker` ABC. NestJS stays broker-agnostic. Minimal change to the boundary. |
| 8 | **One Spotware app for the whole product** | Standard OAuth pattern (like "Sign in with Google"). You register once. Friends never see the registration page — only the consent screen. |

## 3. Architecture

```
Web (Next.js)
    │
    ▼  /api/broker-accounts/* + /api/strategy/live/*
NestJS
    │
    │  BrokerHttpClient · per-account creds + broker header
    ▼
Execution-service (Python · FastAPI)
    │
    │  BrokerClientRegistry · _default_factory(creds, broker, mode)
    ▼
Broker ABC implementations:
  · MockMT5         (mode=mock)
  · MetaApiMT5      (broker=METAAPI)
  · CTraderClient   ←  NEW (broker=CTRADER)
```

**What Spec 3 changes:**

| Layer | Change |
|---|---|
| Schema | 4 nullable columns on `BrokerAccount` (`accountNumber`, `accountKind`, `brokerName`, `oauthExpiresAt`) + composite index `(broker, accountKind)`. No backfill required. |
| Python execution-service | New `ctrader_client.py` implementing the existing `Broker` ABC over gRPC/Protobuf via WebSocket. `_default_factory` dispatches on `broker` argument. |
| NestJS | New `BrokerOAuthController` (3 endpoints: start, callback, internal token-refresh). New `BrokerOAuthService`. `BrokerAccountsService.create` extended to accept the new metadata. `BrokerHttpClient.credsOpts` adds `X-Broker` header. |
| Web | New `/accounts/new` 4-step wizard with editorial design vocabulary (matches the rest of the redesign). New `/accounts/new/callback` handler page. |
| Crypto | Reuses existing `CryptoService` (AES-256-GCM, Spec 1) — cTrader creds JSON is opaque to the column, same encryption pipeline. |
| Config | New env vars: `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, `CTRADER_REDIRECT_URI`. AWS Secrets Manager entry `shamarx/ctrader-oauth`. |

**What stays untouched:**
- Strategy engine — broker-agnostic, fans out per `BrokerAccount`
- `RiskManager`, `LiveStrategyService`, position-monitor
- `MetaApiMT5` — only the factory dispatch tweak touches its call site
- Dashboard / analytics / admin pages
- Email scoping, preset system, multi-tenant scoping

**One-line summary:** Spec 3 adds cTrader as a peer to MetaApi via the abstraction Spec 1 already built. The hard work is the OAuth flow + a smooth wizard, not the broker interface.

## 4. Broker ABC alignment

The existing `Broker` ABC fits cTrader as-is.

```python
class Broker(ABC):
    async def initialize(self) -> None
    async def place_order(self, request) -> object
    async def get_positions(self, symbol=None) -> list
    async def close_position(self, ticket: int) -> dict
    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict
    async def get_account_info(self) -> object
    async def get_position_close_info(self, ticket: int) -> Optional[dict]
    async def get_candles(self, symbol, timeframe, count) -> list
    async def get_historical_candles(self, symbol, timeframe, from_ts, to_ts) -> list
    async def close(self) -> None
```

Every method maps to a cTrader ProtoOA message. No interface changes.

### 4.1 Factory dispatch change (small)

```python
# services/execution-service/registry.py
def _default_factory(creds: dict, broker: str, mode: str) -> Broker:
    if mode == 'mock':
        from mock_mt5 import MockMT5
        return MockMT5()
    if broker == 'CTRADER':
        from ctrader_client import CTraderClient
        return CTraderClient.from_creds(creds)
    # default + 'METAAPI'
    from metaapi_mt5 import MetaApiMT5
    return MetaApiMT5.from_creds(creds)
```

`BrokerClientRegistry.get_or_create(account_id, creds, broker, mode)` gains the third arg. Existing `MetaApiMT5` call sites add `broker='METAAPI'` (one-line change in each caller).

## 5. Data model

### 5.1 Schema additions

```prisma
model BrokerAccount {
  // ...existing fields

  /// cTrader account number (e.g., "52867017"). null for MetaApi.
  accountNumber  String?
  /// 'DEMO' | 'LIVE'. null for MetaApi.
  accountKind    String?
  /// Friendly broker name (e.g., "IC Markets"). Set on cTrader at OAuth time.
  brokerName     String?
  /// When the current OAuth access token expires. null for MetaApi.
  /// Used by the lazy refresh hook + admin "expiring tokens" view.
  oauthExpiresAt DateTime?

  @@index([broker, accountKind])
}
```

`broker` stays a String enum-in-disguise: `METAAPI`, `MOCK`, `CTRADER`. Adding new brokers later (Moo Moo) needs no migration.

### 5.2 Encrypted creds shape

```json
// METAAPI (existing — unchanged)
{ "accountId": "6f907018-…", "accessToken": "eyJhbGc…" }

// CTRADER (new)
{
  "accessToken": "…",
  "refreshToken": "…",
  "ctidTraderAccountId": 12345,
  "expiresAt": 1717000000
}
```

Both go through the same `CryptoService.encrypt(json)` pipeline. Schema field `encryptedCreds` stays a `Bytes` column.

### 5.3 Redis state (no DB)

OAuth flow uses Redis with TTL:

| Key | Value | TTL |
|---|---|---|
| `oauth:ct:state:<random>` | `{ userId, createdAt }` | 10 min |
| `oauth:ct:session:<sid>` | `{ userId, accessToken, refreshToken, expiresAt, accounts[] }` | 30 min |

Both clear on `BrokerAccount` creation. Both expire automatically if the user abandons mid-wizard.

### 5.4 Migration plan

| Step | Action | Risk |
|---|---|---|
| 1 | Add 4 nullable columns + composite index | None — additive |
| 2 | No backfill — existing MetaApi rows leave new columns NULL | None |
| 3 | Optional follow-up: backfill `accountNumber` for the existing MetaApi row by fetching from MetaApi (account number is distinct from account ID) | Low |

Same hand-crafted SQL pattern Spec 2 used (prod runs `prisma db push`).

## 6. cTrader OAuth flow

### 6.1 One-time setup (manual, before deploy)

Register a Spotware OAuth app at https://openapi.ctrader.com (or https://connect.spotware.com/apps):

| Field | Value |
|---|---|
| App name | `Shamarx` |
| Redirect URI (prod) | `https://app.shamarx.com/oauth/ctrader/callback` |
| Redirect URI (dev) | `http://localhost:3000/oauth/ctrader/callback` |
| Scopes | `trading`, `accounts` |

The redirect target is a **dedicated server-side Next.js Route Handler** at `/oauth/ctrader/callback` — auth-only, not part of the wizard URL space. It receives `?code&state`, POSTs them to the API endpoint in §6.3, then `302`s the browser to `/accounts/new/pick?sid=…` so the wizard resumes at step 3. Decoupling auth callbacks from the wizard keeps the pattern reusable: a future Moo Moo broker becomes `/oauth/moomoo/callback` with no special-casing.

Spotware returns `client_id` + `client_secret`. Both go into AWS Secrets Manager (alongside `BROKER_CREDS_KEY` from Spec 2) and surface in `.env.aws` as `CTRADER_CLIENT_ID` + `CTRADER_CLIENT_SECRET`.

### 6.2 Sequence

```
USER          WEB                   NESTJS                            SPOTWARE
 │             │                     │                                  │
 │  click ──► /accounts/new          │                                  │
 │             │  step 1 · pick cTrader                                 │
 │             │  step 2 · GET /api/broker-accounts/ctrader/oauth/start │
 │             │───────────────────► │                                  │
 │             │                     │ state = randomBytes(32).base64url│
 │             │                     │ redis SET oauth:ct:state:<state> │
 │             │                     │   {userId, createdAt} TTL 600s   │
 │             │ ◄─── 200 { authUrl }│                                  │
 │             │  window.location = authUrl                              │
 │             │ ─────────────────────────────────────────────────────► │
 │                                                  Spotware login      │
 │ ◄──────────────────────── auth + grant ────────────────────────────► │
 │                                                                       │
 │             ◄──── 302 /oauth/ctrader/callback?code=C&state=S         │
 │             │  Next.js Route Handler (server-side)                    │
 │             │  POST /api/broker-accounts/ctrader/callback {code,state}│
 │             │───────────────────► │                                  │
 │             │                     │ redis GET oauth:ct:state:S       │
 │             │                     │ redis DEL                        │
 │             │                     │ POST openapi.ctrader.com/apps/token
 │             │                     │ ────────────────────────────────►│
 │             │                     │ ◄── {accessToken, refreshToken, expiresIn}
 │             │                     │ GET api.spotware.com/connect/tradingaccounts
 │             │                     │ ────────────────────────────────►│
 │             │                     │ ◄── [{ctidTraderAccountId, accountNumber, live, ...}]
 │             │                     │ redis SET oauth:ct:session:<sid> │
 │             │                     │   {userId, accessToken, refreshToken, accounts} TTL 1800s
 │             │ ◄── 200 { sessionId, accounts[] }                      │
 │ ◄────── 302 /accounts/new/pick?sid=<sid> ──────────────────          │
 │             │  step 3 · show account picker                          │
 │             │                                                        │
 │  select ──► │  POST /api/broker-accounts                             │
 │             │   { broker:'CTRADER', oauthSessionId, ctidTraderAccountId, name }
 │             │───────────────────► │                                  │
 │             │                     │ redis GET oauth:ct:session:<sid> │
 │             │                     │ validate account in list          │
 │             │                     │ CryptoService.encrypt({           │
 │             │                     │   accessToken, refreshToken,      │
 │             │                     │   ctidTraderAccountId, expiresAt })
 │             │                     │ INSERT BrokerAccount              │
 │             │                     │ redis DEL oauth:ct:session:<sid>  │
 │             │ ◄── 201 { id, name, broker, isEnabled }                │
 │             │  step 4 · success → /accounts                          │
```

### 6.3 Endpoints

| Method | Path | Guard | Purpose |
|---|---|---|---|
| `GET` | `/api/broker-accounts/ctrader/oauth/start` | JWT | Returns `{ authUrl, state }`. Generates state, stores `{ userId }` in Redis with 10-min TTL. |
| `POST` | `/api/broker-accounts/ctrader/callback` | Public (state-checked) | Body: `{ code, state }`. Validates state → exchanges code → fetches accounts → stores session in Redis 30 min → returns `{ sessionId, accounts[] }`. |
| `POST` | `/api/broker-accounts` (extended) | JWT | New shape: `{ broker:'CTRADER', oauthSessionId, ctidTraderAccountId, name }`. Pulls tokens from Redis session, encrypts, inserts BrokerAccount, deletes session. |
| `PATCH` | `/api/broker-accounts/:id/oauth-tokens` | Internal — IP-restricted to docker network | Body: `{ accessToken, refreshToken, expiresAt }`. Called from CTraderClient after lazy refresh. Re-encrypts and stores. |

### 6.4 Error paths

| Error | Behaviour |
|---|---|
| State token expired / missing in Redis | 410 — wizard shows "Session expired, please restart" |
| State mismatch | 401 |
| Spotware returns `access_denied` | Wizard step 3 shows "You declined access — try again" |
| Code exchange fails (network / Spotware down) | 502 — wizard retry button |
| Account list empty | "No trading accounts on this Spotware login" — link to Spotware to verify |
| BrokerAccount creation fails (unique constraint on `ctidTraderAccountId`) | 409 — "This account is already connected" |

## 7. CTraderClient internals

Lives at `services/execution-service/ctrader_client.py`, implements existing `Broker` ABC.

### 7.1 Connection lifecycle

cTrader Open API is gRPC/Protobuf messages over a persistent WebSocket. Two-level auth: app-level + account-level.

```python
class CTraderClient(Broker):
    async def initialize(self, force=False):
        # 1. Pick endpoint by account kind
        host = 'live.ctraderapi.com' if self.account_kind == 'LIVE' else 'demo.ctraderapi.com'
        self._ws = await connect(f'wss://{host}:5036', subprotocols=['spotware-connect'])

        # 2. App-level auth (CLIENT_ID + CLIENT_SECRET from env)
        await self._send(ProtoOAApplicationAuthReq(
            clientId=CTRADER_CLIENT_ID,
            clientSecret=CTRADER_CLIENT_SECRET,
        ))

        # 3. Account-level auth (per-account encrypted creds)
        await self._send(ProtoOAAccountAuthReq(
            ctidTraderAccountId=self.ctid_trader_account_id,
            accessToken=self.access_token,
        ))

        # 4. Fetch symbol catalog ONCE, build maps
        symbols = await self._send(ProtoOASymbolsListReq(...))
        for s in symbols:
            self._symbol_id_by_name[s.symbolName] = s.symbolId
            self._symbol_digits[s.symbolName] = s.digits
            self._symbol_name_by_id[s.symbolId] = s.symbolName

        # 5. Start heartbeat + reader loops
        self._tasks.append(asyncio.create_task(self._heartbeat_loop()))
        self._tasks.append(asyncio.create_task(self._reader_loop()))
```

### 7.2 Symbol mapping

cTrader uses numeric symbol IDs. Built once at `initialize()`, held in memory.

```python
def _to_ctrader_symbol(self, symbol: str) -> int:
    if symbol in self._symbol_id_by_name:
        return self._symbol_id_by_name[symbol]
    # Tolerant aliasing for broker variants
    aliases = {'XAUUSD': ['GOLD', 'XAU/USD'], ...}
    for alias in aliases.get(symbol, []):
        if alias in self._symbol_id_by_name:
            return self._symbol_id_by_name[alias]
    raise BrokerError(f'Symbol {symbol} not available on this account')
```

Fail fast on unknown symbols — better than placing an order on the wrong instrument.

### 7.3 Price scaling

cTrader stores prices as `int × 10^digits`. 1.0834 EURUSD (digits=5) is `108340`.

```python
def _to_ctrader_price(self, symbol: str, price: float) -> int:
    return int(round(price * (10 ** self._symbol_digits[symbol])))

def _from_ctrader_price(self, symbol: str, price_int: int) -> float:
    return price_int / (10 ** self._symbol_digits[symbol])
```

### 7.4 Per-method mapping

| Broker ABC | cTrader Proto message |
|---|---|
| `place_order(req)` | `ProtoOANewOrderReq` — SL/TP attached as `relativeSL/TP` |
| `get_positions(symbol?)` | `ProtoOAReconcileReq` — filter by symbolId client-side |
| `close_position(ticket)` | `ProtoOAClosePositionReq` with `volume=0` (full close) |
| `modify_position(ticket, sl, tp)` | `ProtoOAAmendPositionSLTPReq` — server-side modification |
| `get_account_info()` | `ProtoOATraderReq` — balance, equity, free margin, margin |
| `get_position_close_info(ticket)` | `ProtoOADealListReq` filtered by position id |
| `get_candles(symbol, tf, count)` | `ProtoOAGetTrendbarsReq` — tf maps cleanly |
| `get_historical_candles(...)` | same with `from/to` timestamps |
| `close()` | WebSocket close + cancel tasks |

Each method is ~10–15 lines including request/response translation.

### 7.5 Reconnect + heartbeat

Mirrors Spec 1's MetaApi circuit-breaker fix:

```python
async def _heartbeat_loop(self):
    while not self._closed:
        await asyncio.sleep(10)
        await self._send(ProtoHeartbeatEvent())   # cTrader requires this every ≤30s

async def _with_reconnect(self, request_fn, max_attempts=5):
    # Exponential backoff (1s, 2s, 4s, 8s, 16s); circuit breaker trips after N consecutive failures
    # Same logic as MetaApiMT5._with_reconnect
```

If the connection drops, `_with_reconnect` replays app-auth + account-auth automatically.

### 7.6 Token refresh

Two trigger points:

| Trigger | Action |
|---|---|
| Proactive (`expiresAt < now + 60s`) | At `_send` entry, refresh first |
| Reactive (`CH_CLIENT_AUTH_FAILURE` response) | Refresh + retry once |

```python
async def _refresh_token(self):
    res = await requests.post(
        'https://openapi.ctrader.com/apps/token',
        data={
            'grant_type': 'refresh_token',
            'refresh_token': self.refresh_token,
            'client_id': CTRADER_CLIENT_ID,
            'client_secret': CTRADER_CLIENT_SECRET,
        },
    )
    self.access_token = res['accessToken']
    self.refresh_token = res['refreshToken']
    self.expires_at = time() + res['expiresIn']
    # Persist back to NestJS for re-encryption + DB update
    await self._on_token_refresh({
        'accessToken': self.access_token,
        'refreshToken': self.refresh_token,
        'expiresAt': self.expires_at,
    })
```

`_on_token_refresh` callback is set at construction by the factory — calls `PATCH /api/broker-accounts/:id/oauth-tokens` on NestJS (internal, IP-restricted to docker network).

### 7.7 Error handling

| cTrader error | Our handling |
|---|---|
| `CH_CLIENT_AUTH_FAILURE` | refresh + retry once → if still fails, mark `healthOk=false` + alert |
| `BROKER_DISCONNECTED` | wait + reconnect via `_with_reconnect` |
| `SYMBOL_NOT_FOUND` | wrap in `BrokerError(symbol)`, propagate up |
| `INSUFFICIENT_FUNDS` / `MARKET_CLOSED` | propagate to NestJS as 409 → strategy logs + skips this signal |
| WebSocket timeout (60s idle) | heartbeat prevents; if it happens, reconnect |

### 7.8 Protobuf library choice

Deferred to implementation phase. Three options:
- **Build it ourselves** — generate Python classes from Spotware's `.proto` files using `protoc`; use `websockets` + `asyncio`. ~200 lines. Recommended.
- **Community `ctrader-open-api` PyPI package** — saves boilerplate, adds a dependency.
- **Spotware's official `spotware-connect-python`** — Twisted-based, doesn't fit our asyncio stack.

## 8. NestJS OAuth surface

### 8.1 File map

| File | Purpose |
|---|---|
| `src/broker-accounts/oauth/broker-oauth.controller.ts` | 3 endpoints (start, callback, finalize via existing POST) |
| `src/broker-accounts/oauth/broker-oauth.service.ts` | State management + Spotware HTTP calls |
| `src/broker-accounts/oauth/dto/*` | `StartOAuthDto`, `CallbackDto`, `FinalizeOAuthDto` |
| `src/broker-accounts/broker-accounts.controller.ts` (modified) | Internal `PATCH /:id/oauth-tokens` endpoint |
| `src/broker-accounts/broker-accounts.service.ts` (modified) | `create()` accepts new metadata; new `updateCreds()` for refresh path |
| `src/broker-accounts/broker-accounts.module.ts` (modified) | Register OAuth controller + service |

### 8.2 BrokerOAuthService

```ts
@Injectable()
export class BrokerOAuthService {
  constructor(
    private readonly redis: RedisService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly accounts: BrokerAccountsService,
  ) {}

  async startOAuth(userId: string): Promise<{ authUrl: string; state: string }> {
    const state = randomBytes(32).toString('base64url');
    await this.redis.setex(`oauth:ct:state:${state}`, 600, JSON.stringify({ userId }));
    const authUrl = new URL('https://connect.spotware.com/apps/auth');
    authUrl.searchParams.set('client_id', this.config.get('CTRADER_CLIENT_ID'));
    authUrl.searchParams.set('redirect_uri', this.config.get('CTRADER_REDIRECT_URI'));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'trading');
    authUrl.searchParams.set('state', state);
    return { authUrl: authUrl.toString(), state };
  }

  async handleCallback(code: string, state: string) {
    const raw = await this.redis.get(`oauth:ct:state:${state}`);
    if (!raw) throw new BadRequestException('State expired or invalid');
    const { userId } = JSON.parse(raw);
    await this.redis.del(`oauth:ct:state:${state}`);

    const tokens = await this.exchangeCodeForTokens(code);
    const accounts = await this.fetchTradingAccounts(tokens.accessToken);

    const sessionId = randomBytes(16).toString('base64url');
    await this.redis.setex(
      `oauth:ct:session:${sessionId}`,
      1800,
      JSON.stringify({ userId, ...tokens, accounts }),
    );
    return { sessionId, accounts };
  }

  async finalize(userId: string, sessionId: string, ctidTraderAccountId: number, name: string) {
    const raw = await this.redis.get(`oauth:ct:session:${sessionId}`);
    if (!raw) throw new BadRequestException('OAuth session expired');
    const session = JSON.parse(raw);
    if (session.userId !== userId) throw new ForbiddenException();

    const account = session.accounts.find((a) => a.ctidTraderAccountId === ctidTraderAccountId);
    if (!account) throw new BadRequestException('Account not in session');

    const created = await this.accounts.create(userId, {
      name,
      broker: 'CTRADER',
      mode: 'metaapi',                     // both kinds use the live (non-mock) path
      accountNumber: String(account.accountNumber),
      accountKind: account.live ? 'LIVE' : 'DEMO',
      brokerName: account.brokerName,
      oauthExpiresAt: new Date(session.expiresAt * 1000),
      credsJson: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        ctidTraderAccountId,
        expiresAt: session.expiresAt,
      },
    });
    await this.redis.del(`oauth:ct:session:${sessionId}`);
    return created;
  }

  async storeRefreshedTokens(accountId: string, tokens: { accessToken: string; refreshToken: string; expiresAt: number }) {
    await this.accounts.updateCreds(accountId, {
      credsJson: tokens,                    // merged with existing ctidTraderAccountId
      oauthExpiresAt: new Date(tokens.expiresAt * 1000),
    });
  }

  private async exchangeCodeForTokens(code: string) { /* POST /apps/token */ }
  private async fetchTradingAccounts(accessToken: string) { /* GET /connect/tradingaccounts */ }
}
```

### 8.3 BrokerAccountsService extension

```ts
async create(userId: string, dto: {
  name: string;
  broker: 'METAAPI' | 'MOCK' | 'CTRADER';
  mode: 'metaapi' | 'mock';
  credsJson: object;                       // existing
  // NEW (all optional, populated for CTRADER)
  accountNumber?: string;
  accountKind?: 'DEMO' | 'LIVE';
  brokerName?: string;
  oauthExpiresAt?: Date;
}): Promise<BrokerAccount>

async updateCreds(accountId: string, dto: {
  credsJson: object;                       // merged with existing creds
  oauthExpiresAt?: Date;
}): Promise<void>
```

### 8.4 BrokerHttpClient — header tweak

```ts
private async credsOpts(accountId: string): Promise<{ headers: Record<string, string> }> {
  const acct = await this.accounts.findByIdWithCreds(accountId);
  const creds = this.crypto.decrypt(/* ... */);
  return {
    headers: {
      'X-Broker': acct.broker,           // NEW — execution-service routes by this
      'X-Creds': JSON.stringify(creds),
    },
  };
}
```

### 8.5 Environment variables

| Var | Where | Purpose |
|---|---|---|
| `CTRADER_CLIENT_ID` | AWS Secrets Manager (`shamarx/ctrader-oauth`) | App-level OAuth client |
| `CTRADER_CLIENT_SECRET` | same | App-level OAuth secret |
| `CTRADER_REDIRECT_URI` | `.env.aws` (non-secret) | e.g., `https://app.shamarx.com/oauth/ctrader/callback` — must match Spotware app registration (§6.1) |
| `CTRADER_AUTH_BASE_URL` | `.env.aws` | Default `https://connect.spotware.com` |
| `CTRADER_TOKEN_URL` | `.env.aws` | Default `https://openapi.ctrader.com/apps/token` |
| `CTRADER_ACCOUNTS_URL` | `.env.aws` | Default `https://api.spotware.com/connect/tradingaccounts` |

Terraform additions: extend existing AWS Secrets Manager IaC (Spec 1 follow-up) to define the new secret. ~20 lines of HCL.

## 9. Wizard UX — `/accounts/new`

4-step full-page wizard. Each step has its own URL — survives the OAuth redirect bounce via the dedicated auth callback at `/oauth/ctrader/callback` (see §6.1), which `302`s back into step 3.

| Step | URL | Content |
|---|---|---|
| 1 | `/accounts/new/broker` | Pick broker (cTrader recommended badge, MetaApi alternative). Numbered step strip at top. |
| 2a (cTrader) | `/accounts/new/connect?broker=ctrader` | Single CTA `Continue to cTrader →` redirects to Spotware. "Your password never touches Shamarx" assurance. |
| 2b (MetaApi) | `/accounts/new/connect?broker=metaapi` | Form: name, MetaApi accountId, MetaApi access token. Step 3 marked "skipped" in the progress strip. |
| 3 (cTrader only) | `/accounts/new/pick?sid=<sessionId>` | List of accessible accounts with DEMO/LIVE badges, balance, broker name. Single-select. Arrived at via `302` from `/oauth/ctrader/callback`. |
| 4 | `/accounts/new/confirm?sid=<sessionId>&ctid=<picked>` | Name field + summary (broker, account number, kind, balance) + "Connect & start →" CTA. |

The OAuth callback at `/oauth/ctrader/callback` is **not a wizard step** — it's a server-side Next.js Route Handler (auth plumbing only, see §6.1). Listing it under the wizard would confuse the mental model.

Design vocabulary matches the rest of the redesign (`label-eyebrow`, `display-serif` headlines, `Reveal` motion, framed cards). Builds on the editorial system already in place after the dashboard / admin redesign PRs.

### 9.1 Step-by-step state

| Step | What's in the URL | What's in component state |
|---|---|---|
| Pick broker | `?` (none) | none |
| Connect (cTrader) | `?broker=ctrader` | none — state lives in Redis on the backend |
| Pick account | `?sid=<sessionId>` | the picked `ctidTraderAccountId` |
| Confirm | `?sid=<sessionId>&ctid=<picked>` | name field |

Refreshing any step is safe — state is recoverable from Redis (within TTL) or restartable.

## 10. Migration sequencing (production)

| # | Step | Reversible? |
|---|---|---|
| 1 | **Manual** — register Spotware app, save `client_id` + `client_secret` | n/a |
| 2 | **Manual** — Terraform-apply new AWS Secrets Manager entry | Yes — drop secret |
| 3 | DB migration: 4 nullable columns + composite index on `BrokerAccount` | Yes — drop cols |
| 4 | Backend code: `BrokerOAuthController`, `BrokerOAuthService`, `CTraderClient`, factory dispatch, `BrokerHttpClient` header | Yes — code revert |
| 5 | Manual test: `GET /api/broker-accounts/ctrader/oauth/start` returns valid Spotware URL; complete OAuth manually; verify callback works | n/a |
| 6 | Web code: `/accounts/new` 4-step wizard + callback handler | Yes — code revert |
| 7 | First end-to-end test: connect IC Markets cTrader demo via wizard; verify BrokerAccount row with encrypted creds, account number, `kind=DEMO`, `oauthExpiresAt` populated | n/a |
| 8 | Smoke: wait for next M15 close; engine fans out to cTrader account via existing fan-out (Spec 2 Task 10); trade fires or `CTraderClient.place_order` logs a clear error | n/a |

No feature flags. Default state preserves existing MetaApi-only world.

## 11. Testing strategy

| Layer | Test | File |
|---|---|---|
| Unit (Python) | Symbol mapping — fuzzy alias resolution | `services/execution-service/test_ctrader_symbols.py` |
| Unit (Python) | Price scaling — round-trip int ↔ float at various digit counts | same |
| Unit (Python) | Token refresh — mock `CH_CLIENT_AUTH_FAILURE` → expect refresh + retry | `services/execution-service/test_ctrader_auth.py` |
| Unit (Python) | Reconnect — exponential backoff matching MetaApi behaviour | `services/execution-service/test_ctrader_reconnect.py` |
| Unit (Nest) | `BrokerOAuthService.startOAuth` — state stored in Redis, URL well-formed | `src/broker-accounts/oauth/broker-oauth.service.spec.ts` |
| Unit (Nest) | `BrokerOAuthService.handleCallback` — expired state, invalid state, happy path | same |
| Unit (Nest) | `BrokerOAuthService.finalize` — session expiry, userId mismatch, success | same |
| Unit (Nest) | `BrokerOAuthController` — JWT guard, public callback, IP-restricted token refresh | `src/broker-accounts/oauth/broker-oauth.controller.spec.ts` |
| Integration (Nest) | `BrokerAccountsService.create` extended — `accountNumber`, `kind`, `oauthExpiresAt` persist | `src/broker-accounts/broker-accounts.service.spec.ts` |
| E2E | Mock OAuth provider with canned tokens + 2 accounts; full wizard flow | `test/ctrader-oauth.e2e-spec.ts` |
| Manual smoke | Real OAuth against real Spotware on staging cTrader demo | post-deploy |

## 12. Rollback plan

- **Phase 1–3 (DB):** additive only; safe.
- **Phase 4–6 (code):** revert via redeploy. `BrokerHttpClient` change is backwards-compatible (extra header ignored if execution-service doesn't recognise broker).
- **MetaApi regression canary:** the existing single-user setup (Pepperstone Demo via MetaApi) is the canary. Any regression breaks the next M15 cron snapshot — visible in `/admin/engine` within minutes.
- **OAuth-specific rollback:** invalidating the Spotware app effectively kills every cTrader account. Existing MetaApi accounts untouched.

## 13. Out of scope

- **Moo Moo / stocks / options** — defers to Spec 4. Different strategy semantics (no killzones, after-hours behaviour, partial fills).
- **cTrader streaming** (`ProtoOASpotEvent`) — stays polling-based for symmetry with MetaApi.
- **Per-broker symbol routing beyond aliases** — no auto-discovery beyond the alias table.
- **Bulk import** (multiple cTrader accounts at once) — single-select per wizard run.
- **Multiple Spotware apps** (one per env) — one app, two registered redirect URIs.
- **Token revocation UI** — requires Spotware-side action; friend re-OAuths if revoked.

## 14. Forward-compatibility notes

- **Spec 4 (Moo Moo)** — pattern repeats: new Python client implementing `Broker` ABC, new `broker = 'MOOMOO'` enum value, new wizard branch in `/accounts/new`. Schema unchanged.
- **Better symbol resolution** — if friends start connecting brokers with esoteric symbol names, add per-user `symbol_aliases` JSON column.
- **cTrader streaming** — when the strategy needs sub-M15 tick data, wire `ProtoOASpotEvent` to feed the orchestrator.
- **OAuth token expiry alerting** — daily cron that scans `oauthExpiresAt < now + 7d` and emails the owner.
- **Per-account broker abstraction tests** — once two brokers ship, add a shared `Broker`-contract test suite that runs against every implementation (parity).

## 15. Estimated scope

~14–18 implementation tasks · 4–6 days focused work + 1–2 days end-to-end validation against real Spotware. Lighter than Spec 2 (the abstraction does the heavy lifting), heavier than Spec 2.5 (OAuth + Protobuf + WebSocket are genuinely new ground).

Decomposition: single spec → single plan → single PR family. No sub-spec needed.
