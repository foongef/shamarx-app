# Dashboard Analytics + Per-User Backtest/Replay — Design Spec

**Status:** Draft for review
**Date:** 2026-06-09
**Position:** Follow-up to Spec 2 (multi-tenant Friends + Me). Independent of Spec 3 (Moo Moo / broker abstraction).
**Scope:** Single spec, single implementation plan. No sub-decomposition needed.

## 1. Goal

Turn the dashboard from "is the bot working?" into "how is the bot performing?" — for both USER and SUPERADMIN — and open backtest/replay to every user under per-user scoping.

Spec 2 made the system multi-tenant. The dashboard it shipped is status-focused (equity number, status pill, open positions, today's trades). That answers "is the bot working" but not "how is the strategy doing over time" — which is what the user actually opens the dashboard to learn after the first week.

This spec rewrites `/dashboard` to surface real performance analytics, appends SUPERADMIN-only aggregate panels for cross-tenant oversight, and fixes the broken `/admin/backtest` link by giving every user (not just SUPERADMIN) per-user-scoped backtest and replay access.

## 2. Decisions captured during brainstorming

| # | Decision | Reason |
|---|---|---|
| 1 | Hero is a 2-column split — Live status (left) + Performance (right), equal weight | User explicitly wanted both, not "status only" or "performance only" |
| 2 | SUPERADMIN sees personal dashboard + aggregate panels appended below (same `/dashboard` route) | "my view + house view" mental model; no view-switching friction |
| 3 | Hero performance metric = **net return % since inception** | Familiar, motivating, easy to compare across users |
| 4 | SUPERADMIN suggestions = **trend detection + rule-based flags** (no LLM) | Smart enough to surface real issues, no LLM cost/latency for 5–10 users |
| 5 | Layout direction = **Spacious** (full-width equity chart, big numbers) | Story-first, the equity chart deserves real estate |
| 6 | Backtest + replay are **per-user private** | Matches Spec 2's "fully private" rule. SUPERADMIN gets a separate cross-tenant view at `/admin/backtest`. |
| 7 | Compute strategy: **on-demand**, no pre-computed aggregates | Cheap for 5–10 users; revisit at >50 users |
| 8 | No feature flags | Default behaviour preserves existing single-user world; flags add complexity without gain |

## 3. Architecture overview

```
                         JWT(userId, role)
                                ↓
  Web (/dashboard) ──→ NestJS controllers ──→ services ──→ Prisma
                                ↓
              user-scoped reads + role-aware aggregates
                                ↓
                            Postgres
```

**What changes:**

| Layer | Change |
|---|---|
| DB schema | `BacktestRun.userId`, `LiveReplaySession.userId`, `User.pausedAt` — all nullable, additive. |
| Backend analytics | New `LiveAnalyticsService` methods (`snapshot`, `equityCurve`, `riskUsedToday`). New `AdminAnalyticsService` for cross-tenant aggregates + flags + trends. |
| Backend permissions | `BacktestController` and replay controller become user-scoped (drop `@Roles('SUPERADMIN')` if present; add `@CurrentUser()`). New `AdminBacktestController` under `AdminModule`. |
| Backend `MeController` | `botEnabled: false` → set `User.pausedAt = now()`; `botEnabled: true` → clear. Single 4-line change. |
| Web sidebar | Restore Backtest + Replay to WORKSPACE. Fix broken `/admin/backtest` link → real route. |
| Web dashboard | Full rewrite of `/dashboard` page — Spacious layout. SUPERADMIN sees aggregate panels appended. |
| Web admin | New `/admin/backtest` cross-tenant page (separate file, wrapped by existing `AdminLayout`). |
| New web components | `LiveStatusPanel`, `PerformanceHero`, `EquityCurve` (wraps lightweight-charts), `SnapshotTile`, `TodayTrades`, `RiskUsedGauge`, `SuperadminAggregate`, `StrategyHealthPanel`, `FlagsPanel`, `UserPerformanceTable`. |

**What stays untouched:**
- Auth, invites, refresh tokens, preset system — all from Spec 2.
- Sidebar pattern (just nav-item additions/edits).
- Topbar `StatusPill` — kept as-is; the new dashboard hero has its own larger live panel but the topbar pill is the global "always visible" indicator.
- Strategy engine, mail scoping, broker integration — none of that changes.
- The existing `/backtest`, `/backtest/new`, `/backtest/:id`, `/replay`, `/replay/:id` page **files** stay where they are. Only their backend scoping changes.

**One-line summary:** Spec 2.5 makes the dashboard *say something*. Spec 2 made it work; this makes it useful.

## 4. Data model

### 4.1 New / modified models

```prisma
model BacktestRun {
  // ...existing fields
  userId String?
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([userId])
}

model LiveReplaySession {
  // ...existing fields
  userId String?
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([userId])
}

model User {
  // ...existing fields
  pausedAt  DateTime?

  backtestRuns        BacktestRun[]
  liveReplaySessions  LiveReplaySession[]
}
```

`onDelete: SetNull` mirrors `Invite.createdById` from Spec 2 — historical runs survive admin deletion. After backfill, leave the columns nullable (no NOT NULL tightening) — future pre-history may exist.

### 4.2 Migration plan

Hand-craft SQL since local Postgres is off and prod uses `prisma db push`:

| Migration | Action | Risk |
|---|---|---|
| `<ts>_backtest_replay_userid` | `ALTER TABLE "BacktestRun" ADD COLUMN "userId" TEXT`, FK, index. Same for `LiveReplaySession`. | None — additive |
| `<ts>_user_pausedat` | `ALTER TABLE "User" ADD COLUMN "pausedAt" TIMESTAMP(3)` | None — nullable, no default |

### 4.3 Backfill script

`scripts/backfill-spec2-5.ts` — same pattern as the (now-fixed) `backfill-spec2.ts`:

```ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const me = await prisma.user.findFirstOrThrow({ where: { role: 'SUPERADMIN' } });

  const btCount = await prisma.$executeRawUnsafe(
    `UPDATE "BacktestRun" SET "userId" = $1 WHERE "userId" IS NULL`,
    me.id,
  );
  console.log(`Backfilled ${btCount} BacktestRun rows`);

  const replayCount = await prisma.$executeRawUnsafe(
    `UPDATE "LiveReplaySession" SET "userId" = $1 WHERE "userId" IS NULL`,
    me.id,
  );
  console.log(`Backfilled ${replayCount} LiveReplaySession rows`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

Idempotent. No `User.pausedAt` backfill needed — natively nullable means "never paused".

## 5. Backend analytics

### 5.1 User-scoped endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/me/analytics/snapshot` | `{ netReturnPct, mtdPct, winRate, maxDd, expectancy, tradesCount, equity }` lifetime |
| `GET` | `/api/me/analytics/equity-curve?days=90` | `Array<{ date: ISOString, equity: number }>` |
| `GET` | `/api/me/analytics/risk-used` | `{ pctUsedToday, dailyLossLimit, openRiskPct }` |

All gated by `JwtAuthGuard`. Service layer (`LiveAnalyticsService`) adds the new methods alongside the existing `stats`, `listTrades`, etc. — same scoping pattern (`where: { account: { userId } }`).

### 5.2 SUPERADMIN-scoped endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/admin/analytics/aggregate` | `{ totalUsers, activeUsers, totalAccounts, enabledAccounts, totalEquity, dayDelta, tradesToday }` |
| `GET` | `/api/admin/analytics/users` | Per-user performance: `Array<{ id, email, presetKey, equity, mtdPct, winRate, maxDd, lastTradeAt, status, botEnabled, isActive, pausedAt }>` |
| `GET` | `/api/admin/analytics/trends` | `{ flags: Flag[], trends: Trend[], strategyStatus: 'HEALTHY' | 'WATCHING' | 'DEGRADED' }` |

All under `AdminModule`, gated by `@Roles('SUPERADMIN')`. Implemented in new `AdminAnalyticsService` at `src/admin/analytics/admin-analytics.service.ts`.

### 5.3 Strategy baseline constants

Frozen constants from `STRATEGY.md`:

```ts
// src/admin/analytics/baseline.ts
export const STRATEGY_BASELINE = {
  source: 'Spec 1 validation, 28-month backtest',
  trades: 686,
  winRate: 0.649,
  expectancy: 0.42,        // R
  avgRR: 1.6,
  maxDdPct: 4.1,
} as const;
```

These become the comparison anchor for trend drift.

### 5.4 Flags (rule-based, hard thresholds)

| Flag | Severity | Trigger | Source |
|---|---|---|---|
| `DD_ALERT` | 🔴 loss | user `currentDdPct > 5%` | per-user equity curve vs all-time peak |
| `DAILY_LOSS_HIT` | 🔴 loss | user's `RiskState.dailyLossLimitHit = true` today | existing `RiskState` table |
| `BROKER_DOWN` | 🔴 loss | user has ≥1 `BrokerAccount` where `healthOk = false` > 15 min | existing `BrokerAccount.lastHealthCheckAt` |
| `PAUSE_WATCH` | 🟡 signal | `botEnabled = false` AND `pausedAt > 7 days ago` | new `User.pausedAt` |
| `INACTIVE_USER` | 🟡 signal | `lastLoginAt > 14 days ago` AND ≥1 enabled account | existing `User.lastLoginAt` |
| `NO_ACCOUNTS` | ⚪ neutral | `botEnabled = true` AND 0 enabled accounts | existing |

Computed in `AdminAnalyticsService.computeFlags(users, accounts, riskStates)` — pure function, single pass. Returns `Flag[]` sorted by severity. Runs on every `/api/admin/analytics/trends` request — no caching, no cron.

### 5.5 Trends (rolling window vs baseline)

| Trend | Computation | Surfaced when |
|---|---|---|
| `WR_DRIFT` | 30d rolling WR across all users vs `STRATEGY_BASELINE.winRate` | `abs(drift) > 5pp` for ≥10 trades |
| `EXPECTANCY_DRIFT` | 30d rolling expectancy vs `+0.42R` | `abs(drift) > 0.1R` for ≥10 trades |
| `PAIR_DIVERGENCE` | per-pair 30d expectancy; flag if best/worst gap > 1.0R | always (informational) |
| `PRESET_DIVERGENCE` | per-preset 30d return; defer until CONSERVATIVE/AGGRESSIVE have ≥30 trades each | when threshold reached |

Each returns `{ name, direction: 'up' | 'down', magnitude, sampleSize, recommendation: string }`.

### 5.6 Strategy status pill (aggregate of flags + trends)

| Pill | Condition |
|---|---|
| 🟢 **HEALTHY** | No 🔴 flags AND WR drift ≤ 3pp |
| 🟡 **WATCHING** | 1 🔴 flag OR WR drift between 3–5pp |
| 🔴 **DEGRADED** | 2+ 🔴 flags OR WR drift > 5pp OR expectancy drift > 0.15R for 30+ trades |

Rendered at top of the Strategy Health panel for SUPERADMIN.

### 5.7 Compute strategy

On-demand. Prisma `aggregate` against `Trade` — `<50ms` for 5–10 users with ~100–1000 trades each. No materialized views, no daily-snapshot table, no cron.

If user count later exceeds ~50, swap to a daily `EquityAggregate` snapshot table — schema migration only, service signatures stable.

## 6. USER dashboard layout

### 6.1 Concrete regions (top to bottom)

```
┌─────────────────────────────────────────────────────────────────────┐
│  HERO ROW (2 col split, equal width)                                │
│  ┌────────────────────────┐  ┌────────────────────────────┐         │
│  │  LIVE STATUS           │  │  PERFORMANCE               │         │
│  │  🟢 Bot is live        │  │  +12.8%                    │         │
│  │  • BALANCED preset     │  │  since inception · $10,420 │         │
│  │  OPEN  TODAY  RISK     │  │  ▁▃▅▇▇█  (bar sparkline)   │         │
│  │   2    +$120  42%      │  │                            │         │
│  └────────────────────────┘  └────────────────────────────┘         │
├─────────────────────────────────────────────────────────────────────┤
│  EQUITY CURVE (full width, ~150px)                                  │
│  lightweight-charts line chart, last 90 days, hover for $/date      │
├─────────────────────────────────────────────────────────────────────┤
│  SNAPSHOT (4 tiles, left)         │  TODAY · N TRADES (right)       │
│  ┌──┬──┐                          │  ┌──────────────────┐           │
│  │MTD│WR│                         │  │09:42 EURUSD +$42 │           │
│  ├──┼──┤                          │  │11:15 GBPUSD −$18 │           │
│  │DD │EX│                         │  │14:08 XAUUSD +$96 │           │
│  └──┴──┘                          │  └──────────────────┘           │
├─────────────────────────────────────────────────────────────────────┤
│  SUPERADMIN-ONLY AGGREGATE PANELS (Section 7) — visible if role=SA  │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 Region-by-region wiring

| Region | Component | Data source |
|---|---|---|
| Live status (LHS hero) | `LiveStatusPanel` (NEW) | `useMe()`, `useBrokerAccounts()`, `api.liveStatus()`, `api.livePositions()` |
| Performance hero (RHS) | `PerformanceHero` (NEW) | `/api/me/analytics/snapshot` (netReturnPct + equity) |
| Performance sparkline | `Sparkline` (existing) | derived from snapshot's last-90d points |
| Equity curve (full-width) | `EquityCurve` (NEW, wraps lightweight-charts) | `/api/me/analytics/equity-curve?days=90` |
| Snapshot tiles (×4) | `SnapshotTile` (NEW, generic) | snapshot — `mtdPct`, `winRate`, `maxDd`, `expectancy` |
| Today list | `TodayTrades` (NEW, refactor of existing dashboard inner block) | filter live trades by today's date |
| Risk-used gauge (in LHS) | `RiskUsedGauge` (NEW) | `/api/me/analytics/risk-used` |

### 6.3 Removed from current Spec 2 dashboard

- ❌ Quick-action cards (Preset/Accounts/Equity-curve nav cards) — moved to sidebar; no longer needed on the dashboard
- ❌ Standalone open-positions card — replaced by the count in the live status panel (with "View all →" link to `/lives`)

### 6.4 Empty states

| Condition | Behaviour |
|---|---|
| New user, no trades | Equity curve: "Bot has been live for X hours · 0 trades yet". Snapshot tiles show "—". |
| Bot paused | Live status shows 🟡 "Paused" pill (matches existing StatusPill). Performance still renders historical data. |
| No accounts enabled | Live status shows ⚪ "No enabled accounts" with CTA → `/accounts`. |
| Equity curve fails to load | Curve region shows "Unable to load" with retry; snapshot tiles still render from cached snapshot if available. |

### 6.5 Component file structure

```
src/components/dashboard/
  live-status-panel.tsx
  performance-hero.tsx
  equity-curve.tsx                  ← wraps lightweight-charts; one chart, scoped data
  snapshot-tile.tsx                 ← reused as 4 instances, also reused by SUPERADMIN panel
  today-trades.tsx                  ← lifted out of current dashboard
  risk-used-gauge.tsx
  superadmin-aggregate.tsx          ← root wrapper for SUPERADMIN-only block (§7)
  strategy-health-panel.tsx         ← inside superadmin-aggregate
  flags-panel.tsx                   ← inside superadmin-aggregate
  user-performance-table.tsx        ← inside superadmin-aggregate
```

Each component reads its own hook, renders independently, gracefully handles loading/empty. The page assembles them in a grid.

## 7. SUPERADMIN aggregate panels (appended below personal dashboard)

Visible only when `role === 'SUPERADMIN'`. Wrapped in a single labeled card so it's visually distinct from personal content.

### 7.1 Regions

| Region | Component | Data |
|---|---|---|
| House Overview (4 tiles) | `SnapshotTile` × 4 (reused) | `/api/admin/analytics/aggregate`: users, accounts, house equity, trades 24h |
| Strategy Health | `StrategyHealthPanel` | `/api/admin/analytics/trends` — WR/expectancy/avg R:R vs baseline, house equity curve, **strategy status pill** at top |
| Flags | `FlagsPanel` | `/api/admin/analytics/trends.flags` — sorted by severity, color-coded |
| Users · Performance table | `UserPerformanceTable` | `/api/admin/analytics/users` |

### 7.2 Per-user row click-through

Row click → `/admin/users/:id` (existing page from Spec 2 Task 13). That page gets a Section 7.3 extension to show per-user analytics (same components used on personal dashboard, scoped to that user via path).

### 7.3 Per-user drill-in (`/admin/users/:id` extension)

Add to the existing admin user-detail page:
- `PerformanceHero` rendered for that user (NEW endpoint: `/api/admin/analytics/users/:id/snapshot`)
- `EquityCurve` for that user (`/api/admin/analytics/users/:id/equity-curve?days=90`)
- 4× `SnapshotTile`

Same components, different data source. Hides the live-status panel (not meaningful for impersonation; the user owns their live state).

### 7.4 Empty SUPERADMIN view

- Only SUPERADMIN exists, no friends → still functional. House overview shows `users: 1`. Per-user table shows your single row. Flags panel typically empty.
- ≤10 trades total → trend panel shows "Not enough trades yet to detect drift." Flags still compute.

## 8. Backtest + Replay

### 8.1 Sidebar restoration

| Section | After Spec 2.5 |
|---|---|
| WORKSPACE | Overview · Live · Journal · Accounts · **Backtest** · **Replay** |
| SETTINGS | Preferences |
| ADMIN (SUPERADMIN-only) | Users · Invites · Sessions · Engine · **All Backtests** (`/admin/backtest`) |

The broken `/admin/backtest` link from Spec 2 Task 19 now points at the new real cross-tenant page.

### 8.2 Page-level routing

| Route | Who | What |
|---|---|---|
| `/backtest` | any authenticated user | own backtest runs only (scoped) |
| `/backtest/new` | any | create form, run attributed to current user |
| `/backtest/:id` | any | own run only; 404 if accessed for someone else's id |
| `/replay` | any | own replay sessions only |
| `/replay/:id` | any | own only; 404 otherwise |
| `/admin/backtest` | SUPERADMIN | cross-tenant table of every user's runs + drill-in |
| `/admin/backtest/:id` | SUPERADMIN | any user's run detail (same component as `/backtest/:id`, different scope) |

No page files move. The existing `src/app/backtest/page.tsx` etc. stay put. New `src/app/admin/backtest/page.tsx` and `/admin/backtest/[id]/page.tsx` added, wrapped by `AdminLayout`.

### 8.3 Backend scoping

- `BacktestController` gains `@CurrentUser()`. `BacktestService` queries gain `where: { userId }`. Create endpoint injects `userId = currentUser.id` server-side; ignores any client-provided value.
- Same for the replay controller.
- New `AdminBacktestController` under `AdminModule`, `@Roles('SUPERADMIN')`, returns cross-tenant data via a new `AdminBacktestService`.

### 8.4 Cost guardrail (lightweight)

`BacktestService.createAndRun` rejects with `409 Conflict` if the user has ≥2 PENDING/RUNNING jobs at submission time. Message: "You already have running backtests. Wait for them to finish."

No queueing, no per-user quotas. Trust + simple guard is enough for "Friends + Me".

### 8.5 Friend UX

- `New Run` form unchanged. Same params (symbol, date range, risk %, strategy version).
- Friends see only their own runs in the list. No friend-to-friend visibility.
- Friends never see `/admin/backtest`. `AdminLayout` redirects them to `/dashboard`.

## 9. `User.pausedAt` mechanics

| Trigger | Action |
|---|---|
| `PATCH /me { botEnabled: false }` | Set `User.pausedAt = new Date()` |
| `PATCH /me { botEnabled: true }` | Set `User.pausedAt = null` |
| `PATCH /admin/users/:id/bot-enabled { botEnabled: false }` | Same set |
| `PATCH /admin/users/:id/bot-enabled { botEnabled: true }` | Same clear |

4-line additions to `MeController.updateMe` and `AdminUsersService.setBotEnabled`. Read by `PAUSE_WATCH` flag (Section 5.4).

## 10. Migration sequencing (production)

| # | Step | Reversible? | Notes |
|---|---|---|---|
| 1 | Merge backend PR → `prisma db push` applies all three schema additions | Yes — drop cols | Additive, zero behaviour change |
| 2 | Backfill via SSM: `docker exec trading-bot-app npx ts-node scripts/backfill-spec2-5.ts` | Idempotent | Required so historical backtests land in your view |
| 3 | Backend code starts USER-scoping `/api/backtest/*` and `/api/replay/*` queries; new analytics endpoints live | Code revert | Existing UI keeps working — admin sees own runs |
| 4 | Merge web PR → Amplify rebuilds | Code revert | New dashboard renders, sidebar restored |
| 5 | First friend invite → real multi-tenant validation | n/a | Smoke test |

No flags. Default state preserves existing single-user behaviour.

## 11. Testing strategy

| Layer | Test | File |
|---|---|---|
| Unit | `STRATEGY_BASELINE` matches `STRATEGY.md` numbers | `src/admin/analytics/baseline.spec.ts` |
| Unit | `AdminAnalyticsService.computeFlags()` — seeded users → expected `Flag[]` for each of the 6 rules | `src/admin/analytics/admin-analytics.service.spec.ts` |
| Unit | `AdminAnalyticsService.computeTrends()` — seeded trades → expected `Trend[]` with correct magnitude/direction | same |
| Unit | `LiveAnalyticsService.snapshot(userId)` — correct `netReturnPct`, `mtdPct`, `winRate`, `maxDd`, `expectancy` | extend existing spec |
| Unit | `LiveAnalyticsService.equityCurve(userId, days)` — daily-point array of expected length | same |
| Integration | `MeController.updateMe({ botEnabled: false })` writes `pausedAt`; `true` clears | extend `me.controller.spec.ts` |
| Integration | `AdminUsersService.setBotEnabled` writes/clears `pausedAt` same way | extend `admin-users.service.spec.ts` |
| Integration | `BacktestService.createAndRun` rejects when user has ≥2 PENDING/RUNNING (409) | `backtest.service.spec.ts` |
| Integration | `BacktestController.list` returns only current user's runs; admin route returns all | `backtest.controller.spec.ts` |
| E2E | Friend creates backtest → cannot see admin's runs at `/api/backtest`; admin sees both at `/api/admin/backtest` | new `test/backtest-isolation.e2e-spec.ts` |
| E2E | `/api/admin/analytics/users` returns aggregate for SUPERADMIN; 403 for friend | extend `multi-tenant-isolation.e2e-spec.ts` |
| Smoke (manual, post-deploy) | `/dashboard` as you → Spacious layout renders with real prod data; SUPERADMIN panels appear below | — |
| Smoke (manual, post-first-invite) | Friend visits `/dashboard` → personal panels only, no admin block | — |

## 12. Rollback plan

- **Backend revert** = redeploy previous commit. New endpoints disappear; the unused `userId` and `pausedAt` columns linger harmlessly until cleaned up.
- **Web revert** = redeploy previous Amplify build. Old (Spec 2) dashboard returns. New components are file-only; their absence breaks nothing.
- **Schema rollback** (worst case, unlikely) = `ALTER TABLE "BacktestRun" DROP COLUMN "userId"`, same for the other two. Manual via SSM psql.

## 13. Out of scope

- LLM-generated weekly narrative (rejected at brainstorm Q4).
- Pre-computed aggregate snapshots / materialized views (rejected in §5.7 — fine to revisit at >50 users).
- Per-user rate limits or backtest job queueing (single-check guard in §8.4 is enough).
- House feed / friend-to-friend visibility (excluded by Spec 2 §2 decision 3).
- Multi-strategy support (still one strategy).
- Mobile-first redesign (existing responsive patterns hold; revisit on friend feedback).
- Per-strategy backtest comparison UI (the comparison logic exists in `scripts/compare-smc-gates.ts`; surfacing it in the web would be its own spec).

## 14. Forward-compatibility notes

- When CONSERVATIVE and AGGRESSIVE presets accumulate ≥30 trades each, `PRESET_DIVERGENCE` trend goes from latent to active. No code change needed — threshold trips automatically.
- If user count >50, swap `AdminAnalyticsService` snapshot methods from on-demand Prisma aggregates to a daily `EquityAggregate` snapshot table. Schema migration only; service signatures stable.
- The trend-detection module is intentionally small (3 trend types). An LLM narrative layer could later wrap it ("here's what changed this week") without rewriting the underlying math.
- The flag/trend `recommendation: string` field is already a foothold for richer messaging — could be templated, internationalized, or LLM-augmented later.

## 15. Estimated scope

~14–18 implementation tasks. Smaller than Spec 2 because the plumbing (auth, role guards, AdminLayout, refresh tokens, sidebar pattern) already exists. Bulk of the work:

- Backend (~6 tasks): schema + backfill, analytics services (user + admin), backtest scoping + admin controller, `pausedAt` writes, flag/trend logic.
- Web (~7 tasks): dashboard page rewrite, 9 new components, sidebar update, new `/admin/backtest` page + drill-in.
- Tests + smoke (~2 tasks).
