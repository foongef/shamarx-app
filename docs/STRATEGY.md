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
| **Fair Value Gap (FVG)** | 🟡 Detector exists, NOT gating | Tested both as post-entry and pre-sweep gate; both rejected via 28-month replay. Used for advisory chart annotations only. |
| **Order Block (OB)** | 🟡 Detector exists, NOT gating | Same story as FVG. |
| **Break of Structure (BOS)** | 🟡 Detector exists, NOT gating | Same story. |
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

### 1. FVG / OB / BOS detection — ✅ VALIDATED, gates stay OFF

**Two full validation rounds. 12 scenarios tested. None pass.**

Detectors implemented as pure functions and wired as optional gates.
Comparison runner at `scripts/compare-smc-gates.ts` validates against
the 28-month baseline. Both attempts conclude the same: **the
strategy's existing filters already extract all available structural
signal — additional structure gates remove signal and noise
proportionally.**

#### Round 1 — Path B: post-entry gates (2026-05-09)

Question asked: "is there post-entry structure (FVG / OB / BOS)
confirming the trade?"

| Scenario | Trades | WR% | PnL | Return |
|---|---|---|---|---|
| **baseline** | 686 | 64.9 | $14,370 | **+143.70%** |
| fvg | 512 (75%) | 56.6 (−8.3pp) | $5,400 | +54.01% |
| ob | 464 (68%) | 61.4 (−3.5pp) | $5,922 | +59.22% |
| bos | 454 (66%) | 53.7 (−11.2pp) | $540 | +5.40% |
| fvg+ob | 332 (48%) | 50.3 (−14.6pp) | $1,894 | +18.94% |
| all | 248 (36%) | 52.0 (−12.9pp) | $2,897 | +28.97% |

Diagnosis: temporal misalignment. ShamarX fires immediately after
sweep — we ARE the move that creates the FVG, not the move that
retests it. The gates ask for structure that hasn't formed yet.

#### Round 2 — Path 3: pre-sweep validity gates (2026-05-10)

Reframed the question: "was the swept LEVEL itself created by
meaningful structure?" — answerable at signal time, unlike Path B.

| Scenario | Trades | WR% | PnL | Return |
|---|---|---|---|---|
| **baseline** | 686 | 64.9 | $14,370 | **+143.70%** |
| p3-ob | 482 (70%) | 60.6 (−4.3pp) | $4,949 | +49.49% |
| p3-fvg | 368 (54%) | 60.6 (−4.3pp) | $3,896 | +38.96% |
| p3-bos | 496 (72%) | 62.1 (−2.8pp) | $4,633 | +46.33% |
| p3-ob+fvg | 330 (48%) | 60.3 (−4.6pp) | $3,333 | +33.33% |
| p3-all | 306 (45%) | 62.4 (−2.5pp) | $4,415 | +44.14% |

Same shape of failure: trade count drops 28-55% AND win rate drops
2.5-4.6pp simultaneously. PnL collapses 65-77% across the board.

#### Final conclusion

The strategy's existing filters (sweep buffer × ATR × D1 bias ×
killzones × XAUUSD anchor sweeps) **already extract all the
structural signal extractable from this approach**. There's no
remaining "low-quality sweeps" subset that a structure gate can
remove without also removing equally-good high-quality sweeps.

The strategy's edge is the **speed-of-entry × HTF-bias-alignment**
combination, fully baked into the existing logic. Any additional
filter — regardless of whether it asks pre-sweep or post-entry
questions — produces a smaller AND lower-quality sample.

#### What we keep

- All gate flags remain default OFF in pair configs. Live behaviour
  unchanged from the validated baseline.
- Detectors stay in the tree (`fvg-detector.ts`, `order-block-detector.ts`,
  `bos-detector.ts`) for the **educational chart's advisory annotations**:
  the dashboard draws nearby SMC structure for each trade so users
  can SEE the patterns, even though the engine didn't *gate* on them.
- Comparison runner stays for future re-validation if anyone wants
  to try a different approach.

#### Pass criteria (kept for any future attempt)

- Win rate ≥ baseline within 1 standard error
- Realized PnL ≥ baseline
- Trade count ≥ 60% of baseline (less = filtering too hard)
- Max drawdown ≤ baseline + 2 percentage points

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
