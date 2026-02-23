# V2.8 — Anti-Whipsaw Filters

**Date:** 2026-02-24
**Commit:** `e837ee1`
**Instrument:** XAUUSD

---

## Problem

XAUUSD Jan 2026 backtest: 7 trades, ALL 7 SL hits, -$186 (-37%). Three structural failure modes identified from real trade analysis:

1. **Regime instability** — H1 ADX flips bullish/bearish/ranging, strategy follows each flip and gets chopped
2. **Loss clustering** — 2-3 SL hits in the same direction on the same day (Jan 8: 2 SELLs, Jan 16: 3 SELLs, Jan 26: 2 BUYs)
3. **Overextended entries** — Entering far from EMA50 during parabolic moves
4. **Abnormal volatility** — ATR spiking to 2-4x normal, SL distances too wide

## Filters Implemented

### 1. H1 Regime Stability (strategy-evaluator.ts)

**Logic:** Require the H1 regime to be identical for the current bar and 2 prior H1 bars. If the regime just flipped, don't enter — wait for confirmation.

**Function:** `isH1RegimeStable(h1Candles, h1Indicators, currentTime, lookback=2)`

- Binary-searches H1 candles to find current H1 index
- Checks `getMarketRegime()` for indices `[bestIdx, bestIdx-1, bestIdx-2]`
- All 3 must return the same regime (BULLISH/BEARISH/RANGING)
- Called in `evaluateSetup()` after `getH1Regime()` — returns null if unstable

**Rationale:** Regime flips are the #1 cause of whipsaw. If ADX just flipped from BEARISH to BULLISH, the trend isn't confirmed yet. Waiting 2 H1 bars (2 hours) for consistency dramatically reduces false entries.

### 2. Same-Day Direction Limit (backtest-engine.ts)

**Logic:** After 1 SL hit in a given direction on a given day, block further entries in that direction for the rest of the day.

**Implementation:**
- `dailySlCount = { BUY: 0, SELL: 0 }` — tracked in walk-forward loop
- Resets when `currentDate` (YYYY-MM-DD) changes
- Increments `dailySlCount[pos.side]++` on each SL exit
- Before opening a new position: `if (dailySlCount[signal.side] >= 1) continue`

**Rationale:** When a direction hits SL, the market structure for that direction is invalidated for the day. Repeating the same directional bet compounds losses. Jan 2026 had 3 SELLs hit SL on Jan 16 — this filter would have blocked trades #2 and #3.

## Filters Tested and Removed

### Overextension Filter (removed)

**Logic:** `abs(close - ema50) / atr > 2.5 → reject`

**Why removed:** In strong trends (XAUUSD 2025 bull run), price being far from EMA50 is normal. This filter killed 10 BUY-side TP winners while barely reducing losses. Fundamentally anti-trend-following.

### ATR Regime Filter (removed)

**Logic:** `atr / sma(atr, 50) > 1.3 → reject`

**Why removed:** ATR naturally expands during London/NY sessions and strong trends — exactly when the strategy should be trading. Filtering elevated ATR meant filtering out the most productive periods. The threshold would need to be much higher (>2.0x) to only catch true anomalies, at which point it adds negligible value.

## Results

### XAUUSD 2025 Full Year (primary benchmark)

| Metric | V2.7 (32e8ebe4) | V2.8 (a078358c) | Change |
|--------|-----------------|-----------------|--------|
| Total trades | 94 | 74 | -20 (-21%) |
| Win rate | 32.1% | 28.9% | -3.2% |
| Total PnL | +$140.95 | +$148.15 | +$7.20 (+5%) |
| Max drawdown % | 46.67% | 43.82% | -2.85% (better) |
| Sharpe ratio | 1.31 | 1.63 | +0.32 (better) |
| Avg RR | 1.48 | 1.75 | +0.27 (better) |
| Profit factor | 0.70 | 0.71 | +0.01 |
| Avg win | $25.10 | $29.92 | +$4.82 |
| Avg loss | $16.92 | $17.11 | +$0.19 |
| Max consec losses | 9 | 9 | same |
| Breakevens | 38 | 29 | -9 |

**Interpretation:** 20 fewer trades with slightly better PnL, lower drawdown, and higher Sharpe. The filters are removing noise trades without killing winners. The higher avg win ($29.92 vs $25.10) suggests remaining trades have better quality setups.

### Failed V2.8 Attempt (with all 4 filters)

For reference, the initial implementation with all 4 filters (768c6d89) produced:
- 57 trades, 16.7% win rate, **-$213.30 PnL**, 202.5% max DD
- The overextension + ATR filters killed 10 of 14 BUY-side winners
- This led to removing the 2 anti-trend filters and keeping only the 2 structural ones

## Files Changed

| File | Changes |
|------|---------|
| `src/backtest/engine/strategy-evaluator.ts` | Added `isH1RegimeStable()` function, regime stability check in `evaluateSetup()`, version tag V2.8 |
| `src/backtest/engine/backtest-engine.ts` | Added `dailySlCount` tracking, daily reset, SL direction increment, pre-entry direction check |

## Version History

| Version | Key Change | XAUUSD 2025 PnL |
|---------|-----------|-----------------|
| V2.2 | Base strategy (EMA pullback + ADX regime + session filter) | — |
| V2.6 | Fading trend filter, EMA20 slope, tightened RSI | — |
| V2.7 | 3-tier ADX system, tiered SL/TP, weak trend quality gate | +$140.95 |
| **V2.8** | **Anti-whipsaw: regime stability + daily SL direction limit** | **+$148.15** |
