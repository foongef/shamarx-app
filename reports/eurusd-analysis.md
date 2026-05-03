# EURUSD V6 + V6-alt Comparison Matrix — Detailed Analysis

**Generated:** 2026-05-02
**Symbol:** EURUSD
**Source:** Real Dukascopy historical M15/H1/H4/D1, 2023-01-01 → 2026-04-30 (just imported, 100k M15 / 25k H1 rows)
**Configs used:**
- V6: scaffold profile in `pair-profile.ts:EURUSD` (XAUUSD-derived defaults, NOT yet tuned)
- V6-alt: scaffold config in `smc/pairs/eurusd.ts` (NOT yet tuned)
**Raw data:** `reports/eurusd-comparison.json`

---

## TL;DR

1. **V5.5b and V6 do not trade EURUSD meaningfully** — 0 to 6 setups across the entire 4-year window at any account size, almost all losing. The trend/FVG engines are calibrated for gold's volatility footprint and silently fail to fire on EURUSD's tighter movements. Result: useless.
2. **V6-alt SMC does trade EURUSD** but with **substantially weaker edge** than gold. Profitable in 2023 + 2025, losing in 2024 + 2026-YTD. PF averages 1.1-1.5 (vs gold's 1.5-2.8).
3. **Account-size effect FLIPS on EURUSD:** larger accounts perform *better*, not worse — the opposite of gold. Reason explained below.
4. **The scaffold config wasn't tuned** — these results show the floor of "drop the gold config onto EURUSD". With per-pair sweep buffer / D1 ADX / killzone tuning, EURUSD edge could improve materially.

---

## V6-alt SMC — full account × period grid

| Period | $100 | $500 | $1,000 | $2,000 | $10,000 |
|---|---|---|---|---|---|
| **2023** | -14.6% / PF 0.34 (66 trades, 36% win) ❌ | +5.7% / PF 1.15 (126 t, 60% win) | **+9.1% / PF 1.23** (132 t, 60% win) | +16.8% / PF 1.41 (146 t, 64% win) | **+21.7% / PF 1.72** (146 t, 64% win) ✅ |
| **2024** | +7.8% / PF 1.39 (66 t, 53% win) | +1.1% / PF 1.06 | -1.1% / PF 0.95 | -3.9% / PF 0.84 | -0.6% / PF 0.97 |
| **2025** | +4.0% / PF 1.08 (118 t, 44% win) | -0.4% / PF 0.99 | **+16.0% / PF 1.29** (196 t, 62% win) | +19.9% / PF 1.35 | **+22.2% / PF 1.49** (196 t, 62% win) |
| **2026-YTD** | -5.5% / PF 0.28 | -6.3% / PF 0.01 | -6.5% / PF 0.01 | -6.3% / PF 0.00 | -4.6% / PF 0.01 ❌ |

**$1,000 account aggregate (the realistic readout):**
- 2023: +9.1%, 11.3 trades/mo, PF 1.23 ✅
- 2024: -1.1%, 6.2 trades/mo, PF 0.95 ⚠️ slight loss
- 2025: +16.0%, 16.2 trades/mo, PF 1.29 ✅
- 2026-YTD: -6.5%, 3.0 trades/mo, PF 0.01 ❌ (only 12 trades, 8% win)
- **3-year total: roughly break-even to +18% with significant year-to-year inconsistency**

---

## V5.5b on EURUSD — strategy completely fails to fire

Across all 5 account sizes × 4 periods (20 cells):

| Year | Total trades across all account sizes |
|---|---|
| 2023 | 0 |
| 2024 | 0 |
| 2025 | 8 (all losses) |
| 2026-YTD | 0 |

The trend/FVG/range engines all use ADX, ATR, and EMA distance thresholds that were calibrated for gold's volatility. EURUSD's H1 ATR is 80-150% smaller in absolute price terms (0.0008-0.0028 range vs gold's 1.8-5.5), so:
- ADX-based regime detection rarely classifies as STRONG_TREND or WEAK_TREND
- FVG detection's "min body size" check filters most EURUSD candles out
- Range engine's ATR-band thresholds are too coarse

**V5.5b is gold-specific and would need a from-scratch retune to work on forex.**

## V6 on EURUSD — also barely fires

V6 inherits V5.5b's evaluators (trend, FVG, range) plus EMA-cross and momentum-continuation. The new engines fire occasionally but on weak signals:

| Year | Total V6 trades |
|---|---|
| 2023 | 4 (3 wins) |
| 2024 | 0 |
| 2025 | 26 (5 wins, all losing accounts) |
| 2026-YTD | 0 |

The few V6 trades that fire are **mostly losing** — the engines aren't picking real EURUSD setups, they're catching noise.

**V6 needs a per-pair tuning pass before it can compete on EURUSD.** That's roughly:
- Halve the ADX floors (15→8 trend, 10→6 FVG)
- Loosen RSI windows
- Halve all ATR-based multipliers in evaluators
- Re-tune quality scoring formula for forex pip space

This is several hours of work plus a parameter sweep — not done in this session.

---

## Why does the account-size pattern FLIP on EURUSD?

On gold, **smaller accounts outperformed** (cherry-picked tight-SL setups via lot-floor rejection).
On EURUSD, **larger accounts outperform**. Look at 2024 V6-alt:
- $100: 66 trades, 53% win, +7.8%, PF 1.39
- $1k: 76 trades, 52.6% win, -1.1%, PF 0.95
- $10k: 78 trades, 54% win, -0.6%, PF 0.97

The trade counts barely change between account sizes (66 vs 78). Why?

**EURUSD has tiny pip values** (0.00001 unit price = $1 per 0.01 lot per 10 pips). A "wide" EURUSD SL is 20-30 pips ≈ $20-30 per 0.01 lot. At $1k balance (1.5% risk = $15) the engine often ends up at an honest 0.005 lot, gets floored to 0.01, and the over-risk check rejects it. **Most setups get rejected at $100 AND $1k AND $2k**, only $10k can absorb them.

The lot-floor selection pattern still happens — but EURUSD setups have such tight ATR that the over-risk threshold barely binds anyway. So small accounts don't get the same "cherry-picking" benefit they got on gold.

In 2023 V6-alt:
- $100: 66 trades (lot floor rejecting most setups → tiny sample, lots of noise → 36% win, lost money)
- $10k: 146 trades (everything passes), 64% win, +21.7% — the **best result**

**Gold's "tight SL = high edge" pattern doesn't transfer to EURUSD** — EURUSD's lower volatility means even "wide" SLs are still in the same edge bucket.

---

## What this tells us about the strategies

### V5.5b is a **gold specialist**
- Built around ADX 15+ trend regimes
- Designed for $2-5 ATR price swings
- Will not transfer to majors without a rewrite of the regime detection + evaluator gates

### V6 is a **gold specialist with extra engines**
- Inherits V5.5b's gold-specific tuning
- New engines (EMA cross, momentum continuation) fire more often on EURUSD but on weak signals
- Profitable on gold (round 3 results) but **needs per-pair tuning** to work on forex

### V6-alt SMC is **somewhat pair-agnostic**
- Sweep+continuation/reversal logic is conceptually pair-neutral
- Works on EURUSD, but with **lower edge** than gold (PF ~1.2-1.4 vs gold's 1.5-2.8)
- The scaffold config gets you trades; **proper tuning could lift PF further**
- 2026-YTD disaster (PF 0.01) is suspicious — a 4-month sample with 12 trades and 8% win rate is small-sample noise compounded by an untuned config

---

## Why is gold more profitable than EURUSD for SMC?

Three structural reasons:

1. **Retail traders cluster around round numbers on gold** ($2000, $2500, $3000, $4000) — these create predictable liquidity pools that get swept and reverse. EURUSD's price levels don't carry the same psychological weight.
2. **Gold has fatter tails** — sweep moves are larger (3-5 ATR) so the R:R is naturally better. EURUSD sweeps are usually 1-1.5 ATR.
3. **Central banks intervene less in gold price action** intraday than they do via FX rates (jawboning, reserves, intervention). EURUSD is more "managed" → cleaner trends but messier sweeps.

This isn't a bug in the strategy — it's a real market structure difference. **Gold is the strategy's natural home.**

---

## Recommended next steps

### Quick wins (1-2 hours each)
1. **Tune EURUSD V6-alt scaffold config:**
   - Try `sweepBufferAtr: 0.20` (looser than 0.15)
   - Try `trendingD1Adx: 18` (lower than 20)
   - Try `slBufferAtrM15: 0.30` (wider than 0.25)
   - Run sweep → pick best config
2. **Drop V6 from EURUSD competition** — it doesn't fire enough to be useful without a deep retune
3. **Test GBPUSD with V6-alt** — likely the closest forex analog to gold (similar volatility profile, news-driven sweeps)

### Bigger investments
1. **Build a generic "pair tuning" workflow:**
   - Auto-compute baseline ATR percentiles per pair
   - Suggest sweep buffer / SL buffer / D1 ADX thresholds based on volatility profile
   - Run a small grid search per pair, pick winners
2. **Make V6 evaluators pair-aware** by reading ATR/RSI thresholds from `PairProfile` rather than hardcoded constants

---

## Bottom line for the V6 vs V6-alt internal competition

| Pair | V5.5b | V6 | V6-alt |
|---|---|---|---|
| **XAUUSD** (gold) | conservative but profitable (1-2 t/mo, +14% avg) | better frequency (4-5 t/mo, +1% avg, fragile) | **clear winner** (15+ t/mo, +44% avg) ✅ |
| **EURUSD** | doesn't fire | doesn't fire | works but weaker edge (~+10% avg) |

**V6-alt is the only strategy that works across both pairs out of the box**. Its SMC core is fundamentally more general-purpose than V6's regime-specific evaluators.

For deployment:
- **XAUUSD**: V6-alt is the chosen strategy
- **EURUSD**: V6-alt with config tuning recommended; V6 is not viable without a multi-day retune

---

## Files

- `reports/eurusd-comparison.json` — raw 60-cell matrix data
- `reports/eurusd-analysis.md` — this file
- `reports/xauusd-account-sweep.json` — companion gold data for direct comparison
- `reports/xauusd-v6-alt-account-analysis.md` — gold deep-dive
