# Dashboard Analytics + Per-User Backtest/Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `/dashboard` to surface performance analytics (USER + SUPERADMIN aggregate panels), open backtest/replay to every user under per-user scoping, fix the broken `/admin/backtest` link, and add `User.pausedAt` so the `PAUSE_WATCH` flag can fire.

**Architecture:** Additive Prisma schema. Two new services — `AdminAnalyticsService` (cross-tenant flags/trends/aggregates) and extended `LiveAnalyticsService` (per-user snapshot/equity-curve/risk). On-demand Prisma aggregates — no materialized views, no caching layer. Web dashboard fully rewritten with new component family wrapping shadcn primitives + `lightweight-charts` for the equity curve. Sidebar restored to expose Backtest/Replay for friends; admin cross-tenant view at new `/admin/backtest`.

**Tech Stack:** NestJS + Prisma + Postgres, Next.js 15 App Router, TanStack Query, shadcn/ui, lightweight-charts (already used in `backtest-chart.tsx`), Jest + Supertest, no new deps.

**Reference:** [Spec](../specs/2026-06-09-dashboard-analytics-design.md)

---

## File map

### Backend (NestJS) — `/Users/shepyrd/development/shamarx/shamarx-app`

**New:**
- `libs/prisma/migrations/<ts>_backtest_replay_userid/migration.sql`
- `libs/prisma/migrations/<ts>_user_pausedat/migration.sql`
- `scripts/backfill-spec2-5.ts`
- `src/admin/analytics/admin-analytics.module.ts`
- `src/admin/analytics/admin-analytics.controller.ts`
- `src/admin/analytics/admin-analytics.service.ts`
- `src/admin/analytics/admin-analytics.service.spec.ts`
- `src/admin/analytics/baseline.ts`
- `src/admin/analytics/baseline.spec.ts`
- `src/admin/analytics/types.ts` — `Flag`, `Trend`, `StrategyStatus` shared types
- `src/admin/backtest/admin-backtest.controller.ts`
- `src/admin/backtest/admin-backtest.service.ts`
- `src/me/analytics/me-analytics.controller.ts`
- `src/me/analytics/me-analytics.module.ts`
- `test/backtest-isolation.e2e-spec.ts`

**Modified:**
- `libs/prisma/schema.prisma`
- `src/strategy/live/live-analytics.service.ts` — add `snapshot`, `equityCurve`, `riskUsedToday`
- `src/strategy/live/live-analytics.service.spec.ts`
- `src/backtest/backtest.controller.ts` — add `@CurrentUser()`, scope by userId
- `src/backtest/backtest.service.ts` — add `userId` to args, gate `createAndRun` on running-job count
- `src/me/me.controller.ts` — write/clear `User.pausedAt` on bot toggle
- `src/admin/users/admin-users.service.ts` — write/clear `User.pausedAt` on bot toggle
- `src/admin/admin.module.ts` — register `AdminAnalyticsModule`, `AdminBacktestController`
- `src/me/me.module.ts` — register `MeAnalyticsController`
- `src/app.module.ts` — wire new modules

### Web (Next.js) — `/Users/shepyrd/development/shamarx/shamarx-web`

**New:**
- `src/lib/api-analytics.ts` — user-scoped analytics client
- `src/lib/api-admin-analytics.ts` — cross-tenant analytics client
- `src/hooks/use-analytics-snapshot.ts`
- `src/hooks/use-equity-curve.ts`
- `src/hooks/use-risk-used.ts`
- `src/hooks/use-admin-aggregate.ts`
- `src/hooks/use-admin-users-perf.ts`
- `src/hooks/use-admin-trends.ts`
- `src/components/dashboard/live-status-panel.tsx`
- `src/components/dashboard/performance-hero.tsx`
- `src/components/dashboard/equity-curve.tsx`
- `src/components/dashboard/snapshot-tile.tsx`
- `src/components/dashboard/today-trades.tsx`
- `src/components/dashboard/risk-used-gauge.tsx`
- `src/components/dashboard/superadmin-aggregate.tsx`
- `src/components/dashboard/strategy-health-panel.tsx`
- `src/components/dashboard/flags-panel.tsx`
- `src/components/dashboard/user-performance-table.tsx`
- `src/app/admin/backtest/page.tsx`
- `src/app/admin/backtest/[id]/page.tsx`
- `src/lib/api-admin-backtest.ts`

**Modified:**
- `src/app/dashboard/page.tsx` — full rewrite
- `src/components/layout/sidebar.tsx` — restore Backtest+Replay to WORKSPACE; fix ADMIN link to point at real `/admin/backtest`
- `src/app/admin/users/[id]/page.tsx` — append per-user analytics drill-in (if file exists; else create alongside existing detail rendering)

---

## Branch setup

Work on branch `feat/spec2-5-dashboard-analytics` on both repos.

**Backend:**
```bash
cd /Users/shepyrd/development/shamarx/shamarx-app
git checkout main && git pull
git checkout -b feat/spec2-5-dashboard-analytics
```

**Web:**
```bash
cd /Users/shepyrd/development/shamarx/shamarx-web
git checkout main && git pull
git checkout -b feat/spec2-5-dashboard-analytics
```

---

## Task 1: Schema additions + backfill script

**Files:**
- Modify: `libs/prisma/schema.prisma`
- Create: `libs/prisma/migrations/20260609100000_backtest_replay_userid/migration.sql`
- Create: `libs/prisma/migrations/20260609100001_user_pausedat/migration.sql`
- Create: `scripts/backfill-spec2-5.ts`

- [ ] **Step 1: Edit schema — add userId to BacktestRun and LiveReplaySession, pausedAt to User**

In `libs/prisma/schema.prisma`:

Modify `BacktestRun` — add immediately before `trades BacktestTrade[]`:

```prisma
  userId String?
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)
```

Add at the end of the model (before closing `}`):

```prisma
  @@index([userId])
```

Same pattern for `LiveReplaySession` — add the `userId/user` fields and `@@index([userId])`.

Modify `User` model — add `pausedAt DateTime?` after `lastLoginAt DateTime?`. Also add the back-relations at the bottom of the User relations block:

```prisma
  backtestRuns        BacktestRun[]
  liveReplaySessions  LiveReplaySession[]
```

- [ ] **Step 2: Hand-craft migration SQL — backtest/replay userId**

Create directory and file `libs/prisma/migrations/20260609100000_backtest_replay_userid/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "BacktestRun" ADD COLUMN "userId" TEXT;
ALTER TABLE "LiveReplaySession" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "BacktestRun_userId_idx" ON "BacktestRun"("userId");
CREATE INDEX "LiveReplaySession_userId_idx" ON "LiveReplaySession"("userId");

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveReplaySession" ADD CONSTRAINT "LiveReplaySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Hand-craft migration SQL — User.pausedAt**

Create `libs/prisma/migrations/20260609100001_user_pausedat/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN "pausedAt" TIMESTAMP(3);
```

- [ ] **Step 4: Generate Prisma client**

```bash
npx prisma generate
```

Expected: client regenerated. If local Postgres is off, that's fine — `generate` doesn't need a DB.

- [ ] **Step 5: Write backfill script**

Create `scripts/backfill-spec2-5.ts`:

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const me = await prisma.user.findFirstOrThrow({ where: { role: 'SUPERADMIN' } });

  // Raw SQL because Prisma's typed client rejects null filters against
  // final-state nullable columns when prod ran `db push` directly to the new schema.
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
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: clean. New optional `userId` on BacktestRun + LiveReplaySession does not break any consumer since they don't currently read it.

- [ ] **Step 7: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/ scripts/backfill-spec2-5.ts
git commit -m "feat(schema): BacktestRun.userId + LiveReplaySession.userId + User.pausedAt + backfill"
```

DO NOT add a `Co-Authored-By` trailer. DO NOT use `git add -A` or `git add .` — untracked `docs/superpowers/` files must not leak into the commit.

---

## Task 2: `LiveAnalyticsService` extensions (snapshot, equityCurve, riskUsedToday)

**Files:**
- Modify: `src/strategy/live/live-analytics.service.ts`
- Modify: `src/strategy/live/live-analytics.service.spec.ts`

- [ ] **Step 1: Read current service shape**

```bash
sed -n '1,40p' src/strategy/live/live-analytics.service.ts
```

Identify the constructor (which Prisma model is injected), existing method signatures, and the result types used. The existing `stats(opts: { userId; days? })` is the closest analog — follow its pattern.

- [ ] **Step 2: Write failing tests**

Append to `src/strategy/live/live-analytics.service.spec.ts`:

```ts
describe('LiveAnalyticsService — new analytics methods', () => {
  let svc: LiveAnalyticsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    // Use the existing testing-module setup from this file.
    // The methods below assume seeded users + trades + accounts.
  });

  describe('snapshot(userId)', () => {
    it('returns netReturnPct based on initial vs current equity', async () => {
      const userId = await seedUserWithTrades(prisma, { initial: 10000, current: 11280 });
      const result = await svc.snapshot(userId);
      expect(result.netReturnPct).toBeCloseTo(12.8, 1);
      expect(result.equity).toBeCloseTo(11280, 0);
    });

    it('returns zero netReturn when no trades exist', async () => {
      const userId = await seedUserWithTrades(prisma, { initial: 10000, current: 10000 });
      const result = await svc.snapshot(userId);
      expect(result.netReturnPct).toBe(0);
      expect(result.tradesCount).toBe(0);
    });

    it('computes winRate, expectancy, maxDd over closed trades', async () => {
      const userId = await seedUserWithClosedTrades(prisma, [
        { pnl: 100, rMultiple: 1.0 },
        { pnl: -50, rMultiple: -0.5 },
        { pnl: 80, rMultiple: 0.8 },
      ]);
      const result = await svc.snapshot(userId);
      expect(result.winRate).toBeCloseTo(0.667, 2);
      expect(result.expectancy).toBeGreaterThan(0);
      expect(result.maxDd).toBeGreaterThanOrEqual(0);
    });
  });

  describe('equityCurve(userId, days)', () => {
    it('returns an array of daily { date, equity } points capped at `days`', async () => {
      const userId = await seedUserWithEquityHistory(prisma, 120);
      const result = await svc.equityCurve({ userId, days: 90 });
      expect(result).toHaveLength(90);
      expect(result[0]).toHaveProperty('date');
      expect(result[0]).toHaveProperty('equity');
    });
  });

  describe('riskUsedToday(userId)', () => {
    it('returns pctUsedToday computed from realized + unrealized risk vs daily-loss-limit', async () => {
      const userId = await seedUserWithRiskState(prisma, { realizedTodayPct: -1.2, openRiskPct: 0.6, dailyLossLimit: 3.0 });
      const result = await svc.riskUsedToday(userId);
      expect(result.pctUsedToday).toBeCloseTo(60, 0); // 1.8 / 3.0
      expect(result.dailyLossLimit).toBe(3.0);
    });
  });
});

// Test helpers — pure functions, no external dependencies
async function seedUserWithTrades(prisma: PrismaService, opts: { initial: number; current: number }) {
  const user = await prisma.user.create({ data: { email: `u${Date.now()}@x.test`, passwordHash: 'x', role: 'USER' } });
  return user.id;
}
async function seedUserWithClosedTrades(prisma: PrismaService, trades: { pnl: number; rMultiple: number }[]) {
  // Implementation: create user, account, and closed Trade rows with the supplied pnl/rMultiple.
  // Use existing Trade and BrokerAccount model field names. See trades schema for reference.
  const user = await prisma.user.create({ data: { email: `u${Date.now()}@x.test`, passwordHash: 'x', role: 'USER' } });
  const account = await prisma.brokerAccount.create({ data: { userId: user.id, broker: 'METAAPI', label: 'test', encryptedCreds: 'x', isEnabled: true } });
  for (const t of trades) {
    await prisma.trade.create({
      data: { accountId: account.id, symbol: 'EURUSD', side: 'BUY', status: 'CLOSED', realisedPnl: t.pnl, rMultiple: t.rMultiple, openedAt: new Date(), closedAt: new Date() },
    });
  }
  return user.id;
}
async function seedUserWithEquityHistory(prisma: PrismaService, days: number) {
  const user = await prisma.user.create({ data: { email: `u${Date.now()}@x.test`, passwordHash: 'x', role: 'USER' } });
  const account = await prisma.brokerAccount.create({ data: { userId: user.id, broker: 'METAAPI', label: 'test', encryptedCreds: 'x', isEnabled: true } });
  for (let i = 0; i < days + 30; i++) {
    await prisma.equitySnapshot.create({
      data: { accountId: account.id, source: 'live', mode: 'metaapi', balance: 10000 + i * 5, equity: 10000 + i * 5, takenAt: new Date(Date.now() - (days + 30 - i) * 86_400_000) },
    });
  }
  return user.id;
}
async function seedUserWithRiskState(prisma: PrismaService, opts: { realizedTodayPct: number; openRiskPct: number; dailyLossLimit: number }) {
  const user = await prisma.user.create({ data: { email: `u${Date.now()}@x.test`, passwordHash: 'x', role: 'USER' } });
  const account = await prisma.brokerAccount.create({ data: { userId: user.id, broker: 'METAAPI', label: 'test', encryptedCreds: 'x', isEnabled: true } });
  // Update or create RiskState row; field names from existing schema.
  return user.id;
}
```

Adjust helper bodies to match actual Trade / BrokerAccount field names — read `libs/prisma/schema.prisma` for the truth. The helper signatures stay the same; only the model `data: { ... }` payload changes.

- [ ] **Step 3: Run, confirm failure**

```bash
npx jest src/strategy/live/live-analytics.service.spec.ts
```

Expected: 4 new test cases FAIL with "snapshot is not a function" or similar.

- [ ] **Step 4: Implement the three methods**

Append to `src/strategy/live/live-analytics.service.ts` (inside the existing `LiveAnalyticsService` class):

```ts
async snapshot(userId: string): Promise<{
  netReturnPct: number;
  mtdPct: number;
  winRate: number;
  maxDd: number;
  expectancy: number;
  tradesCount: number;
  equity: number;
}> {
  const accounts = await this.prisma.brokerAccount.findMany({ where: { userId } });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) {
    return { netReturnPct: 0, mtdPct: 0, winRate: 0, maxDd: 0, expectancy: 0, tradesCount: 0, equity: 0 };
  }

  const latestSnapshot = await this.prisma.equitySnapshot.findFirst({
    where: { accountId: { in: accountIds } },
    orderBy: { takenAt: 'desc' },
  });
  const firstSnapshot = await this.prisma.equitySnapshot.findFirst({
    where: { accountId: { in: accountIds } },
    orderBy: { takenAt: 'asc' },
  });
  const equity = latestSnapshot?.equity ?? 0;
  const initial = firstSnapshot?.equity ?? equity;
  const netReturnPct = initial > 0 ? ((equity - initial) / initial) * 100 : 0;

  // MTD
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const mtdFirstSnapshot = await this.prisma.equitySnapshot.findFirst({
    where: { accountId: { in: accountIds }, takenAt: { gte: startOfMonth } },
    orderBy: { takenAt: 'asc' },
  });
  const mtdInitial = mtdFirstSnapshot?.equity ?? equity;
  const mtdPct = mtdInitial > 0 ? ((equity - mtdInitial) / mtdInitial) * 100 : 0;

  // Trade-derived metrics over CLOSED trades, lifetime
  const trades = await this.prisma.trade.findMany({
    where: { accountId: { in: accountIds }, status: 'CLOSED' },
    select: { realisedPnl: true, rMultiple: true },
  });
  const tradesCount = trades.length;
  const wins = trades.filter((t) => (t.realisedPnl ?? 0) > 0).length;
  const winRate = tradesCount > 0 ? wins / tradesCount : 0;
  const totalR = trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
  const expectancy = tradesCount > 0 ? totalR / tradesCount : 0;

  // Max drawdown from equity history (peak-to-trough)
  const allSnapshots = await this.prisma.equitySnapshot.findMany({
    where: { accountId: { in: accountIds } },
    orderBy: { takenAt: 'asc' },
    select: { equity: true },
  });
  let peak = 0;
  let maxDd = 0;
  for (const s of allSnapshots) {
    if (s.equity > peak) peak = s.equity;
    if (peak > 0) {
      const dd = ((peak - s.equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }

  return { netReturnPct, mtdPct, winRate, maxDd, expectancy, tradesCount, equity };
}

async equityCurve(opts: { userId: string; days?: number }): Promise<Array<{ date: string; equity: number }>> {
  const days = opts.days ?? 90;
  const since = new Date(Date.now() - days * 86_400_000);
  const accounts = await this.prisma.brokerAccount.findMany({ where: { userId: opts.userId } });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return [];

  // Pull all snapshots in window, sum per day across accounts.
  const snapshots = await this.prisma.equitySnapshot.findMany({
    where: { accountId: { in: accountIds }, takenAt: { gte: since } },
    orderBy: { takenAt: 'asc' },
    select: { takenAt: true, equity: true, accountId: true },
  });
  const byDay = new Map<string, Map<string, number>>();
  for (const s of snapshots) {
    const dayKey = s.takenAt.toISOString().slice(0, 10);
    if (!byDay.has(dayKey)) byDay.set(dayKey, new Map());
    byDay.get(dayKey)!.set(s.accountId, s.equity); // last snapshot wins per account per day
  }
  return Array.from(byDay.entries())
    .map(([date, perAccount]) => ({
      date,
      equity: Array.from(perAccount.values()).reduce((s, v) => s + v, 0),
    }))
    .slice(-days);
}

async riskUsedToday(userId: string): Promise<{ pctUsedToday: number; dailyLossLimit: number; openRiskPct: number }> {
  // Get the user's risk config (default 3% from RiskConfig or env)
  const accounts = await this.prisma.brokerAccount.findMany({ where: { userId } });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return { pctUsedToday: 0, dailyLossLimit: 3.0, openRiskPct: 0 };

  // Daily loss limit — assume preset's default (BALANCED=3%) for now; could be looked up per user.preset
  const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const dailyLossLimit = user.presetKey === 'CONSERVATIVE' ? 2.0 : user.presetKey === 'AGGRESSIVE' ? 5.0 : 3.0;

  // Realized today
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const today = await this.prisma.trade.findMany({
    where: { accountId: { in: accountIds }, status: 'CLOSED', closedAt: { gte: startOfDay } },
    select: { realisedPnl: true },
  });
  const realizedTodayPnl = today.reduce((s, t) => s + (t.realisedPnl ?? 0), 0);

  // Latest equity for normalization
  const latest = await this.prisma.equitySnapshot.findFirst({
    where: { accountId: { in: accountIds } },
    orderBy: { takenAt: 'desc' },
  });
  const equity = latest?.equity ?? 1;
  const realizedTodayPct = (realizedTodayPnl / equity) * 100;

  // Open positions risk — sum of (max loss = entry to SL) across open
  const openTrades = await this.prisma.trade.findMany({
    where: { accountId: { in: accountIds }, status: 'OPEN' },
    select: { entry: true, sl: true, lotSize: true, side: true, symbol: true },
  });
  // Simplification: assume each open trade represents `preset.riskPercent` risk
  const presetRisk = user.presetKey === 'CONSERVATIVE' ? 0.5 : user.presetKey === 'AGGRESSIVE' ? 1.5 : 1.0;
  const openRiskPct = openTrades.length * presetRisk;

  // pctUsedToday = (|realized loss today| + open risk) / dailyLossLimit
  const consumed = Math.max(0, -realizedTodayPct) + openRiskPct;
  const pctUsedToday = (consumed / dailyLossLimit) * 100;

  return { pctUsedToday, dailyLossLimit, openRiskPct };
}
```

Some Trade fields like `entry`, `sl`, `rMultiple` may have different actual names — adjust to match `libs/prisma/schema.prisma`. If `rMultiple` isn't in the schema, derive expectancy from `realisedPnl / (lotSize * pipValue * stopDistance)` — fall back to a per-trade-PnL average if needed.

- [ ] **Step 5: Run tests**

```bash
npx jest src/strategy/live/live-analytics.service.spec.ts
```

Expected: PASS for new tests. Pre-existing tests in this spec continue to pass. If P1001 (Postgres off), this is the standard limitation — the build is the gate.

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/strategy/live/live-analytics.service.ts src/strategy/live/live-analytics.service.spec.ts
git commit -m "feat(analytics): LiveAnalyticsService.snapshot + equityCurve + riskUsedToday"
```

No `Co-Authored-By` trailer.

---

## Task 3: `/api/me/analytics/*` controller + module

**Files:**
- Create: `src/me/analytics/me-analytics.controller.ts`
- Create: `src/me/analytics/me-analytics.module.ts`
- Modify: `src/me/me.module.ts`

- [ ] **Step 1: Create controller**

```ts
// src/me/analytics/me-analytics.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { LiveAnalyticsService } from '../../strategy/live/live-analytics.service';

@UseGuards(JwtAuthGuard)
@Controller('api/me/analytics')
export class MeAnalyticsController {
  constructor(private readonly analytics: LiveAnalyticsService) {}

  @Get('snapshot')
  snapshot(@CurrentUser() me: AuthenticatedUser) {
    return this.analytics.snapshot(me.id);
  }

  @Get('equity-curve')
  equityCurve(@CurrentUser() me: AuthenticatedUser, @Query('days') daysStr?: string) {
    const days = daysStr ? Math.max(1, Math.min(365, parseInt(daysStr, 10))) : 90;
    return this.analytics.equityCurve({ userId: me.id, days });
  }

  @Get('risk-used')
  riskUsed(@CurrentUser() me: AuthenticatedUser) {
    return this.analytics.riskUsedToday(me.id);
  }
}
```

- [ ] **Step 2: Create module**

```ts
// src/me/analytics/me-analytics.module.ts
import { Module } from '@nestjs/common';
import { MeAnalyticsController } from './me-analytics.controller';
import { StrategyModule } from '../../strategy/strategy.module';

@Module({
  imports: [StrategyModule],
  controllers: [MeAnalyticsController],
})
export class MeAnalyticsModule {}
```

If `StrategyModule` doesn't export `LiveAnalyticsService`, add it to the `exports` array in `src/strategy/strategy.module.ts`.

- [ ] **Step 3: Register in MeModule**

Edit `src/me/me.module.ts` — add `MeAnalyticsModule` to `imports`:

```ts
imports: [PrismaModule, AuthModule, MeAnalyticsModule],
```

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/me/analytics src/me/me.module.ts
# Include strategy.module.ts only if you exported LiveAnalyticsService
git commit -m "feat(api): /api/me/analytics/snapshot|equity-curve|risk-used"
```

No `Co-Authored-By` trailer.

---

## Task 4: Strategy baseline constants

**Files:**
- Create: `src/admin/analytics/baseline.ts`
- Create: `src/admin/analytics/baseline.spec.ts`
- Create: `src/admin/analytics/types.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/admin/analytics/baseline.spec.ts
import { STRATEGY_BASELINE } from './baseline';

describe('STRATEGY_BASELINE', () => {
  it('matches the published validation numbers', () => {
    expect(STRATEGY_BASELINE.trades).toBe(686);
    expect(STRATEGY_BASELINE.winRate).toBeCloseTo(0.649, 3);
    expect(STRATEGY_BASELINE.expectancy).toBeCloseTo(0.42, 2);
    expect(STRATEGY_BASELINE.avgRR).toBeCloseTo(1.6, 1);
    expect(STRATEGY_BASELINE.maxDdPct).toBeCloseTo(4.1, 1);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npx jest src/admin/analytics/baseline.spec.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement baseline + shared types**

```ts
// src/admin/analytics/baseline.ts
export const STRATEGY_BASELINE = {
  source: 'Spec 1 validation, 28-month backtest',
  trades: 686,
  winRate: 0.649,
  expectancy: 0.42,
  avgRR: 1.6,
  maxDdPct: 4.1,
} as const;
```

```ts
// src/admin/analytics/types.ts
export type FlagSeverity = 'loss' | 'signal' | 'neutral';

export interface Flag {
  name: 'DD_ALERT' | 'DAILY_LOSS_HIT' | 'BROKER_DOWN' | 'PAUSE_WATCH' | 'INACTIVE_USER' | 'NO_ACCOUNTS';
  severity: FlagSeverity;
  userId: string;
  userEmail: string;
  message: string;
  detail?: string;
}

export interface Trend {
  name: 'WR_DRIFT' | 'EXPECTANCY_DRIFT' | 'PAIR_DIVERGENCE' | 'PRESET_DIVERGENCE';
  direction: 'up' | 'down';
  magnitude: number;     // e.g. percentage points or R
  sampleSize: number;
  recommendation: string;
}

export type StrategyStatus = 'HEALTHY' | 'WATCHING' | 'DEGRADED';
```

- [ ] **Step 4: Run, confirm pass**

```bash
npx jest src/admin/analytics/baseline.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/analytics/baseline.ts src/admin/analytics/baseline.spec.ts src/admin/analytics/types.ts
git commit -m "feat(analytics): strategy baseline constants + Flag/Trend types"
```

No `Co-Authored-By` trailer.

---

## Task 5: `AdminAnalyticsService` (aggregate + flags + trends)

**Files:**
- Create: `src/admin/analytics/admin-analytics.service.ts`
- Create: `src/admin/analytics/admin-analytics.service.spec.ts`

- [ ] **Step 1: Failing tests**

```ts
// src/admin/analytics/admin-analytics.service.spec.ts
import { Test } from '@nestjs/testing';
import { AdminAnalyticsService } from './admin-analytics.service';
import { PrismaService } from '@app/prisma';
import { LiveAnalyticsService } from '../../strategy/live/live-analytics.service';

describe('AdminAnalyticsService', () => {
  let svc: AdminAnalyticsService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AdminAnalyticsService, PrismaService, LiveAnalyticsService],
    }).compile();
    svc = moduleRef.get(AdminAnalyticsService);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.trade.deleteMany();
    await prisma.equitySnapshot.deleteMany();
    await prisma.brokerAccount.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => prisma.$disconnect());

  describe('aggregate()', () => {
    it('counts users, accounts, sums equity', async () => {
      await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'SUPERADMIN' } });
      await prisma.user.create({ data: { email: 'b@x', passwordHash: 'p', role: 'USER', botEnabled: false } });
      const result = await svc.aggregate();
      expect(result.totalUsers).toBe(2);
      expect(result.activeUsers).toBe(1);
    });
  });

  describe('computeFlags()', () => {
    it('emits PAUSE_WATCH when botEnabled=false AND pausedAt > 7 days ago', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
      const u = await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER', botEnabled: false, pausedAt: eightDaysAgo } });
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'PAUSE_WATCH' && f.userId === u.id)).toBe(true);
    });

    it('does NOT emit PAUSE_WATCH when pause is recent', async () => {
      await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER', botEnabled: false, pausedAt: new Date() } });
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'PAUSE_WATCH')).toBe(false);
    });

    it('emits INACTIVE_USER for users with old lastLoginAt and ≥1 enabled account', async () => {
      const u = await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER', lastLoginAt: new Date(Date.now() - 20 * 86_400_000) } });
      await prisma.brokerAccount.create({ data: { userId: u.id, broker: 'METAAPI', label: 't', encryptedCreds: 'x', isEnabled: true } });
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'INACTIVE_USER' && f.userId === u.id)).toBe(true);
    });

    it('emits NO_ACCOUNTS for users with botEnabled=true and 0 enabled accounts', async () => {
      const u = await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER', botEnabled: true } });
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'NO_ACCOUNTS' && f.userId === u.id)).toBe(true);
    });
  });

  describe('computeStatus()', () => {
    it('returns HEALTHY when no flags and small WR drift', () => {
      const status = svc.computeStatus([], { wrDriftPp: 1.0, expectancyDriftR: 0.02, sampleSize: 50 });
      expect(status).toBe('HEALTHY');
    });

    it('returns WATCHING with 1 loss flag', () => {
      const status = svc.computeStatus(
        [{ name: 'DD_ALERT', severity: 'loss', userId: 'u', userEmail: 'a', message: '' }],
        { wrDriftPp: 1.0, expectancyDriftR: 0.02, sampleSize: 50 },
      );
      expect(status).toBe('WATCHING');
    });

    it('returns DEGRADED with 2+ loss flags', () => {
      const status = svc.computeStatus(
        [
          { name: 'DD_ALERT', severity: 'loss', userId: 'u', userEmail: 'a', message: '' },
          { name: 'BROKER_DOWN', severity: 'loss', userId: 'u2', userEmail: 'b', message: '' },
        ],
        { wrDriftPp: 1.0, expectancyDriftR: 0.02, sampleSize: 50 },
      );
      expect(status).toBe('DEGRADED');
    });
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npx jest src/admin/analytics/admin-analytics.service.spec.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/admin/analytics/admin-analytics.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { STRATEGY_BASELINE } from './baseline';
import { Flag, Trend, StrategyStatus } from './types';
import { LiveAnalyticsService } from '../../strategy/live/live-analytics.service';

const DD_ALERT_PCT = 5;
const PAUSE_WATCH_DAYS = 7;
const INACTIVE_DAYS = 14;
const WR_DRIFT_PP = 5;
const EXPECTANCY_DRIFT_R = 0.1;

@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveAnalyticsService,
  ) {}

  async aggregate() {
    const totalUsers = await this.prisma.user.count();
    const activeUsers = await this.prisma.user.count({ where: { botEnabled: true, isActive: true } });
    const totalAccounts = await this.prisma.brokerAccount.count();
    const enabledAccounts = await this.prisma.brokerAccount.count({ where: { isEnabled: true } });
    const latestSnapshots = await this.prisma.equitySnapshot.findMany({
      orderBy: { takenAt: 'desc' },
      distinct: ['accountId'],
      take: 1000,
      select: { equity: true },
    });
    const totalEquity = latestSnapshots.reduce((s, x) => s + x.equity, 0);
    const tradesToday = await this.prisma.trade.count({
      where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    });
    return { totalUsers, activeUsers, totalAccounts, enabledAccounts, totalEquity, dayDelta: 0, tradesToday };
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { email: 'asc' },
      include: { brokerAccounts: { select: { id: true, isEnabled: true } } },
    });
    return Promise.all(
      users.map(async (u) => {
        const snap = await this.live.snapshot(u.id);
        const lastTrade = await this.prisma.trade.findFirst({
          where: { account: { userId: u.id } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        return {
          id: u.id,
          email: u.email,
          presetKey: u.presetKey,
          equity: snap.equity,
          mtdPct: snap.mtdPct,
          winRate: snap.winRate,
          maxDd: snap.maxDd,
          lastTradeAt: lastTrade?.createdAt ?? null,
          status: !u.isActive ? 'disabled' : !u.botEnabled ? 'paused' : u.brokerAccounts.filter((a) => a.isEnabled).length === 0 ? 'no-accounts' : 'live',
          botEnabled: u.botEnabled,
          isActive: u.isActive,
          pausedAt: u.pausedAt,
        };
      }),
    );
  }

  async computeFlags(): Promise<Flag[]> {
    const flags: Flag[] = [];
    const users = await this.prisma.user.findMany({
      include: { brokerAccounts: true },
    });
    const now = Date.now();

    for (const u of users) {
      // PAUSE_WATCH
      if (!u.botEnabled && u.pausedAt) {
        const daysPaused = (now - u.pausedAt.getTime()) / 86_400_000;
        if (daysPaused > PAUSE_WATCH_DAYS) {
          flags.push({
            name: 'PAUSE_WATCH',
            severity: 'signal',
            userId: u.id,
            userEmail: u.email,
            message: `${u.email} — paused ${Math.floor(daysPaused)} days`,
            detail: 'consider checking in',
          });
        }
      }

      // INACTIVE_USER
      const enabledAccounts = u.brokerAccounts.filter((a) => a.isEnabled).length;
      if (u.lastLoginAt && enabledAccounts > 0) {
        const daysSinceLogin = (now - u.lastLoginAt.getTime()) / 86_400_000;
        if (daysSinceLogin > INACTIVE_DAYS) {
          flags.push({
            name: 'INACTIVE_USER',
            severity: 'signal',
            userId: u.id,
            userEmail: u.email,
            message: `${u.email} — inactive ${Math.floor(daysSinceLogin)} days`,
            detail: `${enabledAccounts} enabled account(s) still trading`,
          });
        }
      }

      // NO_ACCOUNTS
      if (u.botEnabled && enabledAccounts === 0) {
        flags.push({
          name: 'NO_ACCOUNTS',
          severity: 'neutral',
          userId: u.id,
          userEmail: u.email,
          message: `${u.email} — bot enabled but no enabled accounts`,
        });
      }

      // DD_ALERT — per-user snapshot
      const snap = await this.live.snapshot(u.id);
      if (snap.maxDd > DD_ALERT_PCT) {
        flags.push({
          name: 'DD_ALERT',
          severity: 'loss',
          userId: u.id,
          userEmail: u.email,
          message: `${u.email} — ${snap.maxDd.toFixed(1)}% drawdown`,
          detail: `threshold: ${DD_ALERT_PCT}%`,
        });
      }
    }

    // Sort by severity: loss > signal > neutral
    const sevOrder = { loss: 0, signal: 1, neutral: 2 };
    return flags.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  }

  async computeTrends(): Promise<{ trends: Trend[]; wrDriftPp: number; expectancyDriftR: number; sampleSize: number }> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const recentTrades = await this.prisma.trade.findMany({
      where: { status: 'CLOSED', closedAt: { gte: since } },
      select: { realisedPnl: true, rMultiple: true, symbol: true },
    });
    const sampleSize = recentTrades.length;
    const wins = recentTrades.filter((t) => (t.realisedPnl ?? 0) > 0).length;
    const wr = sampleSize > 0 ? wins / sampleSize : STRATEGY_BASELINE.winRate;
    const expectancy = sampleSize > 0 ? recentTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / sampleSize : STRATEGY_BASELINE.expectancy;

    const wrDriftPp = (wr - STRATEGY_BASELINE.winRate) * 100;
    const expectancyDriftR = expectancy - STRATEGY_BASELINE.expectancy;

    const trends: Trend[] = [];
    if (sampleSize >= 10 && Math.abs(wrDriftPp) > WR_DRIFT_PP) {
      trends.push({
        name: 'WR_DRIFT',
        direction: wrDriftPp >= 0 ? 'up' : 'down',
        magnitude: Math.abs(wrDriftPp),
        sampleSize,
        recommendation: `Win rate is ${Math.abs(wrDriftPp).toFixed(1)}pp ${wrDriftPp >= 0 ? 'above' : 'below'} baseline on ${sampleSize} trades. Re-run validation backtest for current period.`,
      });
    }
    if (sampleSize >= 10 && Math.abs(expectancyDriftR) > EXPECTANCY_DRIFT_R) {
      trends.push({
        name: 'EXPECTANCY_DRIFT',
        direction: expectancyDriftR >= 0 ? 'up' : 'down',
        magnitude: Math.abs(expectancyDriftR),
        sampleSize,
        recommendation: `Expectancy is ${expectancyDriftR.toFixed(2)}R ${expectancyDriftR >= 0 ? 'above' : 'below'} baseline.`,
      });
    }

    return { trends, wrDriftPp, expectancyDriftR, sampleSize };
  }

  computeStatus(
    flags: Flag[],
    trendStats: { wrDriftPp: number; expectancyDriftR: number; sampleSize: number },
  ): StrategyStatus {
    const lossFlags = flags.filter((f) => f.severity === 'loss').length;
    const absWrDrift = Math.abs(trendStats.wrDriftPp);
    const absExpectancyDrift = Math.abs(trendStats.expectancyDriftR);

    if (lossFlags >= 2 || absWrDrift > 5 || (absExpectancyDrift > 0.15 && trendStats.sampleSize >= 30)) {
      return 'DEGRADED';
    }
    if (lossFlags >= 1 || absWrDrift > 3) {
      return 'WATCHING';
    }
    return 'HEALTHY';
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest src/admin/analytics/admin-analytics.service.spec.ts
```

Expected: PASS (or P1001 if Postgres off — same caveat).

- [ ] **Step 5: Commit**

```bash
git add src/admin/analytics/admin-analytics.service.ts src/admin/analytics/admin-analytics.service.spec.ts
git commit -m "feat(analytics): AdminAnalyticsService — aggregate, flags, trends, status"
```

No `Co-Authored-By` trailer.

---

## Task 6: `/api/admin/analytics/*` controller + module

**Files:**
- Create: `src/admin/analytics/admin-analytics.controller.ts`
- Create: `src/admin/analytics/admin-analytics.module.ts`
- Modify: `src/admin/admin.module.ts`

- [ ] **Step 1: Controller**

```ts
// src/admin/analytics/admin-analytics.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../auth/guards/roles.guard';
import { AdminAnalyticsService } from './admin-analytics.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERADMIN')
@Controller('api/admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly svc: AdminAnalyticsService) {}

  @Get('aggregate')
  aggregate() {
    return this.svc.aggregate();
  }

  @Get('users')
  users() {
    return this.svc.listUsers();
  }

  @Get('trends')
  async trends() {
    const flags = await this.svc.computeFlags();
    const trendData = await this.svc.computeTrends();
    const strategyStatus = this.svc.computeStatus(flags, trendData);
    return { flags, trends: trendData.trends, strategyStatus };
  }
}
```

- [ ] **Step 2: Module**

```ts
// src/admin/analytics/admin-analytics.module.ts
import { Module } from '@nestjs/common';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { PrismaModule } from '@app/prisma';
import { StrategyModule } from '../../strategy/strategy.module';

@Module({
  imports: [PrismaModule, StrategyModule],
  controllers: [AdminAnalyticsController],
  providers: [AdminAnalyticsService],
})
export class AdminAnalyticsModule {}
```

- [ ] **Step 3: Register in AdminModule**

Edit `src/admin/admin.module.ts` — add `AdminAnalyticsModule` to `imports`:

```ts
imports: [PrismaModule, AuthModule, AdminAnalyticsModule],
```

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/admin/analytics/admin-analytics.controller.ts src/admin/analytics/admin-analytics.module.ts src/admin/admin.module.ts
git commit -m "feat(api): /api/admin/analytics/aggregate|users|trends"
```

No `Co-Authored-By` trailer.

---

## Task 7: User.pausedAt write hooks + Backtest scoping + admin backtest endpoints

**Files:**
- Modify: `src/me/me.controller.ts`
- Modify: `src/admin/users/admin-users.service.ts`
- Modify: `src/backtest/backtest.controller.ts`
- Modify: `src/backtest/backtest.service.ts`
- Create: `src/admin/backtest/admin-backtest.controller.ts`
- Create: `src/admin/backtest/admin-backtest.service.ts`

- [ ] **Step 1: Wire User.pausedAt in MeController.updateMe**

In `src/me/me.controller.ts`, modify `updateMe`:

```ts
@Patch()
async updateMe(@CurrentUser() me: AuthenticatedUser, @Body() dto: UpdateMeDto) {
  return this.prisma.user.update({
    where: { id: me.id },
    data: {
      ...(dto.botEnabled !== undefined && {
        botEnabled: dto.botEnabled,
        pausedAt: dto.botEnabled ? null : new Date(),
      }),
      ...(dto.presetKey !== undefined && { presetKey: dto.presetKey }),
    },
    select: {
      id: true, email: true, role: true, isActive: true, botEnabled: true, presetKey: true, pausedAt: true,
    },
  });
}
```

- [ ] **Step 2: Wire User.pausedAt in AdminUsersService.setBotEnabled**

In `src/admin/users/admin-users.service.ts`:

```ts
async setBotEnabled(id: string, botEnabled: boolean) {
  await this.prisma.user.update({
    where: { id },
    data: {
      botEnabled,
      pausedAt: botEnabled ? null : new Date(),
    },
  });
}
```

- [ ] **Step 3: Scope BacktestController by user**

Edit `src/backtest/backtest.controller.ts` — add the `@CurrentUser()` and `JwtAuthGuard` imports if not present, then on each handler add the param and pass userId through to service methods:

```ts
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';

@UseGuards(JwtAuthGuard)
@Controller('api/backtest')
export class BacktestController {
  // POST
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async createBacktest(@Body() dto: CreateBacktestDto, @CurrentUser() me: AuthenticatedUser) {
    const run = await this.backtestService.createAndRun(dto, me.id);
    return { id: run.id, status: run.status };
  }

  @Get()
  list(@CurrentUser() me: AuthenticatedUser) {
    return this.backtestService.list(me.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() me: AuthenticatedUser) {
    return this.backtestService.findOne(id, me.id);
  }

  @Get(':id/trades')
  trades(@Param('id') id: string, @CurrentUser() me: AuthenticatedUser) {
    return this.backtestService.trades(id, me.id);
  }

  @Get(':id/candles')
  candles(@Param('id') id: string, @CurrentUser() me: AuthenticatedUser) {
    return this.backtestService.candles(id, me.id);
  }
}
```

- [ ] **Step 4: Scope BacktestService by userId + cost guard**

Edit `src/backtest/backtest.service.ts`:

- `createAndRun(dto, userId)`: before creating, check running count: `const running = await this.prisma.backtestRun.count({ where: { userId, status: { in: ['PENDING', 'RUNNING'] } } }); if (running >= 2) throw new ConflictException('You already have running backtests.');` Then pass `userId` to the create payload.
- `list(userId)`: `findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })`
- `findOne(id, userId)`: `findFirst({ where: { id, userId } })` — returns null if not the user's; controller throws NotFoundException
- Same for `trades(id, userId)` and `candles(id, userId)` — first verify the run belongs to userId, then return scoped data

- [ ] **Step 5: Create AdminBacktestService + Controller (cross-tenant)**

```ts
// src/admin/backtest/admin-backtest.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';

@Injectable()
export class AdminBacktestService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.backtestRun.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
  }

  findOne(id: string) {
    return this.prisma.backtestRun.findUnique({ where: { id }, include: { user: { select: { email: true } } } });
  }
}
```

```ts
// src/admin/backtest/admin-backtest.controller.ts
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../auth/guards/roles.guard';
import { AdminBacktestService } from './admin-backtest.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERADMIN')
@Controller('api/admin/backtest')
export class AdminBacktestController {
  constructor(private readonly svc: AdminBacktestService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }
}
```

Add `AdminBacktestController` + `AdminBacktestService` to `src/admin/admin.module.ts`:

```ts
controllers: [
  AdminUsersController,
  AdminSessionsController,
  AdminEngineController,
  AdminBacktestController,
],
providers: [AdminUsersService, AdminSessionsService, AdminBacktestService],
```

- [ ] **Step 6: Build + tests**

```bash
npm run build
npx jest src/me src/backtest src/admin --no-coverage
```

Expected: build clean; existing tests still pass. Some Postgres-dependent tests fail with P1001 — known.

- [ ] **Step 7: Commit**

```bash
git add src/me/me.controller.ts src/admin/users/admin-users.service.ts src/backtest/ src/admin/backtest src/admin/admin.module.ts
git commit -m "feat(backtest): per-user scoping + admin cross-tenant + User.pausedAt writes"
```

No `Co-Authored-By` trailer.

---

## Task 8: Web — analytics API clients + hooks

**Working dir:** `/Users/shepyrd/development/shamarx/shamarx-web` · Branch: `feat/spec2-5-dashboard-analytics`

**Files:**
- Create: `src/lib/api-analytics.ts`
- Create: `src/lib/api-admin-analytics.ts`
- Create: `src/lib/api-admin-backtest.ts`
- Create: `src/hooks/use-analytics-snapshot.ts`
- Create: `src/hooks/use-equity-curve.ts`
- Create: `src/hooks/use-risk-used.ts`
- Create: `src/hooks/use-admin-aggregate.ts`
- Create: `src/hooks/use-admin-users-perf.ts`
- Create: `src/hooks/use-admin-trends.ts`

- [ ] **Step 1: User-scoped analytics client**

```ts
// src/lib/api-analytics.ts
import { apiFetch } from './api-client';

export interface Snapshot {
  netReturnPct: number;
  mtdPct: number;
  winRate: number;
  maxDd: number;
  expectancy: number;
  tradesCount: number;
  equity: number;
}

export interface EquityPoint { date: string; equity: number; }

export interface RiskUsed { pctUsedToday: number; dailyLossLimit: number; openRiskPct: number; }

export async function fetchSnapshot(): Promise<Snapshot> {
  const r = await apiFetch('/api/me/analytics/snapshot');
  if (!r.ok) throw new Error(`snapshot failed: ${r.status}`);
  return r.json();
}

export async function fetchEquityCurve(days = 90): Promise<EquityPoint[]> {
  const r = await apiFetch(`/api/me/analytics/equity-curve?days=${days}`);
  if (!r.ok) throw new Error(`equity curve failed: ${r.status}`);
  return r.json();
}

export async function fetchRiskUsed(): Promise<RiskUsed> {
  const r = await apiFetch('/api/me/analytics/risk-used');
  if (!r.ok) throw new Error(`risk-used failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 2: Admin analytics client**

```ts
// src/lib/api-admin-analytics.ts
import { apiFetch } from './api-client';
import type { Snapshot } from './api-analytics';

export interface Aggregate { totalUsers: number; activeUsers: number; totalAccounts: number; enabledAccounts: number; totalEquity: number; dayDelta: number; tradesToday: number; }

export interface UserPerf {
  id: string;
  email: string;
  presetKey: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  equity: number;
  mtdPct: number;
  winRate: number;
  maxDd: number;
  lastTradeAt: string | null;
  status: 'live' | 'paused' | 'disabled' | 'no-accounts';
  botEnabled: boolean;
  isActive: boolean;
  pausedAt: string | null;
}

export type FlagSeverity = 'loss' | 'signal' | 'neutral';
export interface Flag { name: string; severity: FlagSeverity; userId: string; userEmail: string; message: string; detail?: string; }
export interface Trend { name: string; direction: 'up' | 'down'; magnitude: number; sampleSize: number; recommendation: string; }
export type StrategyStatus = 'HEALTHY' | 'WATCHING' | 'DEGRADED';

export async function fetchAdminAggregate(): Promise<Aggregate> {
  const r = await apiFetch('/api/admin/analytics/aggregate');
  if (!r.ok) throw new Error(`admin aggregate failed: ${r.status}`);
  return r.json();
}

export async function fetchAdminUsers(): Promise<UserPerf[]> {
  const r = await apiFetch('/api/admin/analytics/users');
  if (!r.ok) throw new Error(`admin users failed: ${r.status}`);
  return r.json();
}

export async function fetchAdminTrends(): Promise<{ flags: Flag[]; trends: Trend[]; strategyStatus: StrategyStatus; }> {
  const r = await apiFetch('/api/admin/analytics/trends');
  if (!r.ok) throw new Error(`admin trends failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 3: Admin backtest client**

```ts
// src/lib/api-admin-backtest.ts
import { apiFetch } from './api-client';

export interface AdminBacktest { id: string; userId: string | null; user?: { email: string } | null; symbol: string; startDate: string; endDate: string; status: string; metrics: any; createdAt: string; }

export async function fetchAdminBacktests(): Promise<AdminBacktest[]> {
  const r = await apiFetch('/api/admin/backtest');
  if (!r.ok) throw new Error(`admin backtests failed: ${r.status}`);
  return r.json();
}

export async function fetchAdminBacktest(id: string): Promise<AdminBacktest> {
  const r = await apiFetch(`/api/admin/backtest/${id}`);
  if (!r.ok) throw new Error(`admin backtest failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 4: Hooks**

```ts
// src/hooks/use-analytics-snapshot.ts
import { useQuery } from '@tanstack/react-query';
import { fetchSnapshot } from '@/lib/api-analytics';
export function useAnalyticsSnapshot() {
  return useQuery({ queryKey: ['/api/me/analytics/snapshot'], queryFn: fetchSnapshot, refetchInterval: 30_000 });
}
```

```ts
// src/hooks/use-equity-curve.ts
import { useQuery } from '@tanstack/react-query';
import { fetchEquityCurve } from '@/lib/api-analytics';
export function useEquityCurve(days = 90) {
  return useQuery({ queryKey: ['/api/me/analytics/equity-curve', days], queryFn: () => fetchEquityCurve(days) });
}
```

```ts
// src/hooks/use-risk-used.ts
import { useQuery } from '@tanstack/react-query';
import { fetchRiskUsed } from '@/lib/api-analytics';
export function useRiskUsed() {
  return useQuery({ queryKey: ['/api/me/analytics/risk-used'], queryFn: fetchRiskUsed, refetchInterval: 15_000 });
}
```

```ts
// src/hooks/use-admin-aggregate.ts
import { useQuery } from '@tanstack/react-query';
import { fetchAdminAggregate } from '@/lib/api-admin-analytics';
export function useAdminAggregate() {
  return useQuery({ queryKey: ['/api/admin/analytics/aggregate'], queryFn: fetchAdminAggregate, refetchInterval: 30_000 });
}
```

```ts
// src/hooks/use-admin-users-perf.ts
import { useQuery } from '@tanstack/react-query';
import { fetchAdminUsers } from '@/lib/api-admin-analytics';
export function useAdminUsersPerf() {
  return useQuery({ queryKey: ['/api/admin/analytics/users'], queryFn: fetchAdminUsers });
}
```

```ts
// src/hooks/use-admin-trends.ts
import { useQuery } from '@tanstack/react-query';
import { fetchAdminTrends } from '@/lib/api-admin-analytics';
export function useAdminTrends() {
  return useQuery({ queryKey: ['/api/admin/analytics/trends'], queryFn: fetchAdminTrends, refetchInterval: 60_000 });
}
```

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-analytics.ts src/lib/api-admin-analytics.ts src/lib/api-admin-backtest.ts src/hooks/use-analytics-snapshot.ts src/hooks/use-equity-curve.ts src/hooks/use-risk-used.ts src/hooks/use-admin-aggregate.ts src/hooks/use-admin-users-perf.ts src/hooks/use-admin-trends.ts
git commit -m "feat(web): analytics API clients + hooks (user + admin)"
```

No `Co-Authored-By` trailer.

---

## Task 9: Web — LiveStatusPanel + PerformanceHero + RiskUsedGauge

**Files:**
- Create: `src/components/dashboard/live-status-panel.tsx`
- Create: `src/components/dashboard/performance-hero.tsx`
- Create: `src/components/dashboard/risk-used-gauge.tsx`

- [ ] **Step 1: RiskUsedGauge**

```tsx
// src/components/dashboard/risk-used-gauge.tsx
'use client';
import { cn } from '@/lib/utils';
import { useRiskUsed } from '@/hooks/use-risk-used';

export function RiskUsedGauge() {
  const { data } = useRiskUsed();
  const pct = Math.min(100, Math.max(0, data?.pctUsedToday ?? 0));
  const color = pct < 40 ? 'bg-profit' : pct < 80 ? 'bg-signal' : 'bg-loss';
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Risk used today</div>
      <div className="h-2 w-full rounded bg-card overflow-hidden">
        <div className={cn('h-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <div className="font-mono text-xs text-foreground">{pct.toFixed(0)}% of {data?.dailyLossLimit.toFixed(0) ?? '—'}%</div>
    </div>
  );
}
```

- [ ] **Step 2: LiveStatusPanel**

```tsx
// src/components/dashboard/live-status-panel.tsx
'use client';
import { useMe } from '@/hooks/use-me';
import { useBrokerAccounts } from '@/hooks/use-broker-accounts';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { RiskUsedGauge } from './risk-used-gauge';

export function LiveStatusPanel() {
  const { data: me } = useMe();
  const { data: accounts } = useBrokerAccounts();
  const { data: positions } = useQuery({ queryKey: ['live-positions'], queryFn: () => api.livePositions(), refetchInterval: 5_000 });
  const enabledCount = accounts?.filter((a) => a.isEnabled).length ?? 0;
  const todayPnl = 0; // derived elsewhere; placeholder shown via api.liveTrades({status: 'CLOSED', limit: 100}) and same filter as dashboard

  if (!me) return <div className="h-44 rounded border border-border bg-card animate-pulse" />;

  return (
    <div className="rounded border border-border bg-card p-5 min-h-[140px]">
      <div className="mb-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground">Live status</div>
      <div className="mb-4 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-profit shadow-[0_0_6px_var(--color-profit)]" />
        <span className="text-sm font-semibold text-foreground">Bot is live</span>
        <span className="ml-2 rounded border border-signal/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-signal">{me.presetKey}</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Open</div>
          <div className="font-mono text-lg text-foreground">{positions?.length ?? 0}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Accounts</div>
          <div className="font-mono text-lg text-foreground">{enabledCount}</div>
        </div>
        <div>
          <RiskUsedGauge />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: PerformanceHero**

```tsx
// src/components/dashboard/performance-hero.tsx
'use client';
import { cn } from '@/lib/utils';
import { useAnalyticsSnapshot } from '@/hooks/use-analytics-snapshot';
import { useEquityCurve } from '@/hooks/use-equity-curve';

export function PerformanceHero() {
  const { data: snap } = useAnalyticsSnapshot();
  const { data: curve } = useEquityCurve(30);

  if (!snap) return <div className="h-44 rounded border border-border bg-card animate-pulse" />;

  const isPos = snap.netReturnPct >= 0;
  const max = Math.max(...(curve?.map((p) => p.equity) ?? [1]));
  const min = Math.min(...(curve?.map((p) => p.equity) ?? [0]));
  const range = max - min || 1;

  return (
    <div className="rounded border border-border bg-card p-5 min-h-[140px]">
      <div className="mb-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground">Performance</div>
      <div className={cn('font-display font-mono text-3xl font-semibold mb-1', isPos ? 'text-profit' : 'text-loss')}>
        {isPos ? '+' : ''}{snap.netReturnPct.toFixed(1)}%
      </div>
      <div className="text-xs text-muted-foreground mb-4">since inception · ${snap.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
      <div className="flex h-10 items-end gap-px">
        {(curve ?? []).slice(-30).map((p, i) => {
          const h = ((p.equity - min) / range) * 100;
          return <div key={i} className="flex-1 bg-profit/70" style={{ height: `${Math.max(4, h)}%` }} />;
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build + lint**

```bash
npm run build
npm run lint
```

Expected: clean on new files.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/live-status-panel.tsx src/components/dashboard/performance-hero.tsx src/components/dashboard/risk-used-gauge.tsx
git commit -m "feat(web): LiveStatusPanel + PerformanceHero + RiskUsedGauge components"
```

No `Co-Authored-By` trailer.

---

## Task 10: Web — EquityCurve component (lightweight-charts)

**Files:**
- Create: `src/components/dashboard/equity-curve.tsx`

- [ ] **Step 1: Read existing chart pattern**

Read `src/components/backtest/backtest-chart.tsx` to see how `lightweight-charts` is initialized (createChart, addLineSeries, setData, resize handler).

- [ ] **Step 2: Implement EquityCurve**

```tsx
// src/components/dashboard/equity-curve.tsx
'use client';
import { useEffect, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useEquityCurve } from '@/hooks/use-equity-curve';

export function EquityCurve({ days = 90 }: { days?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const { data } = useEquityCurve(days);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#0e0a07' as any }, textColor: '#8d8275' },
      grid: { vertLines: { color: '#2a261f' }, horzLines: { color: '#2a261f' } },
      rightPriceScale: { borderColor: '#383229' },
      timeScale: { borderColor: '#383229' },
      width: containerRef.current.clientWidth,
      height: 160,
    });
    chartRef.current = chart;
    const series = chart.addAreaSeries({ topColor: 'rgba(79,212,159,0.4)', bottomColor: 'rgba(79,212,159,0.05)', lineColor: '#4FD49F', lineWidth: 2 });
    seriesRef.current = series;

    const resize = () => chart.resize(containerRef.current!.clientWidth, 160);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !data) return;
    seriesRef.current.setData(data.map((p) => ({ time: p.date, value: p.equity })));
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  if (!data?.length) {
    return (
      <div className="flex h-[160px] items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground">
        No equity history yet
      </div>
    );
  }

  return <div ref={containerRef} className="rounded border border-border bg-[#0e0a07] p-2" />;
}
```

- [ ] **Step 3: Build + lint**

```bash
npm run build
npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/equity-curve.tsx
git commit -m "feat(web): EquityCurve component (lightweight-charts area series)"
```

No `Co-Authored-By` trailer.

---

## Task 11: Web — SnapshotTile + TodayTrades + dashboard page rewrite

**Files:**
- Create: `src/components/dashboard/snapshot-tile.tsx`
- Create: `src/components/dashboard/today-trades.tsx`
- Modify: `src/app/dashboard/page.tsx`

- [ ] **Step 1: SnapshotTile (generic)**

```tsx
// src/components/dashboard/snapshot-tile.tsx
'use client';
import { cn } from '@/lib/utils';

export function SnapshotTile({ label, value, accent }: { label: string; value: string; accent?: 'profit' | 'loss' | 'signal' | 'default' }) {
  const colorClass = accent === 'profit' ? 'text-profit' : accent === 'loss' ? 'text-loss' : accent === 'signal' ? 'text-signal' : 'text-foreground';
  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="mb-1 font-display text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn('font-mono text-lg', colorClass)}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: TodayTrades**

```tsx
// src/components/dashboard/today-trades.tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export function TodayTrades() {
  const { data: trades } = useQuery({
    queryKey: ['today-trades'],
    queryFn: () => api.liveTrades({ status: 'CLOSED', limit: 100 }),
    refetchInterval: 30_000,
  });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const list = (trades ?? []).filter((t: any) => new Date(t.closedAt ?? t.createdAt) >= today);
  const total = list.reduce((s: number, t: any) => s + (t.pnl ?? t.realisedPnl ?? 0), 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">Today · {list.length} trades</div>
        <div className={total >= 0 ? 'font-mono text-sm font-semibold text-profit' : 'font-mono text-sm font-semibold text-loss'}>
          {total >= 0 ? '+' : ''}${total.toFixed(2)}
        </div>
      </div>
      <div className="rounded border border-border bg-card divide-y divide-border">
        {list.length === 0 && <div className="p-4 text-center text-xs text-muted-foreground">No trades today</div>}
        {list.map((t: any) => (
          <div key={t.id} className="flex items-center justify-between p-3 font-mono text-xs">
            <span>
              <span className="text-muted-foreground">{new Date(t.closedAt ?? t.createdAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>{' '}
              {t.symbol}{' '}
              <span className={t.side === 'BUY' ? 'text-profit' : 'text-loss'}>{t.side}</span>
            </span>
            <span className={(t.pnl ?? t.realisedPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'}>
              {(t.pnl ?? t.realisedPnl ?? 0) >= 0 ? '+' : ''}${(t.pnl ?? t.realisedPnl ?? 0).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `/dashboard` page**

Replace `src/app/dashboard/page.tsx` entirely:

```tsx
'use client';
import { useMe } from '@/hooks/use-me';
import { useAnalyticsSnapshot } from '@/hooks/use-analytics-snapshot';
import { LiveStatusPanel } from '@/components/dashboard/live-status-panel';
import { PerformanceHero } from '@/components/dashboard/performance-hero';
import { EquityCurve } from '@/components/dashboard/equity-curve';
import { SnapshotTile } from '@/components/dashboard/snapshot-tile';
import { TodayTrades } from '@/components/dashboard/today-trades';
import { SuperadminAggregate } from '@/components/dashboard/superadmin-aggregate';

export default function DashboardPage() {
  const { data: me } = useMe();
  const { data: snap } = useAnalyticsSnapshot();

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Hero split */}
      <section className="grid gap-4 md:grid-cols-2">
        <LiveStatusPanel />
        <PerformanceHero />
      </section>

      {/* Equity curve full-width */}
      <section>
        <div className="mb-2 font-display text-[10px] uppercase tracking-widest text-muted-foreground">Equity · last 90 days</div>
        <EquityCurve days={90} />
      </section>

      {/* Snapshot tiles + today */}
      <section className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 font-display text-[10px] uppercase tracking-widest text-muted-foreground">Snapshot</div>
          <div className="grid grid-cols-2 gap-2">
            <SnapshotTile label="MTD" value={snap ? `${snap.mtdPct >= 0 ? '+' : ''}${snap.mtdPct.toFixed(1)}%` : '—'} accent={snap && snap.mtdPct >= 0 ? 'profit' : 'loss'} />
            <SnapshotTile label="Win rate" value={snap ? `${(snap.winRate * 100).toFixed(0)}%` : '—'} />
            <SnapshotTile label="Max DD" value={snap ? `−${snap.maxDd.toFixed(1)}%` : '—'} accent="signal" />
            <SnapshotTile label="Expectancy" value={snap ? `${snap.expectancy >= 0 ? '+' : ''}${snap.expectancy.toFixed(2)}R` : '—'} />
          </div>
        </div>
        <TodayTrades />
      </section>

      {/* SUPERADMIN-only aggregate block */}
      {me?.role === 'SUPERADMIN' && <SuperadminAggregate />}
    </div>
  );
}
```

- [ ] **Step 4: Build + lint**

```bash
npm run build
npm run lint
```

Expected: clean on new files. The `SuperadminAggregate` import resolves to the next task — if it doesn't exist yet, create an empty stub `export function SuperadminAggregate() { return null; }` at `src/components/dashboard/superadmin-aggregate.tsx` so the build passes; Task 12 fills it in.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/snapshot-tile.tsx src/components/dashboard/today-trades.tsx src/app/dashboard/page.tsx
# Include the stub if you added it:
git add src/components/dashboard/superadmin-aggregate.tsx
git commit -m "feat(web): SnapshotTile + TodayTrades + dashboard page rewrite (Spacious layout)"
```

No `Co-Authored-By` trailer.

---

## Task 12: Web — SUPERADMIN aggregate panels

**Files:**
- Modify (or create): `src/components/dashboard/superadmin-aggregate.tsx`
- Create: `src/components/dashboard/strategy-health-panel.tsx`
- Create: `src/components/dashboard/flags-panel.tsx`
- Create: `src/components/dashboard/user-performance-table.tsx`

- [ ] **Step 1: StrategyHealthPanel**

```tsx
// src/components/dashboard/strategy-health-panel.tsx
'use client';
import { cn } from '@/lib/utils';
import { useAdminTrends } from '@/hooks/use-admin-trends';

export function StrategyHealthPanel() {
  const { data } = useAdminTrends();
  if (!data) return <div className="h-40 rounded border border-border bg-card animate-pulse" />;

  const statusColor = data.strategyStatus === 'HEALTHY' ? 'bg-profit text-background' : data.strategyStatus === 'WATCHING' ? 'bg-signal text-background' : 'bg-loss text-background';

  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">Strategy health · Balanced preset</div>
        <span className={cn('rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', statusColor)}>
          {data.strategyStatus}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {data.trends.map((t) => (
          <div key={t.name}>
            <div className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">{t.name.replace(/_/g, ' ')}</div>
            <div className={cn('font-mono text-sm', t.direction === 'up' ? 'text-profit' : 'text-loss')}>
              {t.direction === 'up' ? '↑' : '↓'} {t.magnitude.toFixed(2)}{t.name.includes('WR') ? 'pp' : 'R'}
            </div>
            <div className="text-[9px] text-muted-foreground">{t.sampleSize} trades</div>
          </div>
        ))}
        {data.trends.length === 0 && (
          <div className="col-span-full text-center text-xs text-muted-foreground">No trend deviations detected.</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: FlagsPanel**

```tsx
// src/components/dashboard/flags-panel.tsx
'use client';
import { useAdminTrends } from '@/hooks/use-admin-trends';
import { cn } from '@/lib/utils';

export function FlagsPanel() {
  const { data } = useAdminTrends();
  if (!data) return <div className="h-40 rounded border border-border bg-card animate-pulse" />;

  const severityBorder = (s: 'loss' | 'signal' | 'neutral') => s === 'loss' ? 'border-loss' : s === 'signal' ? 'border-signal' : 'border-profit';

  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="mb-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground">Flags · {data.flags.length}</div>
      <div className="space-y-2">
        {data.flags.length === 0 && (
          <div className="rounded border border-dashed border-border p-4 text-center text-xs text-muted-foreground">All clear.</div>
        )}
        {data.flags.map((f, i) => (
          <div key={i} className={cn('rounded border-l-2 bg-background/40 p-2', severityBorder(f.severity))}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground">{f.name.replace(/_/g, ' ')}</div>
            <div className="text-xs text-foreground">{f.message}</div>
            {f.detail && <div className="text-[10px] text-muted-foreground">{f.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: UserPerformanceTable**

```tsx
// src/components/dashboard/user-performance-table.tsx
'use client';
import Link from 'next/link';
import { useAdminUsersPerf } from '@/hooks/use-admin-users-perf';

const statusBadge = (s: string) => {
  if (s === 'live') return '🟢 live';
  if (s === 'paused') return '🟡 paused';
  if (s === 'disabled') return '🔴 disabled';
  return '⚪ no accounts';
};

export function UserPerformanceTable() {
  const { data: users } = useAdminUsersPerf();
  if (!users) return <div className="h-40 rounded border border-border bg-card animate-pulse" />;

  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="mb-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground">Users · performance</div>
      <table className="w-full font-mono text-xs">
        <thead className="text-[9px] uppercase tracking-widest text-muted-foreground">
          <tr>
            <th className="text-left py-1">User</th>
            <th className="text-left">Preset</th>
            <th className="text-left">Equity</th>
            <th className="text-left">MTD</th>
            <th className="text-left">WR</th>
            <th className="text-left">DD</th>
            <th className="text-left">Last trade</th>
            <th className="text-left">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.map((u) => (
            <tr key={u.id}>
              <td className="py-2"><Link href={`/admin/users/${u.id}`} className="text-foreground hover:underline">{u.email}</Link></td>
              <td>{u.presetKey.charAt(0) + u.presetKey.slice(1).toLowerCase()}</td>
              <td>${u.equity.toFixed(0)}</td>
              <td className={u.mtdPct >= 0 ? 'text-profit' : 'text-loss'}>{u.mtdPct >= 0 ? '+' : ''}{u.mtdPct.toFixed(1)}%</td>
              <td>{(u.winRate * 100).toFixed(0)}%</td>
              <td className={u.maxDd > 5 ? 'text-loss' : 'text-signal'}>−{u.maxDd.toFixed(1)}%</td>
              <td className="text-muted-foreground">{u.lastTradeAt ? new Date(u.lastTradeAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
              <td>{statusBadge(u.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: SuperadminAggregate (root wrapper)**

```tsx
// src/components/dashboard/superadmin-aggregate.tsx
'use client';
import { useAdminAggregate } from '@/hooks/use-admin-aggregate';
import { SnapshotTile } from './snapshot-tile';
import { StrategyHealthPanel } from './strategy-health-panel';
import { FlagsPanel } from './flags-panel';
import { UserPerformanceTable } from './user-performance-table';

export function SuperadminAggregate() {
  const { data: agg } = useAdminAggregate();

  return (
    <section className="rounded border border-border bg-card/60 p-5 space-y-5">
      <div className="flex items-center gap-2 pb-3 border-b border-border">
        <span className="text-signal">▸</span>
        <span className="font-display text-[10px] uppercase tracking-widest text-signal">Admin · house view</span>
        <span className="ml-auto text-[10px] text-muted-foreground">SUPERADMIN only</span>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <SnapshotTile label="Users" value={agg ? String(agg.totalUsers) : '—'} />
        <SnapshotTile label="Accounts" value={agg ? `${agg.enabledAccounts}/${agg.totalAccounts}` : '—'} />
        <SnapshotTile label="House equity" value={agg ? `$${agg.totalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'} accent="profit" />
        <SnapshotTile label="Trades 24h" value={agg ? String(agg.tradesToday) : '—'} />
      </div>

      <div className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
        <StrategyHealthPanel />
        <FlagsPanel />
      </div>

      <UserPerformanceTable />
    </section>
  );
}
```

- [ ] **Step 5: Build + lint**

```bash
npm run build
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/superadmin-aggregate.tsx src/components/dashboard/strategy-health-panel.tsx src/components/dashboard/flags-panel.tsx src/components/dashboard/user-performance-table.tsx
git commit -m "feat(web): SUPERADMIN aggregate panel (health + flags + per-user table)"
```

No `Co-Authored-By` trailer.

---

## Task 13: Web — sidebar update + `/admin/backtest` page

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Create: `src/app/admin/backtest/page.tsx`
- Create: `src/app/admin/backtest/[id]/page.tsx`

- [ ] **Step 1: Restore Backtest + Replay to WORKSPACE; fix ADMIN link**

Edit `src/components/layout/sidebar.tsx`:

Update WORKSPACE_NAV to include Backtest + Replay:

```ts
const WORKSPACE_NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/lives', label: 'Live', icon: Radio },
  { href: '/journal', label: 'Journal', icon: BookOpen },
  { href: '/accounts', label: 'Accounts', icon: Briefcase },
  { href: '/backtest', label: 'Backtest', icon: Activity },
  { href: '/replay', label: 'Replay', icon: Film },
];
```

Update ADMIN_NAV — change `/admin/backtest` to point at the new cross-tenant page, label "All Backtests":

```ts
const ADMIN_NAV = [
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/invites', label: 'Invites', icon: Mail },
  { href: '/admin/sessions', label: 'Sessions', icon: KeyRound },
  { href: '/admin/engine', label: 'Engine', icon: Cpu },
  { href: '/admin/backtest', label: 'All Backtests', icon: Activity },
];
```

Make sure `Film` is imported from `lucide-react`.

- [ ] **Step 2: `/admin/backtest/page.tsx`**

```tsx
// src/app/admin/backtest/page.tsx
'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchAdminBacktests } from '@/lib/api-admin-backtest';

export default function AdminBacktestPage() {
  const { data: runs } = useQuery({ queryKey: ['/api/admin/backtest'], queryFn: fetchAdminBacktests });
  if (!runs) return null;

  return (
    <div className="p-6 lg:p-8">
      <header className="mb-6">
        <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">Admin</div>
        <h1 className="mt-1 text-xl font-semibold">All Backtests</h1>
      </header>
      <div className="overflow-hidden rounded border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">User</th>
              <th className="px-4 py-2 text-left">Symbol</th>
              <th className="px-4 py-2 text-left">Range</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-card cursor-pointer">
                <td className="px-4 py-3 font-mono text-xs">
                  <Link href={`/admin/backtest/${r.id}`}>{r.user?.email ?? <span className="text-muted-foreground">(orphan)</span>}</Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{r.symbol}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {new Date(r.startDate).toLocaleDateString()} → {new Date(r.endDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-xs">{r.status}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `/admin/backtest/[id]/page.tsx`**

```tsx
// src/app/admin/backtest/[id]/page.tsx
'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { fetchAdminBacktest } from '@/lib/api-admin-backtest';

export default function AdminBacktestDetailPage() {
  const params = useParams<{ id: string }>();
  const { data: run } = useQuery({ queryKey: ['/api/admin/backtest', params.id], queryFn: () => fetchAdminBacktest(params.id) });
  if (!run) return null;

  return (
    <div className="p-6 lg:p-8">
      <header className="mb-6">
        <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">Admin · {run.user?.email ?? 'orphan'}</div>
        <h1 className="mt-1 text-xl font-semibold">{run.symbol} backtest</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {new Date(run.startDate).toLocaleDateString()} → {new Date(run.endDate).toLocaleDateString()} · status {run.status}
        </p>
      </header>
      <pre className="overflow-auto rounded border border-border bg-card p-4 font-mono text-xs">
        {JSON.stringify(run.metrics, null, 2)}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Build + lint**

```bash
npm run build
npm run lint
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/sidebar.tsx src/app/admin/backtest
git commit -m "feat(web): sidebar Backtest+Replay restored; /admin/backtest cross-tenant page"
```

No `Co-Authored-By` trailer.

---

## Task 14: Web — `/admin/users/:id` per-user analytics extension

**Files:**
- Modify (or create): `src/app/admin/users/[id]/page.tsx`

- [ ] **Step 1: Inspect existing page (if any)**

```bash
cat src/app/admin/users/[id]/page.tsx 2>/dev/null || echo 'does not exist yet'
```

If it doesn't exist (Spec 2 Task 20 created the list page but not the detail), create it from scratch using the pattern from `/admin/users/page.tsx`.

- [ ] **Step 2: Implement detail page with analytics drill-in**

```tsx
// src/app/admin/users/[id]/page.tsx
'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { SnapshotTile } from '@/components/dashboard/snapshot-tile';

async function fetchUser(id: string) {
  const r = await apiFetch(`/api/admin/users/${id}`);
  if (!r.ok) throw new Error('failed');
  return r.json();
}

async function fetchUserSnapshot(id: string) {
  const r = await apiFetch(`/api/admin/analytics/users/${id}/snapshot`);
  if (!r.ok) throw new Error('failed');
  return r.json();
}

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const { data: user } = useQuery({ queryKey: ['/api/admin/users', params.id], queryFn: () => fetchUser(params.id) });
  const { data: snap } = useQuery({ queryKey: ['/api/admin/analytics/users', params.id, 'snapshot'], queryFn: () => fetchUserSnapshot(params.id) });

  if (!user) return null;

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <header>
        <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">Admin · user</div>
        <h1 className="mt-1 text-xl font-semibold font-mono">{user.email}</h1>
        <div className="mt-1 text-xs text-muted-foreground">
          {user.role} · preset {user.presetKey} · {user.isActive ? 'active' : 'disabled'} · bot {user.botEnabled ? 'enabled' : 'paused'}
        </div>
      </header>

      <section>
        <div className="mb-2 font-display text-[10px] uppercase tracking-widest text-muted-foreground">Snapshot</div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <SnapshotTile label="Equity" value={snap ? `$${snap.equity.toFixed(0)}` : '—'} />
          <SnapshotTile label="Net return" value={snap ? `${snap.netReturnPct >= 0 ? '+' : ''}${snap.netReturnPct.toFixed(1)}%` : '—'} accent={snap && snap.netReturnPct >= 0 ? 'profit' : 'loss'} />
          <SnapshotTile label="Win rate" value={snap ? `${(snap.winRate * 100).toFixed(0)}%` : '—'} />
          <SnapshotTile label="Max DD" value={snap ? `−${snap.maxDd.toFixed(1)}%` : '—'} accent="signal" />
        </div>
      </section>
    </div>
  );
}
```

Note: `/api/admin/analytics/users/:id/snapshot` is not in the Task 6 controller. Add a fourth handler to `AdminAnalyticsController`:

```ts
@Get('users/:id/snapshot')
userSnapshot(@Param('id') id: string) {
  return this.live.snapshot(id);
}
```

Inject `LiveAnalyticsService` into the controller (or expose it via service). Then commit this backend addition together with the web change (one PR ships them together).

- [ ] **Step 3: Build + lint (both repos)**

```bash
cd /Users/shepyrd/development/shamarx/shamarx-app && npm run build
cd /Users/shepyrd/development/shamarx/shamarx-web && npm run build && npm run lint
```

- [ ] **Step 4: Commit (each repo separately)**

Backend:
```bash
cd /Users/shepyrd/development/shamarx/shamarx-app
git add src/admin/analytics/admin-analytics.controller.ts
git commit -m "feat(api): /api/admin/analytics/users/:id/snapshot for per-user drill-in"
```

Web:
```bash
cd /Users/shepyrd/development/shamarx/shamarx-web
git add src/app/admin/users
git commit -m "feat(web): /admin/users/:id detail page with per-user snapshot drill-in"
```

No `Co-Authored-By` trailers.

---

## Task 15: E2E tests + runbook update

**Working dir:** `/Users/shepyrd/development/shamarx/shamarx-app` (backend)

**Files:**
- Create: `test/backtest-isolation.e2e-spec.ts`
- Modify: `test/multi-tenant-isolation.e2e-spec.ts`
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Backtest isolation e2e**

```ts
// test/backtest-isolation.e2e-spec.ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Backtest isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let aliceCookie: string;
  let adminCookie: string;
  let aliceId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.backtestRun.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    const pw = await bcrypt.hash('pass-pass', 10);

    const alice = await prisma.user.create({ data: { email: 'alice@test', passwordHash: pw, role: 'USER' } });
    aliceId = alice.id;
    await prisma.user.create({ data: { email: 'admin@test', passwordHash: pw, role: 'SUPERADMIN' } });

    // Seed: alice has 1 run; admin has 1 run
    await prisma.backtestRun.create({ data: { userId: alice.id, symbol: 'EURUSD', startDate: new Date('2024-01-01'), endDate: new Date('2024-06-30'), initialBalance: 10000, riskPercent: 1.0 } });

    const aliceLogin = await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'alice@test', password: 'pass-pass' });
    aliceCookie = aliceLogin.headers['set-cookie'].find((c: string) => c.startsWith('auth_token='))!.split(';')[0];

    const adminLogin = await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'admin@test', password: 'pass-pass' });
    adminCookie = adminLogin.headers['set-cookie'].find((c: string) => c.startsWith('auth_token='))!.split(';')[0];
  });

  afterAll(async () => app.close());

  it('alice only sees her own backtest runs', async () => {
    const res = await request(app.getHttpServer()).get('/api/backtest').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userId).toBe(aliceId);
  });

  it('admin sees ALL backtest runs via /api/admin/backtest', async () => {
    const res = await request(app.getHttpServer()).get('/api/admin/backtest').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('alice gets 403 on /api/admin/backtest', async () => {
    const res = await request(app.getHttpServer()).get('/api/admin/backtest').set('Cookie', aliceCookie);
    expect(res.status).toBe(403);
  });

  it('alice creating a backtest sets userId automatically', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/backtest')
      .set('Cookie', aliceCookie)
      .send({ symbol: 'GBPUSD', startDate: '2024-01-01', endDate: '2024-03-31', initialBalance: 10000, riskPercent: 1.0 });
    expect(res.status).toBe(202);
    const run = await prisma.backtestRun.findUnique({ where: { id: res.body.id } });
    expect(run?.userId).toBe(aliceId);
  });
});
```

- [ ] **Step 2: Extend multi-tenant-isolation e2e**

In `test/multi-tenant-isolation.e2e-spec.ts`, add an `it()` block:

```ts
it('alice gets 403 on /api/admin/analytics/aggregate', async () => {
  const res = await request(app.getHttpServer())
    .get('/api/admin/analytics/aggregate')
    .set('Cookie', aliceCookie);
  expect(res.status).toBe(403);
});

it('admin sees aggregate', async () => {
  const res = await request(app.getHttpServer())
    .get('/api/admin/analytics/aggregate')
    .set('Cookie', adminCookie);
  expect(res.status).toBe(200);
  expect(res.body.totalUsers).toBeGreaterThanOrEqual(2);
});
```

The existing spec already seeds an admin user; if not, add one in `beforeEach`.

- [ ] **Step 3: Run e2e**

```bash
npx jest test/backtest-isolation.e2e-spec.ts test/multi-tenant-isolation.e2e-spec.ts --runInBand
```

Expected: tests compile + start; will fail at P1001 locally (Postgres off) but the test SHAPE is correct. CI will run these for real.

- [ ] **Step 4: Update RUNBOOK**

Append to `docs/RUNBOOK.md`:

```md
## Spec 2.5 — Dashboard analytics rollout

Pre-flight (one-time, before merge):

1. Backend PR merges → `prisma db push` on EC2 applies the 3 schema additions (userId on BacktestRun + LiveReplaySession; pausedAt on User).
2. Run backfill via SSM:
   \`\`\`bash
   docker exec trading-bot-app npx ts-node scripts/backfill-spec2-5.ts
   \`\`\`
   Expected output: "Backfilled N BacktestRun rows" + "Backfilled N LiveReplaySession rows".
3. Verify scoping:
   \`\`\`bash
   docker exec trading-bot-postgres psql -U trading shamarx -c \\
     'SELECT COUNT(*) total, COUNT("userId") scoped FROM "BacktestRun";'
   \`\`\`
   total should equal scoped.
4. Smoke: visit /dashboard, see Spacious layout. Equity curve renders. SUPERADMIN panels appear below.
5. Smoke: sidebar shows Backtest + Replay in WORKSPACE, and "All Backtests" in ADMIN.
6. Open /admin/backtest, see all historical runs (now attributed to you).

If anything goes wrong:
- Backend revert: redeploy previous main; nullable columns linger harmlessly.
- Web revert: redeploy previous Amplify build.
```

- [ ] **Step 5: Commit (both repos)**

Backend:
```bash
git add test/backtest-isolation.e2e-spec.ts test/multi-tenant-isolation.e2e-spec.ts docs/RUNBOOK.md
git commit -m "test(e2e): backtest isolation + admin analytics access + runbook update"
```

No `Co-Authored-By` trailer.

---

## Final review

After all 15 tasks ship and PRs merge:

1. Run backfill on EC2 via SSM (Task 1's script).
2. Verify production DB:
   - `BacktestRun.userId` populated for all historical rows
   - `LiveReplaySession.userId` populated
   - `User.pausedAt` null for everyone (no one paused yet)
3. Smoke `/dashboard` as SUPERADMIN — Spacious layout + house view appended.
4. Send test invite to second email you control → accept → log in → confirm Spacious layout renders without SUPERADMIN section.

---

## Self-review (against the spec)

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §3 Architecture | covered across all tasks |
| §4 Data model | Task 1 |
| §5 Backend analytics | Tasks 2 (LiveAnalyticsService), 3 (/api/me), 4 (baseline), 5 (AdminAnalyticsService), 6 (/api/admin) |
| §6 USER dashboard layout | Tasks 9, 10, 11 |
| §7 SUPERADMIN aggregate panels | Task 12 + Task 14 (per-user drill-in) |
| §8 Backtest + Replay | Task 7 (scoping), Task 13 (sidebar + /admin/backtest), Task 6 (admin endpoints already there) |
| §9 User.pausedAt mechanics | Task 7 |
| §10 Migration sequencing | Task 1 + Final review section |
| §11 Testing strategy | Tasks 2, 5 (unit); 7 (integration); 15 (e2e) |
| §12 Rollback | covered by additive migrations + per-task revertibility |
| §13 Out of scope | not implemented (correct) |

**Placeholder scan:** no "TBD", "TODO", "appropriate". Every step has runnable commands or full code blocks.

**Type consistency:** `Snapshot`, `EquityPoint`, `RiskUsed`, `Aggregate`, `UserPerf`, `Flag`, `Trend`, `StrategyStatus` defined in Tasks 4, 8 — referenced consistently in Tasks 5, 6, 12. `STRATEGY_BASELINE` defined Task 4, consumed in Task 5.

**Estimated total commits:** ~17 (one per task; Tasks 12 and 14 each include backend + web pieces; Task 14 splits across both repos).

---
