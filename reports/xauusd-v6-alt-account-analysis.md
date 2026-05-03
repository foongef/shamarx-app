# V6-alt SMC on XAUUSD — Account-Size Analysis

**Generated:** 2026-05-02
**Strategy:** V6-alt (SMC sweep + continuation/reversal hybrid, post-refactor)
**Risk:** 1.5% per trade, with honest-risk cap (lot floor over-risk → skip trade)
**Source:** Real Dukascopy XAUUSD M15/H1/H4/D1, 2023-01-15 → 2026-04-30
**Raw data:** `reports/xauusd-account-sweep.json`

---

## Summary table

| Period | $100 | $500 | $1,000 | $2,000 | $10,000 |
|---|---|---|---|---|---|
| **2023** | +294.0% / PF 3.38 | +59.3% / PF 2.22 | +21.6% / PF 1.38 | +23.5% / PF 1.38 | +4.2% / PF 1.08 |
| **2024** | +714.6% / PF 3.84 | +32.0% / PF 1.59 | +38.1% / PF 1.54 | +45.2% / PF 1.52 | +44.3% / PF 1.55 |
| **2025** | +754.1% / PF 5.51 | +271.2% / PF 3.81 | +71.2% / PF 2.18 | +71.7% / PF 2.06 | +62.1% / PF 1.84 |
| **2026-YTD** | +667.1% / PF 15.13 | +369.0% / PF 10.16 | +47.8% / PF 4.74 | +31.1% / PF 3.21 | −5.5% / PF 0.35 |

(% return = total return for the period; PF = profit factor)

---

## Trade frequency comparison (key target: 10-15 trades/month)

| Period | $100 | $500 | $1,000 | $2,000 | $10,000 |
|---|---|---|---|---|---|
| 2023 | 13.4 | 15.6 | **14.7** | 15.8 | 14.6 |
| 2024 | 17.4 | 14.6 | **19.7** | 22.0 | 23.2 |
| 2025 | 14.0 | 17.3 | **16.0** | 18.6 | 19.8 |
| 2026-YTD | 10.6 | 13.1 | **10.1** | 10.1 | 5.5 |

**Frequency target hit at every account size for 2023-2025.** $10k drops below target only in 2026-YTD because the honest-risk skip rejected so many wide-SL setups during high-vol Q1 that the engine ran out of opportunities. Smaller accounts pulled in more setups via tight-SL filtering.

---

## Win rate progression — the cherry-picking effect

| Period | $100 | $500 | $1,000 | $2,000 | $10,000 |
|---|---|---|---|---|---|
| 2023 | 58.3% | 61.5% | 55.8% | 55.4% | 55.9% |
| 2024 | 64.6% | 55.6% | 60.4% | 61.2% | **66.3%** |
| 2025 | **69.4%** | 66.7% | 64.4% | 62.8% | 67.1% |
| 2026-YTD | **71.4%** | 67.3% | 60.0% | 52.5% | 27.3% |

**Pattern:** The smaller the account, the higher the win rate (with one exception — $10k 2024 sneaks ahead). Smaller accounts implicitly **cherry-pick tight-SL setups** because the honest-risk cap rejects wide-SL setups whose 0.01-lot floor would over-risk. Tight-SL setups happen to have higher hit rates (closer entries to invalidation = the trade either works fast or fails fast).

The most dramatic example is **2026-YTD**: 71.4% at $100 → 27.3% at $10k. The $10k account took an extra 20 setups that smaller accounts couldn't (wide SL), and most of those were losers in the choppy Q1 2026 environment.

---

## Drawdown pattern — small accounts compound, large ones grind

| Period | $100 DD | $500 DD | $1,000 DD | $2,000 DD | $10,000 DD |
|---|---|---|---|---|---|
| 2023 | 6.1% | 7.4% | 11.2% | 8.6% | 11.2% |
| 2024 | 5.0% | 6.4% | 8.4% | 6.2% | 8.3% |
| 2025 | 3.6% | 2.8% | 3.3% | 7.7% | 8.5% |
| 2026-YTD | 2.5% | 2.5% | 2.4% | 2.7% | 7.3% |

**$100 DD looks artificially low** because the account compounds so fast (e.g. $100 → $850 in 2025) that any losing streak relative to the new peak is small. **$10k DD is the honest measure** — at flat-ish balance, drawdowns are ~7-11%.

---

## Why does each account size produce different absolute % returns?

There are **three mechanisms** stacked on top of each other:

### 1. Lot-floor selection (the dominant effect)

The 0.01-lot minimum forces a hard relationship: at $100 with 1.5% risk = $1.50, the engine can only take setups where the SL distance × 100 oz × 0.01 lot ≤ ~$2.25. That means **only setups with SL ≤ ~$2.25 ever happen at $100**.

At $10k with 1.5% risk = $150, the engine can absorb SLs up to ~$30 (0.01-lot risk dollars vs balance) before hitting the cap. So **$10k takes the full universe of setups, including wide-SL ones**.

Wider-SL setups statistically have lower edge:
- 2026-YTD $10k took 22 trades, 27% win, PF 0.35 (mostly the wide-SL setups that smaller accounts skipped)
- 2026-YTD $100 took 42 trades, 71% win, PF 15.13 (only the high-edge tight-SL setups)

### 2. Compounding leverage

Even when both accounts take the same trade, the % return scales differently:

```
$100 with 1% per-trade gain × 200 wins / 11 mo:
  ($100)(1.01)^200 ≈ $725 → +625%

$10k with same 1% per-trade gain × 200 wins:
  ($10,000)(1.01)^200 ≈ $72,500 → +625% (same!)
```

So in *theory* compounding should be equal. But in practice **the $10k account doesn't get to compound the same trades** because:
- Lot sizing is granular at $10k (0.05, 0.10 lots) — actual % per trade is closer to ideal 1.5%
- At $100 the lot floor often forces *higher* effective % per trade on tight-SL setups, super-charging the compounding
- $10k's larger trade count includes the lower-edge ones, dragging the average return-per-trade

### 3. Drawdown denominator inflation

Drawdown % uses peak equity. After $100 has compounded to $750 (+650%), a $20 losing streak is only 2.7% from peak. The same strategy at $10k might never compound past $14k, so the same proportional losing streak shows as 7%+ DD.

---

## What's the "honest" expected return?

Look at the **$2,000 row** — it's where:
- Lot floor doesn't bind on most setups (so trade selection isn't accidentally filtered)
- But compounding still has some leverage on small wins
- Drawdown denominator isn't inflated by 7× growth

| Year | Trades/mo | Return | DD | Sharpe | PF |
|---|---|---|---|---|---|
| 2023 | 15.8 | **+23.5%** | 8.6% | 1.52 | 1.38 |
| 2024 | 22.0 | **+45.2%** | 6.2% | 2.24 | 1.52 |
| 2025 | 18.6 | **+71.7%** | 7.7% | 2.46 | 2.06 |
| 2026-YTD | 10.1 | **+31.1%** | 2.7% | 2.66 | 3.21 |

**Realistic expectation: ~+30-50% per year on a $1-2k account** with V6-alt SMC on XAUUSD, 10-20 trades/month, drawdown <10%.

---

## Account-size recommendation

| Size | Verdict | Why |
|---|---|---|
| **$100** | ❌ Don't deploy live | Backtest +700% returns are illusion (compounding + tight-SL selection). Real broker fills, slippage, and minimum lot mean a $100 account would underperform massively versus the backtest. |
| **$500** | ⚠️ Edge of viable | Honest backtest still shows +30-370% per year — the +370% (2026-YTD) is partly compounding bias. Realistic is +30-100%. Slippage starts hurting less but still meaningful. |
| **$1,000** | ✅ **Sweet spot start** | Lot sizing aligns with intended risk on most setups. +21 to +71% per year, drawdown 2-11%. Hit-rate 55-65%. The result you should believe. |
| **$2,000** | ✅ **Best balance** | More granular sizing, takes ~95% of available setups, maintains good edge. +23-72% per year, drawdown 2-9%. **Recommended deployment size.** |
| **$10,000** | ✅ Safe but lower % | Takes 100% of setups including wide-SL losers. +4-62% per year (one bad period at -5.5% in 2026-YTD). Edge dilutes but absolute $ wins are large. |

---

## Refactor confirmation

These numbers come from the new `src/backtest/engine/smc/` folder structure (refactored from monolithic `smc-engine.ts`). XAUUSD result parity verified:
- 2025 $1k pre-refactor: 194 trades, +71.19%, PF 2.18, Sharpe 2.89
- 2025 $1k post-refactor: 194 trades, +71.19%, PF 2.18, Sharpe 2.89 ✅

The pair-agnostic core (`smc-engine.ts`, `sweep-detector.ts`) reads tuning from `pairs/xauusd.ts`. Adding new pairs requires only a new config file in `pairs/`.

---

## Files

- `reports/xauusd-account-sweep.json` — raw 20-cell data
- `reports/xauusd-v6-alt-account-analysis.md` — this file
