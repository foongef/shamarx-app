# Multi-Account Broker Support — Design Spec

**Date:** 2026-06-08
**Status:** Approved for implementation planning
**Owner:** foongef
**Decomposition:** This is Spec 1 of 3. Spec 2 = multi-tenant (multiple human users). Spec 3 = broker abstraction + Moo Moo integration. Specs 2 and 3 are scoped separately.

## 1. Context & motivation

The current system is single-account: one MetaApi connection wired via env
(`METAAPI_ACCOUNT_ID_DEMO`, `METAAPI_ACCESS_TOKEN`), one global `LIVE_MODE`
flag, one `LiveSession` table without account scoping. Every `Trade`,
`EquitySnapshot`, and `RiskState` row implicitly belongs to "the one
account".

The operator wants to run the same strategy across multiple broker accounts
**simultaneously** — for example, a demo account for safe testing while a
live account is funded, or a personal account alongside a friend's account.
Each account has its own broker credentials and its own state (positions,
equity, daily loss counter, cooldowns) but they share strategy code and
configuration.

Three concerns are intertwined in the user's longer-term goal: multi-account
(this spec), multi-tenant (Spec 2), and Moo Moo broker integration (Spec 3).
This spec covers ONLY multi-account for the existing single human user, but
the data model is designed so Specs 2 and 3 are purely additive — no
breaking schema migrations later.

## 2. Goals & non-goals

### Goals

- New `BrokerAccount` table; one user has many accounts; each account has
  its own broker credentials (encrypted at rest), its own enabled/paused
  state, and its own connection mode.
- Strategy engine fans out to all enabled accounts on every M15 tick.
  Each account has its own orchestrator state, RiskManager, pending queue,
  and position-monitor.
- Existing services (`LiveStrategyService`, `LivePositionManagerService`,
  `PositionMonitorService`) refactored from singleton-against-env to
  per-account fan-out.
- Execution-service (Python) multiplexes by `accountId`: registry of
  `accountId → MetaApiMT5` instance, route per request.
- UI: stays under `/lives`. New per-account toggle strip lists each account
  with status / equity / today's P&L / enable toggle. Telemetry, positions,
  trades all gain account scoping.
- All credentials stored as AES-256-GCM ciphertext in DB. Encryption key
  (`BROKER_CREDS_KEY`) lives in env. Lost key = re-enter creds manually.
- Existing trades / sessions / equity snapshots backfilled to a "default"
  migrated account so no data is orphaned.

### Non-goals (v1)

- **Multi-tenant** — only foongef can create accounts. `BrokerAccount.userId`
  exists for schema forward-compat but UI assumes single user.
- **Moo Moo / non-MetaApi brokers** — `BrokerAccount.broker` enum reserves
  `'MOOMOO'` value but no Moo Moo code ships.
- **Per-account strategy configuration** — pairs, riskPercent, killzones
  remain global env-driven. All accounts run identical strategy.
- **Stock-specific strategy** — SMC stop-hunt is forex-only. Stocks need
  different setups; defer to Spec 3.
- **KMS / Vault integration** — AES key in env is sufficient for v1 scale.
- **Per-broker candle sources** — market data (candles) shared across
  accounts; same Postgres rows feed all.
- **`accountId NOT NULL` migration** — ships as nullable in v1; flip to
  NOT NULL in a follow-up after backfill is verified.

## 3. Architecture overview

**Mental model:** each enabled `BrokerAccount` runs as its own logical
"engine" — same strategy code, same global config, but bound to its own
broker credentials and its own state. NestJS fans out across enabled
accounts on every M15 tick; the Python execution-service routes each call
to the right `MetaApiMT5` instance by `accountId`.

**Components added:**

- 1 Prisma model: `BrokerAccount`
- 4 tables gain nullable `accountId` foreign key: `Trade`, `LiveSession`,
  `EquitySnapshot`, `RiskState`
- `CryptoModule` + `CryptoService` (AES-256-GCM encrypt/decrypt)
- `BrokerAccountService` (CRUD + in-memory cache of enabled accounts)
- `BrokerAccountController` (6 REST endpoints under `/api/accounts`)
- `LiveSmcOrchestratorRegistry` (one orchestrator instance per accountId,
  lazy-initialized)
- `BrokerHttpClient` (wraps HTTP calls to execution-service with creds
  decryption and `accountId` routing)
- Python: `BrokerClientRegistry` + `Broker` ABC + per-account routes
- UI: per-account toggle strip inside existing `/lives/[id]`, add-account
  modal, account badges in trades and telemetry

**Components reused:**

- `LiveSmcOrchestrator` class (unchanged behavior; instantiated once per
  account)
- Strategy engine (sweep detector, position simulator, RiskManager) — all
  broker-agnostic already
- Existing JWT auth + `User` table
- Existing `JournalEntry` / `DayNote` (DayNote stays user-scoped, journal
  entries reachable via `Trade.accountId`)
- Existing telemetry shape (events gain `accountId` field; Redis keys gain
  `:{accountId}` suffix)

**Compute model.** Fan-out is in-process via `Promise.all`. At 5 accounts ×
4 pairs × every M15 boundary, this is negligible compute. No job queue
needed in v1.

**Feature flag.** `ENABLE_MULTI_ACCOUNT_FANOUT` env flag (default `false`
on first deploy) gates the fan-out. When false, `LiveStrategyService`
evaluates the first enabled account only — equivalent to current behavior.
This lets the code ship and run before flipping the flag.

## 4. Data model

### 4.1 New table: `BrokerAccount`

```prisma
model BrokerAccount {
  id              String   @id @default(uuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// User-facing display name (e.g. "Demo MetaApi", "Live Pepperstone").
  name            String

  /// Broker type. v1 ships METAAPI + MOCK. Reserves MOOMOO for Spec 3.
  broker          String   // 'METAAPI' | 'MOCK' | 'MOOMOO' (future)

  /// AES-256-GCM ciphertext of broker-specific creds JSON.
  /// METAAPI shape: {"accountId": "...", "accessToken": "..."}
  encryptedCreds  Bytes

  /// 12-byte initialization vector (random per encryption).
  credsIv         Bytes

  /// 16-byte GCM authentication tag.
  credsAuthTag    Bytes

  /// Per-account run state. Fan-out only includes accounts with isEnabled=true.
  isEnabled       Boolean  @default(false)

  /// Display order in the /lives account strip. Lower first.
  sortIndex       Int      @default(0)

  /// Connection mode: 'metaapi' (real MetaApi) | 'mock' (paper trading
  /// against the local mock_mt5.py engine).
  mode            String   @default("metaapi")

  /// Last successful broker connection — drives UI liveness dot.
  lastConnectedAt DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  trades          Trade[]
  sessions        LiveSession[]
  equitySnapshots EquitySnapshot[]
  riskStates      RiskState[]

  @@unique([userId, name])
  @@index([userId, isEnabled])
}
```

### 4.2 Tables that gain `accountId`

All four nullable for backwards-compat during the migration window.
Backfill assigns all existing rows to the default migrated account.

```prisma
model Trade {
  // ... existing fields ...
  accountId  String?
  account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)
  @@index([accountId, createdAt])
}

model LiveSession {
  accountId  String?
  account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)
  @@index([accountId, startedAt])
}

model EquitySnapshot {
  accountId  String?
  account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)
  @@index([accountId, takenAt])
}

model RiskState {
  accountId  String?
  account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)
  // Drop the existing global @unique([date]) and replace with composite.
  @@unique([accountId, date])
}
```

`onDelete: Restrict` prevents accidental cascade deletes — disabling an
account is safe; deleting requires zero historical trades.

### 4.3 Tables that do NOT get `accountId`

- `User` — owns accounts, not the other way around
- `JournalEntry` — reachable via `Trade.accountId`
- `DayNote` — user-scoped reflection; not broker state
- `CandidateTrade`, `LlmDecision` — already attached to a trade
- `Candle`, `Indicator`, `SpreadSnapshot` — market data shared across accounts

### 4.4 Encryption helper

```ts
// src/crypto/crypto.service.ts
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.get<string>('BROKER_CREDS_KEY');
    if (!hex || hex.length !== 64) {
      throw new Error('BROKER_CREDS_KEY must be 32 bytes (64 hex chars). Generate via: openssl rand -hex 32');
    }
    this.key = Buffer.from(hex, 'hex');
  }

  encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
```

Decrypt failure (wrong key, tampered ciphertext, tampered authTag) throws
loudly — no silent fallback to nulls.

### 4.5 Backfill migration

One-shot script `scripts/backfill-broker-accounts.ts`. Idempotent.

```
1. Read env: METAAPI_ACCOUNT_ID_DEMO, METAAPI_ACCESS_TOKEN
2. Find existing User row (foongef)
3. UPSERT BrokerAccount:
   - name = "Pepperstone Demo"
   - broker = "METAAPI"
   - mode = "metaapi"
   - isEnabled = true
   - encryptedCreds = crypto.encrypt(JSON.stringify({ accountId, accessToken }))
4. UPDATE Trade SET accountId = <newId> WHERE accountId IS NULL
5. UPDATE LiveSession SET accountId = <newId> WHERE accountId IS NULL
6. UPDATE EquitySnapshot SET accountId = <newId> WHERE accountId IS NULL
7. UPDATE RiskState SET accountId = <newId> WHERE accountId IS NULL
```

Re-runs skip the UPSERT (`@@unique([userId, name])`) and skip already-set
rows (`WHERE accountId IS NULL`).

### 4.6 Input limits

| Field | Max chars / size |
|---|---|
| `BrokerAccount.name` | 60 |
| `BrokerAccount.broker` | 16 (enum-shaped string) |
| `BrokerAccount.mode` | 16 |
| `encryptedCreds` | 2048 bytes |

Per-user enabled-account soft cap: **5**. Enforced in `BrokerAccountService`.

## 5. Strategy engine fan-out

### 5.1 `LiveStrategyService.onCandleStored` — before vs after

**Before:**

```ts
async onCandleStored(data: { symbol, timeframe }) {
  if (data.timeframe !== 'M15') return;
  if (!this.liveControl.isRunning()) return;
  await this.evaluatePair(data.symbol);
}
```

**After:**

```ts
async onCandleStored(data: { symbol, timeframe }) {
  if (data.timeframe !== 'M15') return;
  if (!this.liveControl.isRunning()) return;
  const accounts = await this.brokerAccounts.findEnabled();
  await Promise.all(
    accounts.map((acct) =>
      this.evaluatePairForAccount(data.symbol, acct).catch((err) =>
        this.logger.error(`[${acct.name}/${data.symbol}] evaluate failed: ${err.message}`),
      ),
    ),
  );
}
```

### 5.2 `evaluatePairForAccount(symbol, account)`

Pseudocode of the per-account loop:

```ts
async evaluatePairForAccount(symbol: string, account: BrokerAccount) {
  const [m15, h1, d1] = await Promise.all([
    this.fetchCandles(symbol, 'M15', BUFFER_M15),
    this.fetchCandles(symbol, 'H1', BUFFER_H1),
    this.fetchCandles(symbol, 'D1', BUFFER_D1),
  ]);

  const [openPositions, allOpen, accountInfo] = await Promise.all([
    this.broker.fetchOpenPositions(account.id, symbol),
    this.broker.fetchAllOpenPositions(account.id),
    this.broker.fetchAccount(account.id),
  ]);

  const orchestrator = this.orchestratorRegistry.getOrCreate(account.id);

  const signal = orchestrator.evaluate(symbol, m15, h1, d1, {
    accountEquity: accountInfo.equity,
    openDirections: new Set(openPositions.map(p => p.side as 'BUY' | 'SELL')),
    totalOpenPositions: allOpen.length,
    riskPercent: this.liveControl.getRiskPercent(),
    nowIso: m15[m15.length - 1].openTime,
    maxOpenPositions: 4,
  });

  if (!signal) return;

  const placed = await this.placeOrderForAccount(signal, account);
  if (placed.successfulLegs === 0) {
    this.markPersistDirty(account.id);
    return;
  }
  orchestrator.recordEntry(symbol, signal);
  await this.journal.createJournalEntriesForSignal(signal, evalTs, ctx, account.id);
}
```

### 5.3 `LiveSmcOrchestratorRegistry`

```ts
@Injectable()
export class LiveSmcOrchestratorRegistry {
  private readonly instances = new Map<string, LiveSmcOrchestrator>();
  private readonly evictAfterMs = 5 * 60_000;

  getOrCreate(accountId: string): LiveSmcOrchestrator {
    let inst = this.instances.get(accountId);
    if (!inst) {
      inst = new LiveSmcOrchestrator(/* deps */);
      void inst.restore(accountId);
      this.instances.set(accountId, inst);
    }
    return inst;
  }

  async removeIfDisabled(accountId: string): Promise<void> {
    const inst = this.instances.get(accountId);
    if (inst) {
      await inst.persistNow(accountId);
      setTimeout(() => this.instances.delete(accountId), this.evictAfterMs);
    }
  }
}
```

5-minute eviction grace period catches the "toggle off → toggle back on
within 5 minutes" case without losing state.

### 5.4 `BrokerAccountService.findEnabled()` cache

```ts
@Injectable()
export class BrokerAccountService {
  private cache: { value: BrokerAccount[]; expiresAt: number } | null = null;
  private readonly TTL_MS = 30_000;

  async findEnabled(): Promise<BrokerAccount[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    const value = await this.prisma.brokerAccount.findMany({
      where: { isEnabled: true },
      orderBy: { sortIndex: 'asc' },
    });
    this.cache = { value, expiresAt: Date.now() + this.TTL_MS };
    return value;
  }

  invalidate(): void {
    this.cache = null;
  }
}
```

Invalidated on every PATCH that touches `isEnabled`. 30s TTL catches
direct DB writes (e.g. SQL console) without long staleness.

### 5.5 Redis key namespacing

| Today | After v1 |
|---|---|
| `live:orchestrator:state` | `live:orchestrator:state:{accountId}` |
| `live:telemetry:feed` | `live:telemetry:feed:{accountId}` |
| `live:cron:last-poll:{symbol}:{tf}` | unchanged (market data is global) |

Backfill: existing `live:orchestrator:state` and `live:telemetry:feed`
keys MOVED to `:{defaultAccountId}` suffix on first boot post-deploy.
Migration helper runs once in `LiveSmcOrchestratorRegistry.onModuleInit`.

### 5.6 Position management + reconciliation fan-out

`LivePositionManagerService.manageSymbol(symbol)` becomes:

```ts
async manageSymbol(symbol: string) {
  const accounts = await this.brokerAccounts.findEnabled();
  await Promise.all(accounts.map((acct) => this.manageSymbolForAccount(symbol, acct)));
}
```

`PositionMonitorService.reconcilePair(symbol)` same pattern. The sister-
Runner BE lookup (`maybeTriggerSisterRunnerBe`) extends its `where` clause
to include `accountId: closed.accountId` — preventing cross-account false
matches.

### 5.7 Disabling an account mid-flight

When user toggles `isEnabled: false`:

1. API endpoint updates DB
2. `brokerAccounts.invalidate()` clears cache
3. `orchestratorRegistry.removeIfDisabled(account.id)` persists final
   snapshot, schedules in-memory eviction in 5 minutes
4. `brokerHttp.disconnect(account.id)` → execution-service removes the
   client from its registry
5. Open broker positions stay open — broker still tracks them
6. New M15 ticks don't fan out to this account (not in `findEnabled()`)
7. If re-enabled within 5 minutes: orchestrator state preserved, resumes
   cleanly
8. If re-enabled after 5 minutes: state restored from Redis snapshot

## 6. Execution-service multiplexing (Python)

### 6.1 `Broker` abstract base class

Formalize the contract that `MetaApiMT5` and `MockMT5` share. Makes
adding Moo Moo in Spec 3 a mechanical exercise.

```python
# services/execution-service/broker_base.py
from abc import ABC, abstractmethod
from typing import Optional

class Broker(ABC):
    @abstractmethod
    async def initialize(self) -> None: ...

    @abstractmethod
    async def place_order(self, request: 'OrderRequest') -> 'OrderResponse': ...

    @abstractmethod
    async def get_positions(self, symbol: Optional[str] = None) -> list['Position']: ...

    @abstractmethod
    async def close_position(self, ticket: int) -> dict: ...

    @abstractmethod
    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict: ...

    @abstractmethod
    async def get_account_info(self) -> 'AccountInfo': ...

    @abstractmethod
    async def get_position_close_info(self, ticket: int) -> Optional[dict]: ...

    @abstractmethod
    async def close(self) -> None: ...
```

`MetaApiMT5(Broker)` and `MockMT5(Broker)` declare inheritance.
Type-checker enforces the contract.

### 6.2 `BrokerClientRegistry`

Replaces module-level `MetaApiMT5` singleton with a per-account registry.

```python
# services/execution-service/registry.py
import asyncio
from typing import Dict, Optional
from broker_base import Broker
from metaapi_mt5 import MetaApiMT5
from mock_mt5 import MockMT5

class BrokerClientRegistry:
    def __init__(self):
        self._clients: Dict[str, Broker] = {}
        self._init_locks: Dict[str, asyncio.Lock] = {}

    async def get_or_create(self, account_id: str, creds: dict, mode: str) -> Broker:
        if account_id in self._clients:
            return self._clients[account_id]
        lock = self._init_locks.setdefault(account_id, asyncio.Lock())
        async with lock:
            if account_id in self._clients:
                return self._clients[account_id]
            client = MockMT5() if mode == 'mock' else MetaApiMT5.from_creds(creds)
            await client.initialize()
            self._clients[account_id] = client
            return client

    async def remove(self, account_id: str) -> None:
        client = self._clients.pop(account_id, None)
        if client:
            await client.close()
        self._init_locks.pop(account_id, None)

    def known_accounts(self) -> list[str]:
        return list(self._clients.keys())

registry = BrokerClientRegistry()
```

### 6.3 `MetaApiMT5.from_creds()`

Refactor the existing `__init__` to take explicit creds. Remove all
`os.getenv("METAAPI_ACCOUNT_ID_DEMO")` calls (3 of them in current code).

```python
class MetaApiMT5(Broker):
    def __init__(self, account_id: str, access_token: str):
        self.account_id = account_id
        self.access_token = access_token
        # ... existing init ...

    @classmethod
    def from_creds(cls, creds: dict) -> 'MetaApiMT5':
        return cls(creds['accountId'], creds['accessToken'])
```

### 6.4 FastAPI routes — accountId in path, creds in header

```python
# services/execution-service/main.py
@app.get("/accounts/{account_id}/positions")
async def get_positions(account_id: str, client: Broker = Depends(resolve_client), symbol: Optional[str] = None):
    return await client.get_positions(symbol)

@app.post("/accounts/{account_id}/orders")
async def place_order(account_id: str, request: OrderRequest, client: Broker = Depends(resolve_client)):
    return await client.place_order(request)

@app.post("/accounts/{account_id}/positions/{ticket}/modify")
async def modify(account_id: str, ticket: int, body: ModifyRequest, client: Broker = Depends(resolve_client)):
    return await client.modify_position(ticket, body.slPrice, body.tpPrice)

@app.get("/accounts/{account_id}/positions/{ticket}/history")
async def history(account_id: str, ticket: int, client: Broker = Depends(resolve_client)):
    return await client.get_position_close_info(ticket)

@app.get("/accounts/{account_id}/account-info")
async def account_info(account_id: str, client: Broker = Depends(resolve_client)):
    return await client.get_account_info()

@app.post("/accounts/{account_id}/disconnect")
async def disconnect(account_id: str):
    await registry.remove(account_id)
    return {"ok": True}

async def resolve_client(
    account_id: str,
    x_broker_creds: Optional[str] = Header(None),
    x_broker_mode: str = Header('metaapi'),
) -> Broker:
    if not x_broker_creds:
        raise HTTPException(401, "X-Broker-Creds header required")
    creds = json.loads(x_broker_creds)
    return await registry.get_or_create(account_id, creds, x_broker_mode)
```

`/candles` and `/historical-candles` stay account-agnostic (market data
is broker-agnostic for Pepperstone MetaApi). Future per-broker candle
sources are a Spec 3 concern.

### 6.5 NestJS `BrokerHttpClient`

Wraps HTTP calls with `accountId` routing and creds decryption.

```ts
@Injectable()
export class BrokerHttpClient {
  constructor(
    private readonly http: HttpService,
    private readonly accounts: BrokerAccountService,
    private readonly crypto: CryptoService,
  ) {}

  private async getCredsHeader(accountId: string): Promise<{ headers: Record<string, string> }> {
    const acct = await this.accounts.findByIdWithCreds(accountId);
    const credsJson = this.crypto.decrypt(acct.encryptedCreds, acct.credsIv, acct.credsAuthTag);
    return {
      headers: {
        'X-Broker-Creds': credsJson,
        'X-Broker-Mode': acct.mode,
      },
    };
  }

  async fetchOpenPositions(accountId: string, symbol?: string): Promise<BrokerPosition[]> {
    const opts = await this.getCredsHeader(accountId);
    const q = symbol ? `?symbol=${symbol}` : '';
    return (await firstValueFrom(this.http.get<BrokerPosition[]>(
      `${SERVICE_URLS.EXECUTION}/accounts/${accountId}/positions${q}`, opts
    ))).data;
  }

  async placeOrder(accountId: string, body: any) { /* ... */ }
  async modify(accountId: string, ticket: number, slPrice: number, tpPrice: number) { /* ... */ }
  async fetchAccount(accountId: string): Promise<AccountInfo> { /* ... */ }
  async fetchPositionHistory(accountId: string, ticket: number) { /* ... */ }
  async disconnect(accountId: string) { /* ... */ }
}
```

### 6.6 Creds-on-every-request rationale

We send `X-Broker-Creds` header on every request rather than bootstrapping
once and caching server-side. Pro: execution-service is stateless re.
creds; restart loses nothing. Pro: no callback to NestJS needed.
Con: creds travel over local network on every call — acceptable because
the docker bridge is trusted. If execution-service ever moves to a
separate host, switch to mTLS between services.

### 6.7 Connection cleanup

When NestJS observes `isEnabled: false` for an account:

1. `orchestratorRegistry.removeIfDisabled(account.id)` persists snapshot
2. `brokerHttp.disconnect(account.id)` fires `POST /accounts/{id}/disconnect`
3. Execution-service `registry.remove(account.id)` → `client.close()`

Failure to clean up is non-fatal — orphan clients sit idle and MetaApi
disconnects them after ~24h on its own.

## 7. UI + telemetry isolation

### 7.1 Account strip layout (inside `/lives/[id]`)

New horizontal row above the existing engine telemetry panel.

```
┌─ ACCOUNTS · 3 enabled, 1 paused ──────────────────────────────────┐
│                                                                    │
│ ┌─ Demo MetaApi ●running ──┐ ┌─ Live Pep ●running ──┐ ┌─ Friend ──┐│
│ │ $1,002.10                │ │ $5,420.80            │ │ $10,200   ││
│ │ +$22.10 today · 4 open  │ │ -$8.30 today · 2 open│ │ paused    ││
│ │ ▾ expand                 │ │ ▾ expand            │ │ ▾ expand  ││
│ └──────────────────────────┘ └──────────────────────┘ └──────────┘│
│  + add account                                                     │
└────────────────────────────────────────────────────────────────────┘
```

Each card shows status pill (●running / ○paused / ⚠️disconnected), equity,
today's realized P&L, open position count, expand toggle. Expanding shows
that account's positions + recent trades inline. Card-level Start/Stop
button fires `PATCH /api/accounts/:id` with `isEnabled` flip.

### 7.2 Engine telemetry panel scoping

Existing telemetry panel gains a selector chip: default `"All accounts"`,
chips for each enabled account. Selecting an account filters the visible
pair-scanner strip + decision pipeline + activity feed + engine stats.
Events have `accountId` field; filter is client-side.

### 7.3 Trades table

New `Account` column (color-coded badge). Default sort by `openedAt` desc.
Filter chips above the table — clicking an account's badge filters to
just that account's trades.

### 7.4 Disconnected state

When execution-service can't reach the broker for >60s, account card flips
to yellow ⚠️disconnected pill. Toggle disabled until connection restored.
A backend cron (every 60s) retries `initialize()` on stale connections.
After 5 consecutive failures: send notification email + auto-disable.

### 7.5 Add-account flow

Modal:
1. Display name
2. Broker dropdown (METAAPI / MOCK; MOOMOO disabled in v1)
3. Mode (metaapi / mock)
4. Creds form (MetaApi: accountId + accessToken)

On submit: `POST /api/accounts` with body. Backend validates by calling
execution-service with a `dry-run` flag. On success: returns account
without creds. Failure: returns broker error inline.

### 7.6 Mobile

Account strip becomes horizontal scroll on viewports < 768px. Each card
stays full-size; swipe left/right between them. Telemetry panel stays
full-width.

### 7.7 Journal page implications

- Calendar grid stays user-scoped (DayNote is reflection, not broker state)
- Day panel trade rows gain account badge (small color chip next to side)
- Aggregate stats (month P&L, WR) stay summed across all accounts
- New "by account" expander in month header for split view

## 8. API surface

All under `/api/accounts`, behind `JwtAuthGuard`.

### 8.1 `GET /api/accounts`

```ts
type ListResponse = {
  accounts: Array<{
    id: string;
    name: string;
    broker: 'METAAPI' | 'MOCK' | 'MOOMOO';
    mode: string;
    isEnabled: boolean;
    sortIndex: number;
    lastConnectedAt: string | null;
    createdAt: string;
    // Derived from broker (cached client-side):
    equity?: number;
    todayPnl?: number;
    openPositionsCount?: number;
    connectionStatus?: 'connected' | 'disconnected' | 'unknown';
  }>;
};
```

Account list does not include creds. Derived equity/P&L fields are
populated by a separate `GET /api/accounts/:id/positions` and
`/equity-history` to keep this endpoint cheap.

### 8.2 `POST /api/accounts`

Request:
```ts
{
  name: string;          // max 60
  broker: 'METAAPI' | 'MOCK';
  mode: 'metaapi' | 'mock';
  creds: { accountId: string; accessToken: string };  // MetaApi shape
}
```

Response: created account (no creds). Validates via dry-run call to
execution-service. Fails with broker error inline if creds invalid.

### 8.3 `GET /api/accounts/:id`

Returns single account (no creds). 404 if not found or not owned by current user.

### 8.4 `PATCH /api/accounts/:id`

```ts
{
  name?: string;
  isEnabled?: boolean;
  mode?: string;
  sortIndex?: number;
  // creds rotation NOT in v1 — delete + recreate the account instead
}
```

Toggling `isEnabled` triggers cache invalidation, orchestrator state
persistence (if disabling), and broker disconnect.

### 8.5 `DELETE /api/accounts/:id`

Soft-disable by default (sets `isEnabled = false`). Hard delete (DROP row)
requires `?force=true` AND zero open trades. Returns 409 with trade count
otherwise.

### 8.6 `GET /api/accounts/:id/positions`

Returns live broker positions for THIS account (call-through to
`BrokerHttpClient.fetchOpenPositions`). Used by account-card expand.

### 8.7 `GET /api/accounts/:id/equity-history`

Returns `EquitySnapshot` rows where `accountId = :id` for the requested
time window. Default last 24h.

## 9. Edge cases

| Case | Handling |
|---|---|
| Same-direction cross-account stacking | Allowed; per-account `openDirections` only reflects that account's positions |
| Cross-account same-pair whipsaw (Acct A BUY, Acct B SELL) | Each account decides independently; net portfolio direction is meaningless across separate brokers |
| Execution-service connection drops mid-tick | `Promise.all` isolates per account; status flips to ⚠️disconnected; cron retries |
| Toggle OFF mid-fire | In-flight `placeOrder` finishes; new signals blocked from next tick; positions stay open at broker |
| Delete account with open positions | DELETE returns 409 with trade count; user must close positions first or use `?force=true` for soft-disable only |
| Two M15 ticks for same account within ms | Debounced per `(accountId, symbol)`; orchestrator `lastProcessedH1Time` dedups |
| Encryption key mismatch on restart | CryptoService throws on first decrypt; service fails fast with explicit error |
| Broker creds revoked at MetaApi | First request returns 401; cron retries 5x with backoff; after 5 fails, auto-disable account + send notification |
| Existing trades have no accountId | Backfill assigns to default migrated account |
| Concurrent toggle from two browser tabs | Last-write-wins on DB; cache invalidation makes consistent on next tick; frontend uses optimistic updates with refetch-on-error |
| Orchestrator state Redis key collision | Each account writes to `live:orchestrator:state:{accountId}` — distinct keyspaces |

## 10. Test strategy

### 10.1 Backend unit tests (Jest)

- `BrokerAccountService` — create / list / patch / soft-delete / hard-delete-with-trades-409
- `BrokerAccountService.findEnabled` cache — TTL expiry, manual invalidate, concurrent reads
- `BrokerAccountService` soft-cap enforcement (6th enabled toggle returns 409)
- `CryptoService` — round-trip; tampered auth tag throws; wrong key throws
- `LiveSmcOrchestratorRegistry` — `getOrCreate` idempotent per accountId; `removeIfDisabled` persists final snapshot
- `BrokerHttpClient` — sets `X-Broker-Creds` + `X-Broker-Mode` headers correctly; URL includes accountId
- `LiveStrategyService.onCandleStored` fan-out — 3 enabled accounts, Promise.all evaluates all, one rejection doesn't block others
- `PositionMonitorService.maybeTriggerSisterRunnerBe` — sister lookup scoped by `accountId`

### 10.2 Backend integration tests

- Create two MOCK-mode accounts → enable both → simulated signal fires → both get Trade rows with correct `accountId`
- Toggle account OFF → next tick skips it; position monitor still tracks open positions
- Encrypted creds round-trip — write via service, read via service, decrypt matches input
- Soft-cap: 6th enable returns 409
- DELETE with open trades returns 409 + trade count

### 10.3 Python execution-service tests (pytest)

- `BrokerClientRegistry.get_or_create` idempotent; concurrent `asyncio.gather` with same accountId yields one client
- `MetaApiMT5.from_creds` constructs without env vars
- `Broker` ABC: subclasses missing methods fail to instantiate
- Disconnect endpoint properly removes from registry
- Per-account route shape matches OpenAPI schema

### 10.4 Frontend tests (Vitest)

- Account strip renders N cards from API mock
- Toggle button fires PATCH with optimistic UI update
- Add-account modal validates required fields; dry-run failure shows broker error
- Telemetry filter selector scopes Activity Feed by `accountId`
- Trades table Account column renders badges with stable colors per accountId
- Account-card expand reveals positions + recent trades

### 10.5 Manual QA checklist

1. Migrate + backfill on staging → all existing trades / sessions / equity snapshots have non-null accountId pointing to default account
2. Create a second MOCK account → enable → wait for M15 boundary → both accounts evaluated in logs
3. Toggle live account OFF → orchestrator state persists, then evicts after 5 min (log line confirms eviction)
4. Restart backend → orchestrator state restored per account from Redis snapshot
5. Rotate `BROKER_CREDS_KEY` (verify runbook works on staging first)
6. Fan-out feature flag flip: enable in staging, observe both accounts trade concurrently

### 10.6 Performance sanity

- M15 tick × 4 pairs × 5 accounts × 4 broker round-trips/pair ≈ 80 HTTP calls per 15-min window. Negligible.
- Orchestrator persistence: 5 Redis writes per M15 tick (debounced). Negligible.
- Frontend: accounts polled every 30s; equity polled every 2s when expanded.
- DB index `[accountId, createdAt]` on Trade ensures sub-100ms query at expected scale.

## 11. Rollout

```
1. Merge schema migration       Additive only; backwards-compat (nullable accountId)
2. Merge backend                 New module, services, fan-out logic behind ENABLE_MULTI_ACCOUNT_FANOUT=false
3. Generate BROKER_CREDS_KEY     openssl rand -hex 32; add to production .env
4. Deploy backend                deploy-backend.yml runs prisma db push automatically
5. Run backfill script           scripts/backfill-broker-accounts.ts via SSM
6. Merge web                     Account strip + add-account modal go live; UI still shows single account
7. Manual smoke test             Default migrated account; existing functionality unchanged
8. Create second account in UI   Validate add-account flow on staging
9. Flip ENABLE_MULTI_ACCOUNT_FANOUT=true   Production
10. Watch telemetry              Both accounts evaluate on next M15 boundary
```

Zero-downtime. Each step independently rollback-able. The
`accountId NOT NULL` follow-up migration ships 1-2 weeks later after
stability proven.

## 12. Files

### New (backend)

- `libs/prisma/migrations/<timestamp>_broker_accounts/migration.sql` — BrokerAccount + nullable accountId on 4 tables + composite uniques
- `src/crypto/crypto.module.ts`
- `src/crypto/crypto.service.ts`
- `src/crypto/crypto.service.spec.ts`
- `src/broker-accounts/broker-accounts.module.ts`
- `src/broker-accounts/broker-accounts.service.ts`
- `src/broker-accounts/broker-accounts.service.spec.ts`
- `src/broker-accounts/broker-accounts.controller.ts`
- `src/broker-accounts/broker-accounts.controller.spec.ts`
- `src/broker-accounts/dto/create-broker-account.dto.ts`
- `src/broker-accounts/dto/update-broker-account.dto.ts`
- `src/strategy/live/broker-http-client.ts`
- `src/strategy/live/broker-http-client.spec.ts`
- `src/strategy/live/live-smc-orchestrator-registry.ts`
- `src/strategy/live/live-smc-orchestrator-registry.spec.ts`
- `scripts/backfill-broker-accounts.ts`

### New (execution-service)

- `services/execution-service/broker_base.py` (Broker ABC)
- `services/execution-service/registry.py` (BrokerClientRegistry)
- `services/execution-service/test_registry.py`

### Modified (backend)

- `libs/prisma/schema.prisma` — BrokerAccount model + accountId FKs
- `src/app.module.ts` — register CryptoModule, BrokerAccountsModule
- `src/strategy/live/live-strategy.service.ts` — fan-out per account; remove env reads
- `src/strategy/live/live-position-manager.service.ts` — fan-out per account
- `src/strategy/live/position-monitor.service.ts` — fan-out + sister-Runner lookup scoped by accountId
- `src/strategy/live/live-smc-orchestrator.ts` — accept accountId in restore/persist; key Redis with accountId suffix
- `src/strategy/live/live-control.service.ts` — feature flag check
- `src/journal/journal.service.ts` — `createJournalEntriesForSignal` and related methods accept `accountId`

### Modified (execution-service)

- `services/execution-service/main.py` — new account-scoped routes
- `services/execution-service/metaapi_mt5.py` — remove env reads, add `from_creds` factory, inherit Broker
- `services/execution-service/mock_mt5.py` — inherit Broker

### Modified (web — shamarx-web)

- `src/components/live/` — new `account-strip.tsx`, `account-card.tsx`, `add-account-modal.tsx`
- `src/app/lives/[id]/page.tsx` — add account strip above telemetry panel
- `src/lib/types.ts` — BrokerAccount types
- `src/lib/api-client.ts` — `accounts.*` methods
- `src/hooks/use-accounts.ts` — react-query hooks

### Modified (env / config)

- `.env` — add `BROKER_CREDS_KEY` (hex string) and `ENABLE_MULTI_ACCOUNT_FANOUT=false` (default)
- `.env.example` — document both
- `docs/RUNBOOK.md` — `BROKER_CREDS_KEY` rotation procedure

## 13. Forward-compatibility notes

### 13.1 For Spec 2 (multi-tenant)

- `BrokerAccount.userId` non-null from day one — multi-tenant queries naturally scope by it
- `DayNote` will need `userId` added (was OK to skip in journal v1 since single-user)
- Multi-tenant API scoping: add `@CurrentUser()` decorator + service-layer `where: { userId: currentUser.id }` everywhere
- Per-user `BROKER_CREDS_KEY` not currently supported — KMS upgrade required if you want per-tenant encryption

### 13.2 For Spec 3 (Moo Moo / broker abstraction)

- `BrokerAccount.broker` enum already reserves `MOOMOO`
- Python `Broker` ABC formalizes the contract; Moo Moo just implements 8 methods
- `BrokerHttpClient` (NestJS) currently knows MetaApi shapes — will need broker-specific request/response mapping
- Strategy code (SMC sweep detector) is forex-only; Moo Moo trades stocks/options. Strategy layer needs separate investigation (deferred — "what trades on stocks?" is its own design question)
- Per-broker candle sources (Moo Moo equity data vs MetaApi forex) may require splitting market-data layer

## 14. Open questions deferred

- **KMS / Vault migration timing** — Tied to multi-tenant rollout (Spec 2)
- **Cross-account aggregate metrics** — Spec acknowledges aggregate view in UI; whether to also persist daily aggregate snapshots across accounts in DB is a v2 question
- **Per-account override of strategy params** — Could ship if needed; currently deferred (all accounts identical strategy)
- **Auto-detection of failed broker connection — restart vs alert vs auto-disable** — Current decision: alert + auto-disable after 5 consecutive failures. May tune based on production experience.

## 15. Decomposition reminder

This is **Spec 1 of 3**. Specs 2 and 3 are separate:

- **Spec 2 (multi-tenant):** add user-scoping to all queries; user invite flow; per-user dashboard; KMS / per-user encryption upgrade
- **Spec 3 (Moo Moo + broker abstraction):** NestJS `IBroker` interface; Moo Moo Python implementation; per-broker request/response mapping; strategy layer for stocks/options (separate strategy-design investigation)
