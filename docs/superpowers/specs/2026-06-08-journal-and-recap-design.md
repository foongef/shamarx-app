# Trading Journal + Calendar Recap — Design Spec

**Date:** 2026-06-08
**Status:** Approved for implementation planning
**Owner:** foongef

## 1. Context & motivation

Live trading is producing real positions (first 4 broker fills validated June 3:
2 GBPUSD SELL + 2 EURUSD SELL). The strategy team needs two capabilities the
current UI doesn't offer:

1. **A structured journal** — record per-trade context at fire and close, plus
   reflections (tags + free-text), so post-hoc strategy iteration can ask
   questions like "how many of last week's losses were tagged news-spike?".
2. **A recap view** — a calendar-shaped view that summarises P&L and trade
   activity per day, so the operator can scan a month/year at a glance and
   drill into any day to read the journal entries.

A diagnostic during brainstorming surfaced a related insight: XAUUSD had no
sweeps detected in live across a full session window. Root cause: gold's D1
ADX has been below 18 (the configured floor) for 6+ days, blocking sweep
detection by design. Not a bug — but the existing UI cannot distinguish
"silent because no setup" from "silent because gated". The journal/recap
design surfaces enough per-day context that this kind of question will be
answerable directly from the UI in v2 (the "why-not-traded" data is out of
scope for v1; see § 9).

## 2. Goals & non-goals

### Goals

- Every closed live trade has a structured `JournalEntry` row with
  `entryContext`, `exitContext`, `outcome`, `setupSummary` — auto-populated at
  fire and close.
- Operator can tag any trade (predefined or custom tags) and write an optional
  free-text reflection per trade.
- Operator can write one free-text day-level note per UTC calendar day.
- `/journal/[yyyy-mm]` renders a month calendar grid with per-day P&L heat and
  trade counts. Selecting a day opens an inline panel with that day's
  journal entries.
- Stats (month totals, weekly totals, win rate, by-pair breakdowns) are
  computed on demand from `Trade` — no precomputed snapshot tables.
- All existing trades are backfilled with synthesised JournalEntry rows so
  history is reachable from day 1.

### Non-goals (v1)

- Email digests / push notifications.
- "Why-not-traded" / per-pair regime exposure analytics. (Deferred to v2 —
  the gold-ADX diagnostic above motivates this for later.)
- Per-trade LLM-generated reasoning explanations.
- Multi-user / per-user journal isolation.
- Editable `outcome` field (derived from `pnl` and `exitReason`).
- Pre-computed `WeeklyRecap` / `DayRecap` snapshot tables.

## 3. Architecture overview

**Name & navigation.** A single new top-level sidebar entry labeled
**"Journal"** between "Live" and "Replay". Routes:

- `/journal` — current month calendar
- `/journal/[yyyy-mm]` — archive month
- `/journal/[yyyy-mm-dd]` — direct deep-link to a specific day (optional;
  ships in v1 for shareable URLs)

The word "recap" is used internally for summary aggregations; the user-facing
word is "Journal" everywhere.

**What's new.**

- 1 new Prisma model: `DayNote`
- 1 new column on `JournalEntry`: `reflectionNote String?` (the existing
  `tags String[]` is reused)
- 5 new REST endpoints under `/api/journal`
- 1 new web page at `/journal/[yyyy-mm]` (calendar grid + day panel)
- 2 fire-and-forget hooks in `LiveStrategyService` and
  `PositionMonitorService` to populate `JournalEntry` rows
- 1 one-shot backfill script for existing closed trades
- 1 small upstream change: add `anchorType?: AnchorType` to the
  `SmcLiveSignal.smcContext` payload (the anchor-sweep detector already
  knows the type — currently discarded after matching). See § 6.1.

**What's reused.**

- `Trade` table — SMC context already lives here (sweptLevel, sweepCandleTime,
  d1Bias, originalSlPrice, mode, setupTags)
- `JournalEntry` table — scaffolded in schema but currently unused; adopted
- Existing JWT auth guard
- Existing telemetry feed — no changes (journal reads from `Trade`, not
  telemetry)
- Existing reconciliation job (already runs hourly) — extended to backfill
  any missing `JournalEntry` rows

**Compute model.** On-demand server-side Postgres aggregation. At today's
data scale (low hundreds of trades) a month query plan hits the existing
`Trade(createdAt)` and `Trade(symbol, createdAt)` indices and runs in
~30 ms. No cron. If page latency degrades past ~200 ms in the future, the
snapshot model (precomputed `DayRecap` rows) can be layered on without a
UX change.

## 4. Data model

### 4.1 New table: `DayNote`

```prisma
model DayNote {
  id        String   @id @default(uuid())
  date      DateTime @unique @db.Date    // UTC calendar day
  note      String                       // free-form daily reflection
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([date])
}
```

- Single-row per UTC calendar date. Date-keyed (not user-keyed) because the
  system is single-user today.
- Multi-tenant migration path: add `userId String` + change `@unique`
  constraint to `@@unique([userId, date])`. No UI change required.

### 4.2 Extended: `JournalEntry`

The existing model already carries `setupSummary`, `llmReasoning`,
`entryContext`, `exitContext`, `outcome`, and `tags`. Only one column needs
to be added:

```prisma
model JournalEntry {
  id             String   @id @default(uuid())
  tradeId        String   @unique
  trade          Trade    @relation(fields: [tradeId], references: [id], onDelete: Cascade)
  setupSummary   String   // existing — auto-populated
  llmReasoning   String   // existing — empty string for non-LLM trades
  entryContext   Json?    // existing — snapshot at signal-fire
  exitContext    Json?    // existing — snapshot at position-close
  outcome        String?  // existing — "WIN" | "LOSS" | "BE" | "FORCED_CLOSE"
  tags           String[] // existing — reused
  reflectionNote String?  // NEW — optional per-trade free-text
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([tradeId])
}
```

Cascade delete on the `Trade` relation ensures journal entries cannot
outlive their trade. This is already the right model — the current spec
just makes it explicit.

### 4.3 Predefined tag set

UI suggests these 6 tags as colored chips; custom tags also persist as
plain strings.

| Tag | Semantic color |
|---|---|
| News spike | red |
| Bad regime | muted |
| SL too tight | red |
| Wrong mode | amber |
| Setup looked good | green |
| Late entry | amber |

Custom tags render with a neutral border + ghost background.

### 4.4 `entryContext` JSON shape

Auto-populated at signal-fire time inside `LiveStrategyService.evaluatePair`.

```ts
type EntryContext = {
  evalTime: string;            // ISO 8601
  d1Adx: number;
  d1Bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  h1Atr: number;
  killzone: 'LONDON' | 'NY' | 'ASIAN' | null;
  pendingQueueSize: number;
  spread: number;
  accountEquity: number;
  openPositionsCount: number;
  openDirectionsForSymbol: Array<'BUY' | 'SELL'>;
  anchorLevel: number | null;
  anchorType: 'PDH' | 'PDL' | 'ASIAN_H' | 'ASIAN_L' | 'WEEKLY_H' | 'WEEKLY_L' | null;
  source?: 'backfill';         // present only on backfilled rows
};
```

### 4.5 `exitContext` JSON shape

Auto-populated when `PositionMonitorService` flips `Trade.status` to
`CLOSED`.

```ts
type ExitContext = {
  closedAt: string;            // ISO 8601
  exitReason: 'TP' | 'SL' | 'BREAKEVEN' | 'FORCED_CLOSE';
  holdMinutes: number;
  exitPrice: number;
  mfeMaePips: { mfe: number; mae: number } | null;  // null if candle data missing
  trailedSlAtClose: number;
  originalSlPrice: number | null;
  beActivated: boolean;
  source?: 'backfill';
};
```

### 4.6 Outcome derivation

`outcome` is derived, never user-editable. Computed at enrichment time.

```
pnl > 0                              → "WIN"
pnl < -0.50                          → "LOSS"
|pnl| <= 0.50                        → "BE"
exitReason === "FORCED_CLOSE"        → "FORCED_CLOSE" (overrides above)
```

### 4.7 Input limits

Enforced server-side via `class-validator`.

| Field | Max chars |
|---|---|
| `DayNote.note` | 5,000 |
| `JournalEntry.reflectionNote` | 2,000 |
| Each tag string | 30 |
| Tags per trade | 20 |

UI prevents typing past the limit and shows a subtle counter when within
10% of the cap.

## 5. API surface

All endpoints under `/api/journal`, all behind the existing `JwtAuthGuard`.

### 5.1 `GET /api/journal/month/:yyyymm`

Fuels the calendar grid in one request.

```ts
type MonthResponse = {
  month: string;                  // "2026-06"
  days: Array<{
    date: string;                 // "2026-06-03"
    tradesCount: number;
    realizedPnl: number;
    winsCount: number;
    lossesCount: number;
    hasDayNote: boolean;
    hasReflections: boolean;
    hasOpenTrades: boolean;       // for italicized "in flight" indicator
  }>;
  monthTotals: {
    tradesCount: number;
    realizedPnl: number;
    winsCount: number;
    lossesCount: number;
    winRatePct: number;
  };
  weeklyTotals: Array<{
    weekStart: string;            // ISO 8601 Monday UTC
    tradesCount: number;          // only counts trades inside the requested month window
    realizedPnl: number;           // same — only sums trades inside the month
    partial: boolean;              // true if the calendar week extends outside this month
  }>;
};
```

Only weeks that intersect the requested month appear in `weeklyTotals`. A
week wholly outside the month is not returned. Days outside the month but
inside an intersecting week do NOT contribute to `tradesCount` /
`realizedPnl` — those columns reflect only what was traded inside the
month window.

Implementation: one `GROUP BY date_trunc('day', "createdAt")` over `Trade`
joined to `JournalEntry`, plus a `SELECT date FROM DayNote WHERE date BETWEEN
...` for the dayNote presence flags. Total: 2–3 indexed queries.

### 5.2 `GET /api/journal/day/:yyyymmdd`

Fuels the day panel.

```ts
type DayResponse = {
  date: string;
  dayNote: string | null;
  trades: Array<{
    id: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    mode: 'REVERSAL' | 'CONTINUATION';
    lotSize: number;
    entryPrice: number;
    closePrice: number | null;
    slPrice: number;
    originalSlPrice: number | null;
    tpPrice: number;
    pnl: number | null;
    exitReason: string | null;
    status: 'OPEN' | 'CLOSED' | 'PENDING' | 'CANCELLED';
    openedAt: string;
    closedAt: string | null;
    sweptLevel: number | null;
    sweepCandleTime: string | null;
    d1Bias: string | null;
    journal: {
      tags: string[];
      reflectionNote: string | null;
      entryContext: EntryContext | null;
      exitContext: ExitContext | null;
      setupSummary: string;
      outcome: 'WIN' | 'LOSS' | 'BE' | 'FORCED_CLOSE' | null;
    };
  }>;
  dayTotals: {
    tradesCount: number;
    realizedPnl: number;
    winsCount: number;
    lossesCount: number;
  };
};
```

### 5.3 `PATCH /api/journal/trade/:tradeId`

Partial update of journal fields. Request validated with `class-validator`.

```ts
type UpdateTradeJournalRequest = {
  tags?: string[];                // replaces whole array (not merge)
  reflectionNote?: string | null; // null clears
};
```

Returns the updated `journal` sub-object. `404` if trade not found.
`422` if the trade is not a live trade (e.g. backtest source).

### 5.4 `PATCH /api/journal/day/:yyyymmdd`

Upsert the day note. Empty string clears (deletes the `DayNote` row).

```ts
type UpdateDayNoteRequest = {
  note: string;
};
```

`422` if `yyyymmdd` is a future date (UTC midnight comparison).

### 5.5 `GET /api/journal/available-months`

Populates the month-picker dropdown.

```ts
type AvailableMonthsResponse = {
  months: string[];               // ["2026-06", "2026-05", "2026-04"] descending
  earliestTradeDate: string;
  latestTradeDate: string;
};
```

## 6. Auto-population hooks

### 6.1 Hook 1 — signal-fire

In `LiveStrategyService.evaluatePair`, immediately after `placeOrder` returns
with `successfulLegs > 0` (current line ~478):

```ts
this.createJournalEntriesForSignal(signal, evalTs, {
  d1Adx,
  d1Bias,
  killzone,
  pendingQueueSize,
  spread,
  accountEquity,
  openPositionsCount,
  openDirections,
  anchorLevel: signal.smcContext?.sweptLevel ?? null,
  anchorType: signal.smcContext?.anchorType ?? null,
}).catch((err) =>
  this.logger.warn(`JournalEntry create failed: ${(err as Error).message}`),
);
```

Values for `d1Adx`, `killzone`, `pendingQueueSize`, etc. are computed once at
the top of `evaluatePair` (the strategy already needs them for the eval
decision) and threaded through — no new DB reads.

**Upstream change required:** `SmcLiveSignal.smcContext` does not currently
carry an `anchorType` field — the anchor-sweep detector
(`sweep-detector.ts:299–333`) iterates over `[anchors.pdh, 'PDH']` pairs but
discards the type label after a match. To populate `entryContext.anchorType`,
the detector's `make()` factory needs to add `anchorType` to the
`PendingSetup` payload, and the orchestrator's setup-to-signal mapping
needs to forward it onto `signal.smcContext.anchorType`. This is a 6-line
change in 3 files, no behavioural impact on the strategy.

For each fired leg (TP1 + Runner), one `JournalEntry` is created with
identical `entryContext` but distinct `setupSummary`:

```
"{mode} {side} on {symbol} — D1 {bias}, swept {anchorType} at {level}, {killzone} session — {leg}"
// → "REVERSAL SELL on EURUSD — D1 BEARISH, swept PDH at 1.16125, LONDON session — TP1 leg"
```

### 6.2 Hook 2 — position close

In `PositionMonitorService` after `Trade.status` flips to `CLOSED`:

```ts
await this.enrichJournalOnExit(trade);
```

`enrichJournalOnExit` computes:

- `holdMinutes` = `(closedAt - createdAt) / 60_000`
- `mfeMaePips` from M15 candles in the trade's lifetime range — one indexed
  Postgres query. On error: store `null`, never block the close pipeline.
- `outcome` from the rule in § 4.6
- Writes `exitContext` and `outcome` to the existing `JournalEntry` row

### 6.3 Hook 3 — backfill

One-shot script `scripts/backfill-journal.ts` runs once after the schema
migration. For each existing closed `Trade` without a `JournalEntry`:

- Synthesise `entryContext` from `Trade.sweptLevel`, `Trade.d1Bias`,
  `Trade.sweepCandleTime`, etc. Mark with `entryContext.source = "backfill"`.
- Derive `exitContext` from `closedAt`, `exitReason`, `pnl`, `slPrice`,
  `originalSlPrice`. Mark with `exitContext.source = "backfill"`.
- `setupSummary` follows the same template as live; absent fields render as
  `"—"`.

Idempotent — running twice does not duplicate rows.

### 6.4 Hook 4 — reconciliation safety net

Extend the existing hourly reconciliation job that already detects orphan
broker positions to also detect `Trade` rows without a `JournalEntry` and
backfill them. Catches the rare case where Hook 1 failed silently.

## 7. UI / UX

### 7.1 Sidebar

Add one entry to `NAV` in `shamarx-web/src/components/layout/sidebar.tsx`,
between `/lives` and `/replay`:

```ts
{ href: '/journal', label: 'Journal', icon: BookOpen },
```

Active-state highlight mirrors existing entries (signal-bar accent +
`bg-sidebar-accent`).

### 7.2 Page composition (`/journal/[yyyy-mm]`)

Top-to-bottom sections:

1. **Eyebrow row** — `"JOURNAL · JUNE 2026"` left + month picker
   (Prev / Dropdown / Next) right.
2. **Headline** — `<June> <Journal>` serif + month pill showing total P&L,
   trade count, WR.
3. **Editorial stat strip** — 6 cells (Month, Trades, Wins, Losses, WR,
   Realized) — same visual pattern as `/lives/[id]`.
4. **Calendar grid** — 7-column Mon-first grid, cells aspect-ratio 1.4.
5. **Weekly totals strip** — below the grid; shows `Wk23: -$33 · 10t · 50% WR`
   for each week intersecting the month, partial weeks marked.
6. **Day panel** — appears below the grid when a day is selected. Contains:
   day header (date + totals), day note textarea, then a list of trade rows
   (collapsed by default, click to expand).

### 7.3 Calendar cell states

| State | Visual |
|---|---|
| No trades | `bg-card`, muted date number |
| Profitable day | `bg-profit/{10–25}` by P&L magnitude |
| Losing day | `bg-loss/{15–30}` |
| Has open trades | P&L value italicized + `"in flight"` badge below |
| Has dayNote | small yellow dot in top-right corner |
| Has any reflectionNote / tags | small underline beneath date number |
| Today | `outline-signal` border |
| Selected | `outline outline-foreground` |
| Outside month | `text-subtle/40`, not clickable |
| Future | reduced opacity, not clickable |

Each cell is a `<button>` for keyboard navigation.

### 7.4 Day panel structure

```
┌─ FRI · JUN 5, 2026 · UTC ─────────── -$71.40 / 3 trades / 33% WR ─┐
│                                                                    │
│ Day note                                                           │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ News spike at 13:00 caught us three times. ATR guard...     │  │
│ └──────────────────────────────────────────────────────────────┘  │
│ Saved · 4s ago                                                     │
│                                                                    │
│ ▾ USDJPY SELL 09:15 · CONTINUATION                  -$28.10 SL    │
│   Stop-hunt CONTINUATION SELL on USDJPY — D1 BEARISH, swept...   │
│   [News spike] [Bad regime] [SL too tight] [+ tag]                │
│   ┌─ Entry context ─┐ ┌─ Exit context ─┐                          │
│   │ D1 ADX 24.3    │ │ Exit reason  SL│                          │
│   │ Bias  BEARISH  │ │ Hold     11min │                          │
│   │ ...            │ │ MFE/MAE +3.2/-14.1                         │
│   └────────────────┘ └────────────────┘                          │
│   Reflection: [textarea]                                           │
│   → View on chart                                                  │
│                                                                    │
│ ▸ USDJPY BUY  12:51 · REVERSAL [News spike]         -$31.20 SL    │
│ ▸ USDJPY SELL 15:30 · REVERSAL                      -$12.10 SL    │
└────────────────────────────────────────────────────────────────────┘
```

### 7.5 Writing UX (C3 — confirmed)

- **Day note**: single auto-growing textarea, placeholder
  `"What stood out today?"`, autosave on blur. Subtle "saved · Xs ago"
  timestamp.
- **Tag chips**: 6 predefined colored + `+ tag` chip that opens an inline
  input. Click any chip to toggle. Removing a custom tag: click → unselected
  state → next save removes it from the trade.
- **Reflection textarea** (inside expanded trade row): autosave on blur.
- All saves use React Query mutations with `onSettled` invalidating the day
  query. No spinners; eventual consistency.

### 7.6 Mobile

- Calendar grid stays 7-column. Cells become a colored dot + the day number
  only (no P&L value text inline). Color intensity still encodes P&L
  magnitude.
- Tapping a cell selects it (same gesture as desktop click). The day panel
  appears full-width directly below the grid; viewport scrolls down to it
  automatically.
- The day-note textarea and trade-row expanders remain legible at 360 px
  viewport.
- Weekly totals strip collapses to a horizontal scroll on narrow viewports
  (no truncation).

### 7.7 Empty states

- No trades anywhere: `"Once your first live trade closes, it'll show up here."`
  Calendar grid still renders, all cells empty.
- Empty day selected: `"No trades on this day"` above the day note textarea.
  Day note still writable (for no-trade-day observations).
- Future day clicked: no panel opens; cell renders muted.

### 7.8 Keyboard navigation

| Shortcut | Action |
|---|---|
| Arrow keys on calendar | Move selection |
| Enter / Space | Open selected day panel |
| `n` while a day is selected | Focus day-note textarea |
| `e` while a trade row is focused | Expand it |

### 7.9 Loading

- First month fetch: React Query skeleton in calendar cells.
- Subsequent month switches: stale-while-revalidate (cached previous month
  stays visible; new data swaps in when ready).

## 8. Edge cases

| Case | Handling |
|---|---|
| Multi-leg trades (TP1 + Runner) | Each leg = own Trade = own JournalEntry. Same `entryContext`, distinct `setupSummary` `"TP1 leg"` / `"Runner leg"`. |
| Trade still OPEN at view time | Counted on the day it opened. P&L shows unrealized in italic + `"in flight"` badge. |
| FORCED_CLOSE / session-end flush | `outcome = "FORCED_CLOSE"` regardless of P&L sign. Exit reason chip reads `FORCED_CLOSE`. |
| Backfilled trades | `entryContext.source = "backfill"`. UI renders a small grey `"backfilled"` hint and hides missing keys. |
| Timezone confusion | Everything UTC. Day header shows `"UTC"` label. Save timestamps relative (`"4s ago"`). A trade at 23:00 UTC Friday shows on the Friday cell (matches the rest of the app). |
| Week crossing month boundary | Weekly strip shows partial weeks with `"(partial)"` label. Trades stay on their own day cell. |
| Future days | Cells render muted; not clickable. API rejects future PATCH with 422. |
| Day with no trades but a day note | Calendar cell shows yellow note-dot, no P&L color. |
| Tag length / count overflow | Server rejects with 422; UI prevents input past limit + shows counter. |
| Concurrent edit conflict | Single-user system; last-write-wins. Multi-user future: add `If-Match` header. |

## 9. Out of scope (v1) — deferred features

- **Weekly digest email.** Reuse existing trade-opened email infra; cron-fire
  Sunday UTC. Spec for v2.
- **"Why-not-traded" analytics.** Per-pair regime exposure (% of bars D1 ADX
  below floor), killzone coverage %, near-miss sweeps blocked downstream.
  Empirically motivated by the gold-no-sweep diagnostic above. v2.
- **Snapshot `WeeklyRecap` / `DayRecap` tables.** Add when on-demand
  compute breaches ~200 ms p95.
- **Multi-user journal isolation.** Add `userId` column to both new/extended
  tables.
- **LLM-generated trade explanations.** Reuse the existing `LlmDecision`
  table; v2.

## 10. Test strategy

### 10.1 Backend unit tests (Jest)

- `JournalService.upsertDayNote` — create, update, clear-via-empty-string,
  future-date rejection.
- `JournalService.updateTradeJournal` — tag replacement (not merge),
  reflectionNote null vs empty, sanitization, 30-char cap.
- `JournalService.getMonthAggregate` — month-boundary correctness across
  Feb leap year, empty months, days with only open trades, weekly
  partial-strip math.
- `JournalService.getDay` — trade↔journal join order, dayNote presence/
  absence, joined SMC context shape.
- `enrichJournalOnExit` — MFE/MAE calc with various candle counts (1, 0,
  missing data → null fallback). Outcome derivation rule.
- `backfill-journal.ts` — idempotent (running twice does not duplicate),
  partial-context flag set correctly.

### 10.2 Backend integration tests

Pattern follows `live-strategy.service.spec.ts`:

- Simulated signal-fire → DB has new `JournalEntry` rows with non-null
  `entryContext`.
- Simulated position close → `exitContext` populated, `outcome` derived.
- `PATCH /journal/trade/:id` requires JWT; 401 without; 404 for missing.
- `PATCH /journal/day/:yyyymmdd` rejects future dates with 422.

### 10.3 Frontend tests (Vitest)

- Calendar component renders correct day count for Jan (31), Feb 2024 (29),
  Feb 2025 (28), Apr (30).
- Selected day highlights; arrow keys move selection.
- `n` keyboard shortcut focuses day-note textarea.
- Tag chip toggle dispatches `PATCH` mutation with replacement array.
- Auto-save debounce: blur fires once; rapid type → blur fires once not
  many times.

### 10.4 Manual QA checklist

1. Fresh deploy → `/journal` loads, current month, no errors with 0 trades.
2. Wait for a live trade to fire → it appears in the day cell within ~30 s.
3. Click the day → day panel opens, journal entry visible with
   `entryContext` populated.
4. Wait for trade to close → `exitContext` fills, outcome shows
   WIN/LOSS chip.
5. Add tags → refresh → tags persist.
6. Add day note → refresh → note persists.
7. Add reflection note → refresh → reflection persists.
8. Navigate to previous month → backfilled trades appear with grey
   `"backfilled"` hint.
9. Mobile viewport (375 px) → grid + panel both legible.
10. Press `n` → focus jumps to day note.

### 10.5 Performance sanity

- Month query plan via `EXPLAIN ANALYZE` should hit `Trade(createdAt)`
  index, < 30 ms at current scale.
- Day query: index hit on `Trade(symbol, createdAt)` + nested loop join
  to `JournalEntry(tradeId)` unique index.
- Frontend page weight target: < 50 KB of new JS (calendar = pure CSS
  grid + small handlers).

## 11. Rollout

```
1. Merge & deploy schema migration   (Prisma — additive only; backwards-compat)
2. Merge & deploy backend            (new endpoints + hooks, dark; no UI yet calls them)
3. Run scripts/backfill-journal.ts   (idempotent; verify N rows = N closed trades)
4. Merge & deploy web                (sidebar entry + /journal page goes live)
5. Manual smoke test                 (open page, click a day, write a note, refresh)
```

Zero downtime. Rollback at any step does not break live trading because the
hooks are fire-and-forget.

## 12. Files

### New

- `libs/prisma/migrations/<timestamp>_journal_v1/migration.sql` — DayNote table + JournalEntry.reflectionNote column
- `src/journal/journal.module.ts`
- `src/journal/journal.service.ts`
- `src/journal/journal.controller.ts`
- `src/journal/dto/update-trade-journal.dto.ts`
- `src/journal/dto/update-day-note.dto.ts`
- `src/journal/dto/journal-context.types.ts` (EntryContext / ExitContext / Outcome)
- `src/journal/journal.service.spec.ts`
- `src/journal/journal.controller.spec.ts`
- `scripts/backfill-journal.ts`
- `../shamarx-web/src/app/journal/page.tsx`
- `../shamarx-web/src/app/journal/[yyyy-mm]/page.tsx`
- `../shamarx-web/src/components/journal/calendar-grid.tsx`
- `../shamarx-web/src/components/journal/day-panel.tsx`
- `../shamarx-web/src/components/journal/trade-row.tsx`
- `../shamarx-web/src/components/journal/tag-chips.tsx`
- `../shamarx-web/src/components/journal/day-note-editor.tsx`
- `../shamarx-web/src/hooks/use-journal-month.ts`
- `../shamarx-web/src/hooks/use-journal-day.ts`
- `../shamarx-web/src/hooks/use-journal-mutations.ts`

### Modified

- `libs/prisma/schema.prisma` — add `DayNote` model + `reflectionNote` column + `onDelete: Cascade` on `JournalEntry.trade`
- `src/strategy/live/live-strategy.service.ts` — add `createJournalEntriesForSignal` call after successful `placeOrder`
- `src/strategy/live/position-monitor.service.ts` — add `enrichJournalOnExit` call on `Trade.status` transition to `CLOSED`
- `src/strategy/strategy.module.ts` — import `JournalModule`
- `src/app.module.ts` — register `JournalModule`
- `../shamarx-web/src/components/layout/sidebar.tsx` — add `Journal` nav entry with `BookOpen` icon
- `../shamarx-web/src/lib/api-client.ts` — add `journalMonth`, `journalDay`, `journalAvailableMonths`, `journalUpdateTrade`, `journalUpdateDay` helpers

### Reused (no changes)

- `Trade` table — already has SMC context
- `JournalEntry.tags` column — already exists
- `JwtAuthGuard` — already protects strategy controllers
- Reconciliation hourly job — extended for safety net, not rebuilt

## 13. Open questions deferred

- Should the reconciliation safety net (§ 6.4) write to a metrics counter
  so we can monitor how often it fires? — defer to ops review post-launch.
- **Outcome bucketing in aggregates.** Current v1 decision:
  `outcome === "FORCED_CLOSE"` trades count toward `tradesCount` and
  contribute to `realizedPnl`, but are **excluded** from `winsCount` /
  `lossesCount` and therefore from the displayed Win Rate. They appear as
  the third bucket implicitly: `forcedCount = tradesCount - winsCount -
  lossesCount`. The web computes and renders `forcedCount` client-side
  from the existing API fields — no API change. Re-confirm in v2 once we
  have a sample of FORCED_CLOSE outcomes in production.
