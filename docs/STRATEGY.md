# Strategy — What the Engine Actually Does

Living doc. **Read this before claiming what the strategy can or can't do.** Updated as features ship.

Last updated: 2026-05-09

---

## In one sentence

ShamarX runs a **liquidity-sweep + HTF-bias + structure-anchored-stop**
strategy on 4 forex pairs, gated by a multi-layered risk system. It is
*one slice* of the SMC framework, not the full thing.

---

## What's IN the engine today

### Entry trigger
- **H1 liquidity sweep** of recent swing high/low (`detectSweep` —
  `src/backtest/engine/smc/sweep-detector.ts`). Wick beyond swing extreme,
  close back inside.
- **D1 bias filter** — sweeps must align with daily-timeframe direction
  (`getD1Bias` via ADX + EMA). Counter-trend sweeps are rejected.
- **Two modes**: `REVERSAL` (quiet markets) and `CONTINUATION` (trending
  markets). Mode chosen by D1 ADX threshold per pair.
- **Multi-bar pending queue** — once detected, a sweep stays valid for
  N H1 bars (`setupExpiryH1Bars`); any M15 close in that window can take it.
- **Killzone hours filter** — only fires inside London / NY active hours
  per-pair config (XAUUSD: 7-11 UTC + 13-17 UTC, etc).
- **Anchor-sweep filter** (XAUUSD specifically) — requires sweep
  displacement ≥ 0.5×ATR to filter weak sweeps that XAUUSD prints often.

### Stop placement
- **Structure-anchored**: SL goes beyond the sweep wick (REVERSAL) or
  beyond the sweep candle high/low (CONTINUATION) + a small ATR buffer.
  Not fixed pips.

### TP placement
- **R-multiple**: TP1 at `tp1R × slDistance`, TP2 at `tp2R × slDistance`.
- Optional **TP1 partial** — fraction of total lot exits at TP1, runner
  continues to TP2 with trailing stop.

### Position management
- **Break-even move** at +1R (configurable threshold)
- **Trailing stop** kicks in at +2R; ratchets behind the price
- **TP removal** — runner can lose its fixed TP and rely on trail only
  once price travels far enough

### Risk management (`RiskManager`)
- Per-trade risk: configurable %/trade (default 1.5%)
- **Daily-loss circuit breaker** — pauses for the day if daily PnL crosses threshold
- **Consecutive-loss escalating pause** — 5 in a row → 1-day pause; 6 → 3 days; 7+ → 5 days
- **Drawdown-tier brakes** — pause for N days at 15%/25%/35% drawdown tiers
- **Rolling 7-day loss cluster** — 4+ losses in 7 days → 5-day pause
- **40% hard-kill** — engine permanently disarms; manual reset only
- **Drawdown-adaptive sizing** — risk scales down as DD accumulates
- **Quality / regime multipliers** — currently always passes neutral 50/WEAK_TREND
- **Position cap** — `maxOpenPositions` across all 4 pairs

### Persistence
- All RiskManager state survives container restarts via Redis snapshot
  (proactive debounced + 30s backstop interval persistence)
- Pending queue, cooldowns, actioned-sweeps dedup all persist

### Observability
- Telemetry ring buffer (last 200 events)
- Public + authenticated pulse endpoints
- Replay theatre with full historical scrub
- Per-pair scanner + decision pipeline visualization on dashboard
- Email notification on every trade-open

---

## What's NOT in the engine (yet)

These are SMC concepts users may *expect* given the "SMC strategy"
framing, but are not currently implemented as decision inputs:

| Concept | Status | Notes |
|---|---|---|
| **Fair Value Gap (FVG)** | ❌ Not implemented | Tracked: planned as Phase 2 (advisory or gating) |
| **Order Block (OB)** | ❌ Not implemented | Tracked: planned as Phase 2 |
| **Break of Structure (BOS)** | ❌ Not explicitly tracked | Could be derived from existing structure-evaluator data |
| **Change of Character (CHOCH)** | ❌ Not implemented | Lower priority |
| **Mitigation block** | ❌ Not implemented | |
| **Premium/discount Fib zones** | ❌ Not implemented | |
| **Inducement / breaker block** | ❌ Not implemented | |
| **Volume profile / VWAP** | ❌ Not implemented | |
| **News / macro filter** | ❌ Not implemented | Tracked in `FUTURE_WORK.md` (news-blackout) |
| **Sentiment / LLM filter** | ❌ Not implemented | Lower priority |

The strategy has consistently delivered ~65% WR / +179% over 28 months
in replay **without** these. They're enhancements, not corrections.

---

## Planned additions (in priority order)

### 1. FVG / OB / BOS detection — Phase 2 (in progress)

- **Step 1**: Implement detectors as pure functions (no behavior change yet)
- **Step 2**: Wire as **optional gates** in pair configs, default OFF
- **Step 3**: Replay-validate each combination vs baseline:
  - Baseline (no new gates)
  - +FVG only
  - +OB only
  - +BOS only
  - +FVG +OB
  - All three
- **Step 4**: Lock in only configurations that meet or beat baseline
  metrics (≥65% WR / ≥179% / 28-month, ≤current max drawdown)
- **Step 5**: Persist detection metadata on trade rows so the
  educational chart can render the zones

**Validation criteria** before live deployment of any new gate:
- Win rate ≥ baseline within 1 standard error
- Realized PnL ≥ baseline
- Max drawdown ≤ baseline + 2 percentage points
- Trade count ≥ 60% of baseline (some reduction OK; <60% means we're
  filtering too aggressively)
- Sharpe-ish (PnL/MaxDD) ≥ baseline

### 2. News-blackout filter

Skip evaluations 30 min before / 60 min after high-impact macro
events (NFP, FOMC, CPI, ECB, BoE). Captured in `FUTURE_WORK.md`.

### 3. Live `/lives/[id]` chart wiring

Same SmcAnnotatedChart on live trades (replay-only today).

---

## Pair configs (current values)

Defined in `src/backtest/engine/smc/pairs/`:

| Pair | sweepBufferAtr | slBufferAtrM15 | setupExpiryH1Bars | trendingD1Adx | killzones (UTC) |
|---|---|---|---|---|---|
| XAUUSD | 0.5 | 0.6 | 4 | 28 | [7,11], [13,17] |
| EURUSD | 0.4 | 0.5 | 5 | 25 | [7,11], [13,17] |
| GBPUSD | 0.4 | 0.5 | 5 | 25 | [7,11], [13,17] |
| USDJPY | 0.4 | 0.5 | 5 | 25 | [0,4], [13,17] |

XAUUSD has `useAnchorSweeps: true` and `anchorDisplacementAtr: 0.5` —
filters weak sweeps unique to gold's behaviour.

---

## Replay benchmark (locked in 2026-05-08)

| Window | 2024-05-07 → 2026-05-07 (28 months) |
|---|---|
| Initial balance | $10,000 |
| Risk per trade | 1.5% |
| Pairs | XAUUSD, EURUSD, GBPUSD, USDJPY |
| Trade count | 790 |
| Win rate | 65.8% |
| Realized PnL | +$17,914.40 |
| Net return | +179.14% |
| Per-pair PnL | XAUUSD +$4,218 · EURUSD +$5,102 · GBPUSD +$4,890 · USDJPY +$3,704 |

**This is the baseline.** Any new gate or filter must equal or beat
this on the same window before going to live.

---

## Anti-claims (be honest in marketing)

When describing the strategy externally:

- ✅ "Liquidity-sweep + HTF bias + structure-anchored stops" — accurate
- ✅ "Validated across 28 months of Dukascopy data" — verifiable
- ✅ "Smart Money Concepts strategy" — accurate but narrow
- ⚠️ "Full SMC framework" — **not accurate** until FVG/OB/BOS land
- ⚠️ "AI-powered" / "agentic" — **not accurate**; pure rule-based

The replay theatre is the strongest credibility play we have. Lean on
it; don't over-claim.
