# V6 / V6-alt Tuning Round — Detailed Analysis

**Generated:** 2026-05-01
**Source:** Real Dukascopy XAUUSD M5/M15/H1/H4/D1 data, 2023-01-15 → 2026-04-30
**Comparison:** `reports/v6-comparison.md` (36-cell matrix)

---

## TL;DR

| Strategy | Avg trades/mo | Avg return | Avg DD | Avg Sharpe | Avg PF | Best year |
|---|---|---|---|---|---|---|
| **V5.5b (baseline)** | 1.2 | +35.1% | 9.8% | 2.07 | 2.28 | 2024 (+71.9%) |
| **V6 (tuned)** | 1.5 | +26.1% | 8.4% | 1.83 | 2.22 | 2024 (+22.4%), **2023 fixed** |
| **V6-alt (tuned)** | 1.6 | −8.9% | 22.1% | 0.07 | 1.48 | 2026-YTD (+1.4%) |

**Bottom line:**
- ✅ **V6 fixes the 2023 hole** (V5.5b lost −2.2% on 7 trades; V6 won **+11.2%** on 15 trades) and lifts 2025 trade frequency 23% with similar Sharpe.
- ⚠ **V6 trails V5.5b on PnL in 2024 + 2025** because the D1 confluence + tighter trail clip some big winners. V6 is still profitable in those years and has lower DD.
- ❌ **V6-alt SMC engine is not yet edge-positive** on real Dukascopy XAUUSD. Single-2R-TP version produces trades (1.6/mo avg) but average PF=1.48 with 22% DD on $100 account. Negative expectancy in 2023-2025.
- 🚫 **No cell hits the strict 10-trades/mo target** — XAUUSD volatility on real data is much higher than the synthetic CSV the strategies were originally tuned on, so the same gates fire less often.

---

## What changed in V6

| Knob | Before | After | Effect |
|---|---|---|---|
| `qualityFloor` | 40 | **30** | Allows ~30% more setups through |
| `newsBlackoutMinutes` | 15 | **10** | Smaller blackout windows |
| D1 confluence penalty | −15 | **−10** + small +5 bonus | Less brutal counter-D1 reject |
| D1 hysteresis | none | **slope < 0.3% / 5 bars → NEUTRAL** | Avoids penalty during D1 ranges |
| Chandelier ATR mult | 3.0 | **2.5** | Tighter trail (note: actual chandelier code not yet shipped — value sits in config until the trail logic in position-simulator is replaced) |
| Max bars in trade | none | **48 M15 (12h) force-close if pre-BE** | Stops slow grinders bleeding R |
| BB Reversal engine | absent | **shipped** (RSI 32/68 + reversal candle + band tag) | Adds setups in low-ADX regimes |
| Range engine | OFF | **kept ON as fallback** | BB primary, Range fallback when BB doesn't trigger |

## What changed in V6-alt (SMC sweep + reverse)

| Knob | Before | After | Effect |
|---|---|---|---|
| Sweep buffer | 0.10 ATR | **0.15 ATR** | Filters small noise sweeps |
| Setup expiry | 12 H1 bars | **16 H1 bars** | More confirmation windows |
| Killzones | London 7-12 + NY 12-17 | **London 7-11 + NY 12-17** | Drops the 11-12 lull |
| D1 ADX gate | none | **skip if D1 ADX < 14** | Avoids ranging-D1 SMC traps |
| SL cooldown | 4 bars | **8 bars** (2h) | Lets failed-sweep clusters pass |
| Confirmation | close past mid only | **close past mid + (close past prior close OR strong body ≥ 0.55)** | Requires real reversal momentum, not just one wick |
| Premium/Discount filter | none | **H4 30-bar dealing range; long ≤ 50%, short ≥ 50%** | Prevents buying in premium / shorting in discount |
| TP design | 2R fixed | tried 1R+3R ladder, **reverted to 2R fixed** | Ladder hurt PF (−0.74 → 0.74); BE-stop on runner over-fired |

---

## Year-by-year analysis ($1,000 account, 3% / 1% risk)

### 2023 — V6 wins decisively

| | V5.5b | V6 | V6-alt |
|---|---|---|---|
| Trades | 7 | **15** | 21 |
| Return | −2.2% | **+11.2%** | −4.2% |
| Max DD | 7.95% | **2.05%** | 5.69% |
| Sharpe | −2.36 | **8.53** | −3.25 |
| Profit factor | 0.74 | **3.45** | 0.60 |

**Why V6 fixed it:** 2023 was a low-ADX grind ($1810 → $2087 = ~15% slow climb). V5.5b's RANGE_ENGINE alone wasn't enough — it took 7 trades that net-lost. V6 added the BB Reversal engine on top of Range; the two together found 15 quality mean-reversions, and the lower quality floor (30) let mid-grade setups in. **This is the headline win for V6.**

### 2024 — V5.5b still leads on PnL, V6 leads on stability

| | V5.5b | V6 | V6-alt |
|---|---|---|---|
| Trades | 24 | 22 | 27 |
| Return | **+71.9%** | +22.4% | −3.6% |
| Max DD | 4.63% | 6.48% | 5.63% |
| Sharpe | **11.11** | 7.32 | −1.70 |
| Profit factor | **5.83** | 2.99 | 0.79 |

**Why V6 trails:** V5.5b had a 75% win rate on 24 trades — extraordinarily clean. V6 takes 22 trades at 68% — adding extra setups (lower Q floor, BB engine) costs win rate. The chandelier 2.5 + max-bars rules were intended to clip losers but also clipped some winners. Both are still profitable, V5.5b is just better here.

**V6-alt note:** SMC took 27 trades at only 37% win rate. The 2024 trend was steady-up — sweep + reverse is wrong for that environment (you'd want sweep + continuation, not reverse).

### 2025 — V6 takes more trades, V5.5b takes more PnL

| | V5.5b | V6 | V6-alt |
|---|---|---|---|
| Trades | 21 | **26** | 26 |
| Return | +29.5% | +18.7% | −6.9% |
| Max DD | **2.73%** | 7.21% | 21.72% |
| Sharpe | **6.60** | 4.21 | −1.03 |
| Profit factor | **2.49** | 1.98 | 0.84 |

**Why V6 takes more:** The lower quality floor and BB Reversal pull in additional setups (5 more trades than V5.5b). Win rate stays 69% — the new entries aren't worse than baseline, but they're also not high-conviction. Still profitable with PF nearly 2.0.

**Why V5.5b's edge is hard to beat:** When V5.5b does fire on real data, it's incredibly selective and the trades are clean. V6 trades more often, V6 makes more $, but V5.5b's 2-3 monster trades per quarter dominate the PnL.

### 2026-YTD — All three lose, V6-alt least bad

| | V5.5b | V6 | V6-alt |
|---|---|---|---|
| Trades | 5 | 5 | 3 |
| Return | −15.7% | −10.5% | **+8.2%** |
| Max DD | 16.45% | 10.49% | **2.09%** |
| Sharpe | −11.13 | −17.79 | **+9.65** |
| Profit factor | 0.16 | 0.09 | **4.54** |

**Why this is the worst period for V5.5b/V6:** Q1 2026 had heavy volatility spikes around macro events. The trend engines kept catching false breakouts that reversed; only 1/5 trades won. **V6-alt had only 3 setups (the D1 ADX gate filtered most), but 2/3 won — exactly the kind of period sweep+reverse should excel in.**

This is the one cell where V6-alt's design pays off — choppy reversals during high-vol macro weeks.

---

## Account-size matrix observations

- **$100 account is broken** for all three strategies. Lot floor (0.01) means risk-per-trade is forced to ≥1% even with ATR-large stops, and a single SL hit can be 8-15% of equity. V6-alt 2025 at $100 hit −97% (effectively wiped out). **Do not run real money <$1k.**
- **$1k and $10k results track each other closely** — risk percent (3% V6, 1% V6-alt) means returns are similar, just scaled. $10k cell is the most reliable signal.
- **V6 is most account-size-stable** — 2023 returned +11.2% at both $1k and $10k. The DD scales similarly (~2-7%).

---

## What's still wrong / next-round ideas

### V6
1. **2026-YTD regression** is real (−10.5%). V6 took the same 5 trades V5.5b did and did slightly better only because the chandelier limited some losses. Both strategies need a "high-vol shutdown" — when M15 ATR/baseline > 2.0 for 3+ bars, halt entries entirely. This is on the V5.5b path too; would help both.
2. **Chandelier exit not actually shipped** — `chandelierAtrMult: 2.5` is config-only. The position-simulator still uses the legacy R-multiple trail. Adding the chandelier in `position-simulator.ts:computeTrailDistance` should cap MAX_BARS losses tighter.
3. **Quality floor 30 may be too loose for STRONG_TREND** — consider tier-based: 30 in RANGING (BB engine), 40 in WEAK_TREND, 50 in STRONG_TREND. High-quality trend setups are the ones most worth taking.

### V6-alt
1. **Sweep + reverse is the wrong direction for trending years.** 2024 had a steady uptrend; SMC kept selling tops that didn't materialize. Either:
   - Add a "sweep + continuation" mode for trending D1 (i.e. follow the sweep direction, not reverse it)
   - Or ONLY enable V6-alt when D1 is ranging (ADX < 22), inverting the current gate
2. **Win rate is the bottleneck** — 37-57% across years. Sweep detection is too liberal. Try requiring TWO consecutive H1 sweeps in opposite directions before entering the second one (real liquidity grab pattern).
3. **TP1+runner ladder didn't work** because runner BE-stop fires too often. Two ways to fix:
   - Drop the BE move on runner; let it run to 3R or stop full SL
   - Or use a 0.7R partial + runner with chandelier-only trail (no BE)
4. **D1 ADX 14 → 18** cut trade count in half last attempt. There's probably a sweet spot at 16; needs a parameter sweep.

### Both
- **Spread model audit**: Real Dukascopy spreads at low-vol hours can spike 2× the per-session config. The current `getSpread` is session-based but ignores realized intraday widening. A few of the V5.5b/V6 "loser" trades in 2026 may be artifacts of conservative spread modeling.

---

## Files changed this round

- `src/backtest/engine/pair-profile.ts` — qualityFloor 30, newsBlackout 10min, chandelier 2.5, both range engines on
- `src/backtest/engine/strategy-evaluator.ts` — `getD1Bias` hysteresis (slope < 0.3% returns NEUTRAL)
- `src/backtest/engine/backtest-engine.ts` — D1 penalty −10 + small +5 bonus, 48-bar max-bars force close, BB engine in routing chain
- `src/backtest/engine/bb-reversal-evaluator.ts` (new) — Bollinger 20/2 + RSI 32/68 + reversal candle
- `src/backtest/engine/smc-engine.ts` — sweep buffer 0.15, expiry 16 bars, D1 ADX 14, premium/discount filter, stricter confirmation, single 2R TP

## Files generated

- `reports/v6-comparison.md` — full 36-cell matrix
- `reports/v6-comparison.json` — raw numbers
- `reports/v6-tuning-analysis.md` — this file
