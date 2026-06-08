# Multi-Tenant ("Friends + Me") — Design Spec

**Status:** Draft for review
**Date:** 2026-06-09
**Decomposition:** This is Spec 2 of 3. Spec 1 (multi-account broker support) is merged. Spec 3 (Moo Moo / broker abstraction) is independent and not blocked by this work.
**Scope:** Single spec, single implementation plan. No sub-decomposition needed.

## 1. Goal

Open Shamarx to 5–10 trusted friends on shared infrastructure, while preserving:

- The existing strategy edge (only one strategy ships — the current SMC sweep).
- The existing operator experience (you keep cross-tenant visibility).
- The existing design system (no new visual primitives introduced).

The system goes from "1 user (you)" to "1 user + invite system available." It becomes multi-tenant the moment you create your first invite. There is no big-bang launch — it's a gradual onboarding.

This spec also lays groundwork to scale to SaaS later, but does not deliver SaaS features (billing, public signup, self-serve onboarding) in scope.

## 2. Decisions captured during brainstorming

| # | Decision | Reason |
|---|---|---|
| 1 | Three strategy presets — `CONSERVATIVE`, `BALANCED`, `AGGRESSIVE` | Friends get a meaningful knob without breaking the validated strategy edge. `BALANCED` = current live config. |
| 2 | Invite-link onboarding (time-limited token; friend sets own password + picks preset) | Reuses password-reset table pattern. No plaintext passwords. |
| 3 | Fully private data isolation | Every Prisma query for a tenant-scoped model filters on `userId`. Clean rule. Friends never see each other's trades. |
| 4 | Separate `/admin/*` section | Cross-tenant ops live in a dedicated route tree gated by `SUPERADMIN` role. No conditional rendering inside friend pages. |
| 5 | Status-focused dashboard redesign | Big equity number, bot status pill, open positions inline. Hides all multi-strategy / backtest surface from friends. |
| 6 | `User.botEnabled` master switch + existing per-account `BrokerAccount.isEnabled` | Friend gets a one-click pause; per-account granularity stays as a power-user gesture. |
| 7 | Refresh-token rotation | Short-lived (15min) access JWT + 7-day refresh token in httpOnly cookie; rotation with reuse detection. Persistent sessions, safe blast radius. |
| 8 | Service-layer `where: { userId }` enforcement | Defense in depth is overkill for 5–10 trusted users. Code review + E2E tests with two seeded users catch leaks. |
| 9 | Single strategy only — hide strategy variants from friend UI | Spec scope is multi-tenant, not multi-strategy. |
| 10 | Dashboard redesign in scope | Friend-facing UI gets a refresh as part of this spec to hide unused strategy surface and improve clarity. |

## 3. Architecture overview

```
                      JWT(userId, role)
                            ↓
  Web ──→ NestJS Controller ──→ @CurrentUser() ──→ Service ──→ Prisma
                                                     ↓
                                          where: { userId } everywhere
                                                     ↓
                                                Postgres

  Cron @M15 ──→ For each enabled BrokerAccount where:
                  user.botEnabled    = true
                  user.isActive      = true
                  account.isEnabled  = true
                  account.healthOk   = true     // broker connectivity (Spec 1)
                ──→ resolve preset(user.presetKey)
                ──→ evaluate strategy with preset params
                ──→ on signal: notifyTradeOpened(user.email)
```

**What changes:**

| Layer | Change |
|---|---|
| DB schema | Add `User.botEnabled`, `User.presetKey`; add `Invite` table; add `RefreshToken` table; add `userId` to `DayNote`; backfill |
| Auth | New `/auth/refresh` + `/invites/*` endpoints; `@CurrentUser()` decorator; `RolesGuard` for `/admin/*` |
| Strategy engine | `LiveStrategyService.evaluatePairForAccount` reads `user.presetKey` → applies preset params; gated by `user.botEnabled && user.isActive && account.isEnabled` |
| Mail | `notifyTradeOpened` sends to trade owner only (not all active users); new `invite.hbs` template |
| Web UI | Friend dashboard redesign (status-focused). New `/admin/*` section. Hide strategy variants. Preset switcher. Refresh-token interceptor in auth context. |

**What stays untouched** (validated by Spec 1 forward-compat work):
- `BrokerAccount` + per-user broker credential encryption.
- Python execution-service — broker-agnostic, no changes.
- Cron jobs (orchestrator persistence, position monitor) — already per-account.
- Backtest module — moved to admin route, otherwise unchanged.

**LiveSession stays global** — kept as a SUPERADMIN ops marker ("engine process is up"). The friend-facing "is my bot live?" pill reads `User.botEnabled`. This avoids dragging `userId` through `LiveSession` and keeps the per-user run-state in one place.

## 4. Data model

### 4.1 New enum

```prisma
enum PresetKey {
  CONSERVATIVE
  BALANCED       // ← current live params (1% risk, all 4 pairs, 3% daily-loss)
  AGGRESSIVE
}
```

### 4.2 Modified `User`

```prisma
model User {
  // ... existing fields
  role           UserRole  @default(USER)        // existing enum: SUPERADMIN/ADMIN/USER
  botEnabled     Boolean   @default(true)        // NEW — master pause switch
  presetKey      PresetKey @default(BALANCED)    // NEW — which preset to apply

  brokerAccounts BrokerAccount[]                 // existing
  invitesCreated Invite[]       @relation("InviteCreator")  // NEW
  refreshTokens  RefreshToken[]                  // NEW
  dayNotes       DayNote[]                       // NEW relation
}
```

### 4.3 New `Invite` table

```prisma
model Invite {
  id          String    @id @default(uuid())
  email       String                            // who it's for
  tokenHash   String    @unique                 // raw token in URL, argon2id hash in DB
  createdById String
  createdBy   User      @relation("InviteCreator", fields: [createdById], references: [id])
  expiresAt   DateTime                          // default: now() + 7 days
  acceptedAt  DateTime?                         // null until used
  createdAt   DateTime  @default(now())

  @@index([email])
  @@index([expiresAt])
}
```

### 4.4 New `RefreshToken` table

```prisma
model RefreshToken {
  id           String    @id @default(uuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash    String    @unique               // sha256(rawToken) — fast lookup, no argon for short-lived
  expiresAt    DateTime
  revokedAt    DateTime?
  replacedById String?                          // rotation chain; for reuse detection
  userAgent    String?                          // for /admin/sessions visibility
  createdAt    DateTime  @default(now())

  @@index([userId])
  @@index([expiresAt])
}
```

### 4.5 Modified `DayNote`

```prisma
model DayNote {
  // ... existing fields
  userId String
  user   User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@unique([userId, tradeDate])   // was unique on tradeDate alone
}
```

### 4.6 Migration plan

| Step | Action | Risk |
|---|---|---|
| 1 | Add `User.botEnabled`, `User.presetKey` with defaults | None — additive |
| 2 | Create `Invite` table | None — additive |
| 3 | Create `RefreshToken` table | None — additive |
| 4 | Add `DayNote.userId` as nullable | None — additive |
| 5 | Backfill: `UPDATE "DayNote" SET userId = '<your-uuid>'` | None — single existing user |
| 6 | Set `DayNote.userId` NOT NULL + flip unique constraint to `(userId, tradeDate)` | Brief lock on small table |
| 7 | Update your own row: `role=SUPERADMIN, botEnabled=true, presetKey=BALANCED` | None |

Idempotent backfill script `scripts/backfill-spec2.ts`:

```ts
const me = await prisma.user.findFirstOrThrow({ where: { role: 'SUPERADMIN' } });
await prisma.dayNote.updateMany({ where: { userId: null }, data: { userId: me.id } });
await prisma.user.update({
  where: { id: me.id },
  data: { presetKey: 'BALANCED', botEnabled: true },
});
```

## 5. Preset system

### 5.1 Preset definitions

Hardcoded TypeScript map in `src/strategy/presets.ts`. Versioned with the code, no DB round-trip per evaluation, easy to backtest.

```ts
// src/strategy/presets.ts
export interface StrategyPreset {
  riskPercent: number;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  pairs: string[];              // subset of XAUUSD,EURUSD,GBPUSD,USDJPY
}

export const PRESETS: Record<PresetKey, StrategyPreset> = {
  CONSERVATIVE: {
    riskPercent: 0.5,
    maxDailyLossPercent: 2.0,
    maxOpenPositions: 2,
    pairs: ['EURUSD', 'GBPUSD'],         // safer majors only
  },
  BALANCED: {                             // = current live config
    riskPercent: 1.0,
    maxDailyLossPercent: 3.0,
    maxOpenPositions: 3,
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  },
  AGGRESSIVE: {
    riskPercent: 1.5,
    maxDailyLossPercent: 5.0,
    maxOpenPositions: 3,
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  },
};
```

### 5.2 Per-preset vs global params

| Preset varies | Global (unchanged) |
|---|---|
| `riskPercent` | killzone hours |
| `maxDailyLossPercent` | ATR multipliers per pair (`smc/pairs/*.ts`) |
| `maxOpenPositions` | indicator periods (RSI, EMA, ADX) |
| enabled `pairs` subset | swing-detection thresholds |

Rule of thumb: **risk knobs are per-preset; signal-detection params are global.** Friends can't accidentally break the strategy edge.

### 5.3 Flow through the engine

```
Cron tick (M15)
  ↓
Loop over enabled BrokerAccounts
  ↓
For each account:
  user = account.user
  if (!user.botEnabled || !user.isActive) skip      ← per-user master gate
  if (!account.healthOk) skip                       ← broker connectivity (Spec 1)
  preset = PRESETS[user.presetKey]

  if (!preset.pairs.includes(symbol)) skip          ← preset filters pairs

  RiskManager(preset.riskPercent, preset.maxDailyLossPercent, preset.maxOpenPositions)
  → evaluateForPair(symbol, account, riskManager)
  → on signal: notifyTradeOpened({ to: user.email, ...payload })
```

### 5.4 Mid-day preset switching

- Switch writes to `User.presetKey` via `PATCH /me { presetKey }` (see §6.1).
- **Open positions keep their original SL/TP** — preset only affects new entries.
- Next M15 evaluation uses the new params.
- No live position adjustment. Keeps the switch boring and safe.

### 5.5 Backtesting presets

`scripts/compare-smc-gates.ts` gains 3 scenarios — `preset-conservative`, `preset-balanced`, `preset-aggressive` — so Conservative + Aggressive numbers are published honestly before they go live to friends. Until then, the picker shows "Backtest pending" on those cards.

### 5.6 Preset picker UX

Used in both `/accept-invite` and `/preferences` (the in-app preset switcher):

- Three cards: colored dot + label, one-line tagline, hard numbers (`riskPercent`, `maxDailyLossPercent`, `maxOpenPositions`, `pairs`).
- `BALANCED` card has a **Recommended** badge + validation footnote ("686 trades · 64.9% WR · +143%").
- `AGGRESSIVE` card has a **Warning** footnote ("Drawdown can hit 5% in one day").
- Each metric label has a hover/tap tooltip with a plain-English explainer:
  - "Risk per trade" → "If you have $1,000, each trade risks $10 on the 1% preset"
  - "Max daily loss" → "Bot stops trading for the day if you lose this much"
  - "Max open" → "How many positions can run at once"
  - "Pairs" → "Which markets the bot trades"
- Component is shared between accept-invite and preferences; renders identically.

## 6. Auth + invite flow

### 6.1 Endpoints

| Method | Path | Guard | Purpose |
|---|---|---|---|
| `POST` | `/auth/login` | public | Returns `{ accessToken }`; sets `refreshToken` httpOnly cookie |
| `POST` | `/auth/refresh` | public (cookie) | Rotates refresh token; returns new `accessToken` |
| `POST` | `/auth/logout` | JWT | Revokes current refresh token + clears cookie |
| `POST` | `/admin/invites` | SUPERADMIN | Body: `{ email, expiresInDays? = 7 }` → returns raw token once |
| `GET` | `/admin/invites` | SUPERADMIN | List invites + acceptance status |
| `DELETE` | `/admin/invites/:id` | SUPERADMIN | Revoke (sets `expiresAt = now()`) |
| `GET` | `/invites/:token/preview` | public | Validate token, return invite email + expiresAt |
| `POST` | `/invites/:token/accept` | public | Body: `{ password, presetKey }` → creates `User` + issues both tokens |
| `GET` | `/me` | JWT | Returns current user profile |
| `PATCH` | `/me` | JWT | Update: `botEnabled`, `presetKey` |
| `PATCH` | `/me/password` | JWT | Change password |

### 6.2 Invite token format

- Generated server-side: 32 random bytes, base64url-encoded → `aK9pXwQzRtMv...`.
- Hashed with `argon2id` before storing as `Invite.tokenHash`.
- URL shape: `https://shamarx.io/join/{token}` (or local domain).
- Single-use: marked `acceptedAt` after successful POST; subsequent attempts return 410.

### 6.3 Refresh-token strategy

| Token | TTL | Storage | Why |
|---|---|---|---|
| Access JWT | **15 min** | Memory (web client state) | Short blast radius if leaked |
| Refresh token | **7 days** | httpOnly + Secure cookie, sliding | Friends stay logged in; safe from JS access |

**Rotation:** every `/auth/refresh` issues a new refresh token and marks the old `revokedAt = now()`, `replacedById = new.id`. If an already-revoked token is presented again ("reuse"), revoke the entire chain for that user — standard reuse-detection.

**Hash function:** `sha256(rawToken)` — fast enough for high-frequency refresh, refresh tokens are not as security-critical as passwords (they're already random + rotated).

### 6.4 Web client (axios interceptor)

- On `401` with `code: 'ACCESS_TOKEN_EXPIRED'` → call `/auth/refresh` once, retry the original request.
- Lock so concurrent 401s only fire one refresh.
- On `/auth/refresh` returning 401 → redirect to `/login`; chain is dead.
- Optional optimization: proactive refresh ~60s before access token expiry (decode `exp` claim).

### 6.5 Sequence — admin creates invite

```
You (SUPERADMIN) → /admin/invites → "+ New Invite"
  → modal: { email: "alice@example.com", expiresInDays: 7 } → POST /admin/invites
  → server: generate raw token, argon2id hash, store Invite row
  → server: send email via invite.hbs to alice with /join/{token} link
  → server: return { token: rawTokenOnce, ... } to admin UI (one-time copy, for fallback)
```

### 6.6 Sequence — friend accepts

```
alice → clicks /join/{token} → web app GET /invites/{token}/preview
  → 200 { email: "alice@example.com", expiresAt: "..." }
  → web shows "Welcome alice@... Set your password + pick preset"
  → alice submits → POST /invites/{token}/accept { password, presetKey }
  → server (transaction):
      look up Invite by tokenHash, check not expired, check acceptedAt is null
      create User { email, passwordHash, role: USER, presetKey, botEnabled: true }
      mark Invite.acceptedAt = now()
      issue access JWT + create RefreshToken row + set cookie
  → redirect to /dashboard
```

### 6.7 Auth helpers (NestJS)

- `@CurrentUser()` parameter decorator — extracts JWT payload `{ id, email, role }`. Injected into every controller method.
- `RolesGuard` — checks `@Roles('SUPERADMIN')` metadata on `/admin/*` routes.
- Existing `JwtAuthGuard` covers everything else.

### 6.8 Email templates

| Trigger | Template | Recipient |
|---|---|---|
| Invite created | new `invite.hbs` (mirrors `reset-password.hbs` style) | invited email |
| Trade opened | `trade-opened.hbs` (existing) | **trade owner only** (scope change) |
| Password reset | `reset-password.hbs` (existing) | unchanged |
| User accepted invite (optional) | `invite-accepted.hbs` (new, behind env flag) | SUPERADMIN inbox |

### 6.9 Edge cases

| Case | Behaviour |
|---|---|
| Token expired | `/preview` returns 410; accept page shows "Link expired — ask the admin to send a new one" |
| Token already accepted | `/preview` returns 410 |
| Email already exists as User | `/accept` returns 409 — don't silently change password |
| Multiple invites for same email | Allowed (admin may re-send); only one can be accepted; rest can be manually revoked |
| Refresh token expired | 401, client redirects to login |
| Refresh token reuse detected | Revoke entire family for user, force re-login everywhere |
| User deactivated (`isActive=false`) | Refresh returns 401 even if token is valid; all refresh tokens revoked on deactivation |

## 7. Run-state model + UI gestures

### 7.1 Engine fan-out gate

```ts
const shouldFanOut = (user: User, account: BrokerAccount): boolean =>
  user.botEnabled &&
  user.isActive &&
  account.isEnabled &&
  account.healthOk;     // existing broker connectivity flag
```

All four conditions must be true. Any false short-circuits the fan-out for that account in that tick.

### 7.2 Status pill states (top-right of friend dashboard)

| Pill | Condition | Label |
|---|---|---|
| 🟢 Live | `botEnabled && isActive && ≥1 enabled+healthy account` | "Bot live · Balanced" |
| 🟡 Paused | `botEnabled = false` | "Paused by you · click to resume" |
| ⚪ No accounts | `botEnabled && 0 enabled accounts` | "Add or enable an account to start" |
| 🔴 Disabled | `isActive = false` | "Account disabled · contact admin" |
| 🟠 Broker issue | `≥1 enabled account but healthOk = false` | "Broker connection issue · check accounts" |

### 7.3 Toggle gestures

| Action | Mechanism | Confirmation? |
|---|---|---|
| Friend pauses bot | Click status pill → `PATCH /me { botEnabled: false }` | **Yes** — modal: "Pause your bot? Open positions stay open until SL/TP." |
| Friend resumes | Click pill again → `PATCH /me { botEnabled: true }` | No |
| Friend disables one account | Toggle on `/accounts` page (existing Spec 1 UI) | No |
| Admin force-pauses a user | `/admin/users/:id` → toggle `botEnabled` | Yes |
| Admin deactivates a user | `/admin/users/:id` → toggle `isActive` | Yes — "User will be kicked next request; all refresh tokens revoked" |

### 7.4 Behaviour when bot pauses mid-day

- **Open positions:** untouched. Continue to SL/TP via position-monitor cron (unchanged).
- **Pending H1 sweep queues:** persisted to Redis at next 5-min cron tick (from Spec 1).
- **Daily-loss / consecutive-loss counters:** continue accumulating; pause is not a "fresh day" reset.
- **Resume:** engine picks up at next M15 evaluation. Orchestrator state restored from Redis if it had been evicted.

### 7.5 Admin deactivation = real kick

```
SUPERADMIN sets user.isActive = false
  → backend: prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() }
    })
  → User's current access JWT works for ≤ 15 min (its TTL).
  → Their next /auth/refresh fails → forced re-login → login also fails (isActive check).
```

## 8. Dashboard redesign

### 8.1 Layout pattern (matches existing `Sidebar` + `Topbar`)

- **Sidebar** (228px, left, sticky): brand mark · WORKSPACE nav · SETTINGS nav · ADMIN nav (conditional on SUPERADMIN) · user footer with logout. Existing `Sidebar` component extended with new nav items.
- **Slim topbar** (48px): page label/breadcrumb left · **status pill** right · UTC clock. Existing `Topbar` extended with status pill.
- **Main**: scrollable content.

### 8.2 Friend nav (WORKSPACE section)

- Overview · Live · Journal · Accounts
- SETTINGS → Preferences (preset switcher, change password)
- **Removed from friend nav** (visible only as SUPERADMIN in ADMIN section): Backtest Runs, New Run, Replay

### 8.3 SUPERADMIN sidebar additions (conditional render)

Below WORKSPACE, render when `user.role === 'SUPERADMIN'`:

```
ADMIN
  ▸ Users
  ▸ Invites
  ▸ Sessions
  ▸ Engine
  ▸ Backtest
```

### 8.4 Friend `/dashboard` page contents

| Region | Contents |
|---|---|
| Topbar | "OVERVIEW" label · status pill · UTC clock |
| Hero | "EQUITY · LIVE" eyebrow · `$10,420.50` big number · `+$120.00` delta · subtitle row (MTD%, all-time%, max DD%) |
| Open positions | 2-column grid; symbol, side badge, entry/SL, live pips/$ delta. "All →" link to `/lives`. |
| Today | List with timestamp, pair, side, P&L. Auto-collapsed to today; navigates to `/trades` for history. |
| Quick cards | Preset switcher chip · Accounts count · Equity chart link |

### 8.5 Component reuse + new components

| Component | Status |
|---|---|
| `Sidebar` | Extend — add conditional ADMIN section |
| `Topbar` | Extend — add `StatusPill` slot |
| `EquityCard` | Extend for hero size (typography scale) |
| `TradeRow` | Reuse as-is in "Today" list |
| `PositionCard` | Reuse with minor visual refresh |
| `StatusPill` | **New** — 5-state pill component |
| `PresetSwitcher` | **New** — picker card from §5.6; shared with `/accept-invite` |
| `BacktestQuickAccess` | **Remove** from friend view — moved to `/admin/backtest` |

### 8.6 Design system compliance (binding constraint on implementation)

- Only existing tokens from `globals.css` — no new colors introduced.
- Only existing shadcn primitives (`Card`, `Badge`, `Button`, `Switch`, `Select`, `Input`, `Table`, `Tabs`, `Separator`, `Skeleton`) unless a new one is justified.
- Layout uses existing `Sidebar` + `Topbar` components — extended, not replaced.
- Typography: Orbitron (display), Geist Mono (data/numbers), Geist Sans (body).
- Shamarx gold (`--signal`) used **sparingly** — brand mark, active state, focus rings, semantic warnings. Never as a fill on cards or backgrounds.
- Profit/loss tokens (`--profit`, `--loss`) reserved for numerical P&L only.
- Sharp 0.25rem default radius across new components.

## 9. Admin section (`/admin/*`)

### 9.1 Routes (SUPERADMIN-only, `RolesGuard`)

```
/admin
├─ /users                — list, search, drill-in
│   └─ /:id              — user detail
├─ /invites              — create / list / revoke
├─ /sessions             — active refresh tokens, revoke individual sessions
├─ /engine               — LiveSession status, cron health, force-pause-all
└─ /backtest             — existing backtest UI moved here
```

### 9.2 `/admin/users` columns

| Email | Role | Status | Bot | Preset | Accounts | Equity (sum) | P&L 24h |
|---|---|---|---|---|---|---|---|
| alice@... | USER | 🟢 active | 🟢 on | Balanced | 2 (2 ✓) | $10,420 | +$120 |
| bob@... | USER | 🟢 active | 🟡 paused | Conservative | 1 (1 ✓) | $5,150 | $0 |
| dave@... | USER | 🔴 disabled | — | Balanced | 1 (0 ✗) | $9,500 | — |

Row click → user detail page. Row actions: **Toggle bot**, **Toggle active**, **Send reset link**.

### 9.3 `/admin/invites` columns

| Email | Created | Expires | Status | Created by |
|---|---|---|---|---|
| carol@... | 2d ago | in 5d | 🟡 pending | you |
| ed@... | 6d ago | in 1d | 🟢 accepted | you |
| frank@... | 10d ago | expired | 🔴 expired | you |

Top: **+ New Invite** button → modal: email input, expiry (1d / 7d / 30d), [Generate]. Returns raw token in a one-time-copy box.

### 9.4 `/admin/sessions`

Lists all active (not revoked, not expired) `RefreshToken` rows joined with `User`:

| User | Created | Last refresh | User agent | Actions |
|---|---|---|---|---|
| alice@... | 3d ago | 2h ago | Chrome 132 / Mac | [Revoke] |
| bob@... | 1d ago | 30m ago | Mobile Safari / iPhone | [Revoke] |

[Revoke] sets `revokedAt = now()`; user is logged out at next request.

### 9.5 `/admin/engine` (ops view)

- LiveSession status: "🟢 Started 14h ago · last cron 12s ago"
- Per-account fan-out stats: count evaluated last tick, average eval time.
- Daily aggregate: trades today across all users, total volume, peak open positions.
- **Emergency: Force-pause everyone** — button requires typing `PAUSE-ALL` to confirm; sets every `User.botEnabled = false`. Reversible per-user from `/admin/users`.

### 9.6 Friend-side leakage guard

Non-SUPERADMIN requests to `/admin/*` routes return **404**, not 403. The existence of the admin section is never acknowledged in headers or response bodies.

## 10. Data isolation enforcement

### 10.1 Service-layer rule

Every Prisma query against a tenant-scoped model filters on `userId`:

```ts
// Tenant-scoped models in scope:
//   BrokerAccount, Trade, EquitySnapshot, LiveReplayTrade,
//   JournalEntry, DayNote, RefreshToken, Invite (where user-related)

// Example:
async findMyTrades(userId: string): Promise<Trade[]> {
  return prisma.trade.findMany({
    where: {
      account: { userId },   // join through BrokerAccount → User
    },
    orderBy: { openedAt: 'desc' },
  });
}
```

`@CurrentUser()` decorator extracts `userId` from JWT; every controller method passes it down.

### 10.2 SUPERADMIN bypass

SUPERADMIN-only services (used by `/admin/*` controllers) do **not** filter on `userId` — they explicitly accept an optional `userId` filter and pass `undefined` for cross-tenant queries:

```ts
async listAllUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { email: 'asc' } });
}

async listTradesForUser(userId: string): Promise<Trade[]> {
  return prisma.trade.findMany({ where: { account: { userId } } });
}
```

### 10.3 Models NOT tenant-scoped

- `User` — managed by admin / self.
- `LiveSession` — global engine marker.
- `Setting` (if any) — global configuration.
- `EquitySnapshot` rows tagged with `source = 'backtest'` belong to whoever ran the backtest; the relation is via `BrokerAccount` → `User`.

## 11. Email scoping

`notifyTradeOpened` (existing) — scope change:

```ts
// before
await mailService.notifyTradeOpened(payload);   // sends to ALL active users

// after
const owner = await prisma.user.findUnique({
  where: { id: brokerAccount.userId },
  select: { email: true, isActive: true },
});
if (owner?.isActive) {
  await mailService.notifyTradeOpened({ to: owner.email, ...payload });
}
```

**Out of scope** (deferred): daily summary, weekly digest, broker-disconnect alerts.

## 12. Edge cases — system-wide

| Case | Behaviour |
|---|---|
| Friend deletes their last broker account | Soft delete row (`deletedAt`); orchestrator persists final state to Redis then evicts. Status pill becomes "No accounts". |
| Friend pauses mid-tick | Pause checked at fan-out start. In-flight signal evaluation completes (no risk of partial state). Next tick respects the pause. |
| Friend resumes after multi-day pause | Orchestrator restored from Redis (preserves cooldowns, actionedSweeps). Daily-loss counter resets only on UTC day boundary, not on resume. |
| Admin deactivates user with open positions | Bot pauses (no new entries). Open positions continue to SL/TP — broker doesn't care about our `isActive` flag. Admin warned in confirmation modal. |
| Friend hits preset switcher mid-day | New preset applies at next M15 tick. Open positions keep original SL/TP. Risk-manager uses new params for next entry. |
| Two friends, same pair, same signal at 14:00 | Both get evaluated; both can enter; both stored under their own `accountId` + `userId`. No cross-user contention. |
| Friend's BrokerAccount gets force-disabled by admin | Same as friend disabling it. Persists state, evicts orchestrator after 5min grace. |
| Refresh-token reuse detected | Entire chain revoked; friend forced to re-login on all devices. |
| Friend changes email | Not in scope. Defer to a follow-up. |
| Friend forgets password | Existing `/auth/forgot-password` + `reset-password.hbs` flow — works unchanged. |

## 13. Rollout

Each step is shippable independently. Default behaviour is "today's state — 1 user, no invites issued" until step 10.

| # | Step | Reversible? | Notes |
|---|---|---|---|
| 1 | Prisma migration (schema additions, `DayNote.userId` nullable) | Yes — drop columns/table | Existing engine keeps running unchanged |
| 2 | Backfill script (`scripts/backfill-spec2.ts`) — assign DayNotes + flip your role to SUPERADMIN | Yes — re-run with null reset | Idempotent |
| 3 | Tighten `DayNote.userId` NOT NULL | Yes — drop NOT NULL | After step 2 |
| 4 | Backend: `/auth/refresh` + `RefreshToken` + invite endpoints (no UI consumer yet) | Yes — code revert | Endpoints exist but unused |
| 5 | Backend: engine gates on `user.botEnabled && user.isActive` | Yes — code revert | You're SUPERADMIN with both true → no behavior change |
| 6 | Backend: preset resolution + per-user `notifyTradeOpened` scope | Yes — code revert | You're BALANCED (= current params) → no behavior change |
| 7 | Web: refresh-token interceptor + auth context update | Yes — code revert | Backwards-compatible during transition |
| 8 | Web: Friend dashboard redesign + Settings + Preset switcher | Yes — code revert | Visual change only |
| 9 | Web: `/admin/*` section (SUPERADMIN-only) | Yes | First time you create an invite from `/admin/invites` |
| 10 | First friend invite (`alice@`) — manual smoke test | n/a | End-to-end verification |

**Feature flags:** none required. The system is "today's behaviour" until step 10.

## 14. Testing strategy

| Layer | Test | File (approximate) |
|---|---|---|
| Unit | `PRESETS` map resolves each `PresetKey` correctly | `src/strategy/presets.spec.ts` |
| Unit | `RolesGuard` blocks non-SUPERADMIN on `/admin/*` | `src/auth/guards/roles.guard.spec.ts` |
| Unit | `RefreshTokenService` rotates token + detects reuse | `src/auth/refresh-token.service.spec.ts` |
| Unit | Invite token hashing (argon2id) + verification | `src/invites/invite.service.spec.ts` |
| Integration | Engine skips fan-out when `user.botEnabled = false` | `src/strategy/live/live-strategy.service.spec.ts` |
| Integration | Engine skips fan-out when `user.isActive = false` | same |
| Integration | `notifyTradeOpened` emails only the trade owner | `src/mail/mail.service.spec.ts` |
| E2E | Seed alice + bob; alice's `/dashboard` returns only alice's trades | `test/multi-tenant.e2e-spec.ts` |
| E2E | SUPERADMIN can see both users' data via `/admin/users` | same |
| E2E | Non-SUPERADMIN gets 404 on `/admin/*` | same |
| E2E | Invite flow: create → accept → JWT issued → friend can log in | `test/invite.e2e-spec.ts` |
| E2E | Refresh-token rotation: 401 → refresh → retry succeeds | `test/auth-refresh.e2e-spec.ts` |
| E2E | Refresh-token reuse: replaying a revoked token kills the chain | same |
| Smoke | Existing single-user trading produces a trade with no behaviour change | manual; check next live signal post-deploy |

## 15. Rollback plan

- **Phase 1–3 (DB):** all additive; safe in place. Worst case, drop `Invite`, `RefreshToken`, and the new `User`/`DayNote` columns.
- **Phase 4–6 (backend):** revert via redeploy. No data corruption risk — gates default-open for you.
- **Phase 7–8 (web):** revert via redeploy. Friend-side UI not exposed yet.
- **Phase 9–10 (admin + invites):** revoke any issued invites via `/admin/invites` before rollback. If a friend has already signed up, **don't** drop their `User` row — disable via `isActive = false` instead, so their data survives a re-launch.

## 16. Out of scope (deferred)

- Public registration / self-serve signup.
- Billing, subscriptions, plan tiers.
- Friend-to-friend visibility (house feed) — explicitly rejected in §2 decision 3.
- Per-user broker credential keys (KMS upgrade) — current shared master key is acceptable for friends-tier.
- Multi-strategy support — single strategy by design.
- User impersonation in admin panel — discussed during brainstorm; deferred to future iteration. Useful for debugging a friend's reported issue, but adds effective-user vs session-user complexity that isn't justified at 5–10 users.
- Email change flow for friends — defer.
- Audit log of admin actions — defer to SaaS phase.
- Cross-tenant aggregate metrics page (e.g., "house P&L curve") — defer.

## 17. Forward-compatibility notes (for Spec 3 and SaaS)

- **Per-user broker credential keys:** `BrokerAccount.encryptedCreds` uses a shared master key today (from Spec 1). KMS migration unblocked once Spec 2 lands; it's a refactor of `CryptoService` and a re-encrypt script. No schema changes needed.
- **Public registration:** when SaaS lands, `POST /auth/register` is added alongside `/invites/:token/accept`. Most of the user-creation logic is already shared.
- **Audit log:** add `AdminAction` table when needed — independent of this spec.
- **Per-pair / per-user broker symbol mapping** (Spec 3 territory): preset filters on `pairs[]` already, so a future per-user pair subset is a natural extension.

## 18. Estimated scope

~18–22 implementation tasks for the plan. Single PR family on a single branch. Estimated 4–6 days focused work + 1 day validation.
