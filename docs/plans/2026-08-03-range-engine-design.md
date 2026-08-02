# RANGE Engine — Mean-Reversion Design (GIDEON's second edge)

**Status:** design · **Owner build estimate:** 1–2 weeks · **Live impact until shipped:** none (replay-only, per-pair engine assignment off by default)

## Why (evidence-driven)

- Sweep-reversal is regime-scoped: profitable 2023+, ~flat-to-negative in chop/low-vol stretches (11-year map; July 2026 live fortnight −4% in exactly such a stretch).
- The rejected pairs (USDCAD, AUDUSD) and EURUSD's marginal character fit mean-reversion better than stop-hunt momentum — "every pair can earn" via *engine assignment*, not config bending (R3 conclusion).
- A second, negatively-correlated edge smooths the book: range engines earn precisely when sweep engines starve. Diversification was the strongest surviving lesson of the self-hedged-book discovery.
- Partial scaffolding exists: `RANGE_ENGINE` setup-tag path in the position simulator (fixed SL/TP, no trail) already short-circuits trade management correctly.

## Signal logic v0 (mechanism-first, deliberately simple)

**Range definition (H1):**
- D1 ADX below `rangeAdxCeil` (default 18) — no trend in force.
- Rolling `rangeLookbackH1` (default 48) high/low band with ≥ `minTouches` (default 2) touches each side within tolerance `touchTolAtr` (default 0.25 × H1 ATR).
- Band width ≥ `minWidthAtr` (default 2.5 × H1 ATR) — refuse micro-ranges (the sweep engine's quality-gate lesson: tiny structures are tradeable only when the location edge is overwhelming).

**Entry (M15, fade the edge):**
- Price pokes beyond band edge by ≤ `maxPokeAtr` (0.5 × ATR) and the M15 closes back inside → enter toward the middle.
- (A poke *beyond* maxPoke = breakout risk → no trade, and range invalidates after `breakoutBufferAtr`.)

**Risk:**
- SL beyond the edge poke + `slBufferAtr` (0.3 × M15 ATR). Fixed — **no trail, no BE** (range trades mean-revert or fail fast; v0 keeps management dumb on purpose).
- TP1 at mid-band (50% width), 50% partial; runner at opposite edge − buffer.
- Same risk % / sizing / breaker / shared-brain plumbing as GIDEON (engine-agnostic by design).

**Shared-gate reuse:** killzones NOT applied (ranges live off-hours); news blackout, stale-geometry guard, circuit breaker all apply.

## Integration architecture

```
LiveSmcOrchestrator.evaluate(symbol,…)
  ├─ if cfg.engines includes 'SWEEP'  → existing path (unchanged)
  └─ if cfg.engines includes 'RANGE'  → RangeEvaluator.evaluate(...)
       → SmcLiveSignal{ mode:'RANGE', setupTags:[…,'RANGE_ENGINE'] }
```
- `SmcPairConfig.engines?: ('SWEEP'|'RANGE')[]` — default `['SWEEP']`, so nothing changes anywhere until a pair opts in.
- Replay tests via `pairConfigOverrides` exactly like every prior experiment.
- One pending/cooldown namespace per engine (no cross-engine interference).

## Validation protocol (pre-registered)

1. **Design window 2015-07 → 2021-07**, candidate pairs EURUSD, USDCAD, AUDUSD (+XAUUSD range regimes). Max **3 tuning iterations** of the knobs above; every iteration logged in this doc.
2. **One-shot validation 2021-07 → 2025-07 + last-12** — untouched during design.
3. **Book test:** RANGE pairs added to the live 4-pair SWEEP book; must improve book net AND not worsen book max-DD >10% (the self-hedging lesson: pair-alone results don't transfer).
4. **Ship bar:** positive in both validation windows, book test passes, then live probation month at minimum size before full enable.

## Explicit risks

- Range detection is the classic overfit magnet — hence 3-iteration cap and knob count kept under 8.
- Breakout losses cluster (range engines lose exactly when trends ignite); the D1-ADX ceiling + breaker are the guards.
- If v0 fails validation honestly: record and stop. No v0.1-v0.9 knob spiral — a failed simple mean-reversion is strong evidence the pairs need different treatment entirely.
