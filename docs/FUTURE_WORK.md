# Future Work — Backlog

Captures ideas that are good but deferred for later.

## 1. News-blackout filter (deferred from 2026-05-09)

**Idea:** the engine should skip evaluations during a window around major
macro news events (NFP, FOMC, ECB, BoE, CPI). Pure technical strategies
underperform during macro regime shifts; an event blackout prevents the
engine from taking an SMC sweep right into a news spike.

**Implementation sketch:**
- New `NewsBlackoutService` that ingests the ForexFactory calendar
  (free RSS/JSON feed) on a 6h cron
- Maintains an in-memory list of upcoming high-impact events per pair
- `RiskManager.canTrade()` consults it: skip if within 30 min before /
  60 min after any high-impact event for the affected pair (e.g. USD events
  affect XAUUSD/EURUSD/GBPUSD/USDJPY; GBP events affect GBPUSD only)
- New telemetry event type `'news-blackout'` so the dashboard shows
  "skipped: NFP at 12:30" instead of generic "no signal"

**Effort:** ~4-6 hours. **Validate first via replay** — re-run the
2-year session with the blackout enabled and confirm it improves
the metrics or doesn't hurt them. Don't ship without that check.

---

## 2. SMC-annotated chart on each trade (started 2026-05-09)

**Idea:** every trade row in `/replay/[id]` and `/lives/[id]` should
expand into a chart showing exactly **why** the engine fired the trade —
the swept liquidity level, the sweep candle, the entry/SL/TP, and
(longer-term) the FVG / order block / BOS that confirmed the setup.
Users can scrub through the chart and see SMC concepts visually,
turning the dashboard into an educational tool.

This is a multi-phase feature. Phase 1 is the MVP and worth shipping
on its own; Phase 2 adds the FVG / OB / BOS layer; Phase 3 polishes.

### Phase 1 — annotated chart (MVP, ~10-14h)

**Backend** (~2-3h):
- Add nullable fields to `LiveReplayTrade` + `Trade` for the SMC context
  that's currently computed but not persisted:
  - `sweptLevel: Float?` — the swing extreme that was swept
  - `sweptHigh: Float?`, `sweptLow: Float?` — the sweep candle range
  - `sweepCandleTime: DateTime?` — H1 candle that did the sweep
  - `d1Bias: String?` — BULLISH | BEARISH | NEUTRAL at decision time
- Populate these at trade-creation time inside the orchestrator's
  signal generation. No engine logic changes — these are already
  computed values, just not yet stored.

**Frontend** (~6-8h):
- New `SmcAnnotatedChart` component (`src/components/replay/smc-chart.tsx`)
  built on `lightweight-charts` v5 (already in deps). Renders:
  - Candles for the relevant pair, ~50 bars window centered on the sweep
  - Horizontal price lines via `addPriceLine`: entry (gold), SL (red), TP (green)
  - Vertical line / shaded zone for the sweep candle range
  - Marker (`setMarkers`) on the entry candle showing "↑ BUY @ 1.17547" or "↓ SELL"
  - D1 bias chip in chart header
- Educational side panel (`SmcLegend`):
  - Each annotation has a short explanation: "Sweep — price grabbed liquidity
    above the prior swing high then closed back below..."
  - Hover any chart line to highlight its panel entry
- Wire into `/replay/[id]`: each PositionTicket + ClosedRow gets a
  "View on chart" expander
- Wire into `/lives/[id]` trades table: same expander pattern

**Mobile** (~1-2h):
- Chart resizes correctly at <768px
- Side panel collapses below chart instead of beside
- Touch tooltips replace hover

### Phase 2 — FVG / OB / BOS (~12-16h)

**Backend:**
- Add `detectFvgs(candles, lookback)` to `engine/smc/structure.ts`:
  finds 3-candle imbalances where candle[i+1] doesn't overlap
  candle[i-1]. Returns array of `{ top, bottom, fromTime, isBullish }`.
- Add `detectOrderBlocks(candles, sweepIdx)`: identifies the last
  opposing candle before the impulsive move that created the sweep.
- Add `detectBos(candles, swingIdx)`: confirms break of the previous
  swing high/low.
- Persist as JSON arrays on the trade row (small payload, ~200 bytes
  per trade).

**Frontend:**
- Use `lightweight-charts` v5 plugin API to draw rectangles for FVG
  and OB zones. The plugin draws a colored translucent box on the
  canvas at the right time/price coordinates.
- Click any zone → modal explaining the concept with a generic
  reference example.
- Toggle layers on/off (FVG / OB / BOS / Sweep / Bias) so users can
  isolate concepts.

### Phase 3 — polish (~6-10h)

- **Walk-through mode**: animation that highlights each annotation in
  sequence, narrating "1. M15 candle closes → 2. H1 sweep detected →
  3. D1 bias confirms BUY → 4. Pending queued → 5. Risk gate passes
  → 6. Order placed". Acts as a built-in tutorial.
- **Educational glossary**: dedicated `/docs/smc` page in the dashboard
  with each concept, video clips of real trades exemplifying it
- **Performance attribution by SMC concept**: e.g. "REVERSAL setups
  with FVG retest = 72% win rate vs CONTINUATION without FVG = 58%".
  Aggregates across the entire trade history.

---

## 3. Other deferred items

- **Replay window auto-extend** (mentioned 2026-05-08) — auto-extend
  the replay window past `endDate` so positions resolve naturally,
  then truncate display. Removes force-close noise from short replays.
- **Replay UI: mark force-closed trades distinctly** — visually
  separate `FORCED_CLOSE` from `TP`/`SL` exits.
- **Public replay link mode** — allow `/replay/[id]?public=1` to be
  viewable without login, for verifiable performance proof on the
  landing page.
