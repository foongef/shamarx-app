# V4 — Adaptive Risk & Multi-Regime Profit System (Built to Survive 2026+ and Target 100%+ Years)

> **Goal:** Keep your proven **STRONG_TREND edge** (works in 2025), prevent **blow-ups** (what happened in early 2026), and expand profits via **controlled scaling** + **portfolio**.  
> **Truth:** No system can be profitable in *every* market state. What *is* achievable is:  
> **(1) avoid trading when you have no edge**, **(2) cap losses when edge disappears**, and **(3) scale when edge is strong**.

---

## 1) Why 2026 Blew Up (Root Cause)

Your 2026 sample is small (6 trades), but the *failure mode* is universal:

- **Losing streak + fixed aggression + no hard equity circuit breaker**
- On small balances, **min lot (0.01)** makes “dynamic risk %” ineffective → the only real control is **trade gating + time-based pauses + direction lockouts**.

**Key lesson:**  
A profitable strategy can still die without a **Risk-of-Ruin Firewall**.

---

## 2) V4 Architecture

```
Data → Indicators → Regime Classifier → Strategy Router → Signal Scoring
                                   ↓
                     Adaptive Risk Engine (A.R.E.)
                                   ↓
                       Execution + Trade Management
                                   ↓
                      Metrics + Walk-forward validation
```

### Components
1. **Regime Classifier** (market state)
2. **Strategy Router** (trend engine vs range engine vs no-trade)
3. **Signal Scoring** (optional, rule-based or ML/LLM)
4. **Adaptive Risk Engine (A.R.E.)** ← the missing piece that prevents 2026
5. **Trade Management** (locker/runner + trail)
6. **Portfolio Layer** (multi-symbol diversification)

---

## 3) Regime Classifier (H1)

### Inputs
- ADX(14), +DI/-DI
- EMA20/EMA50 alignment
- ATR(14) + ATR baseline (SMA50 or median)
- Optional: “ADX slope” (rising/falling)

### Outputs
- **STRONG_TREND**: high-quality continuation conditions
- **TRANSITION**: unstable flips (avoid)
- **RANGE**: mean-reverting conditions
- **HIGH_VOLATILITY / EVENT**: volatility spike (avoid or reduce risk)

### Example Rules (simple & robust)
- **STRONG_TREND**
  - ADX ≥ 25
  - DI separation ≥ 10
  - EMA20 > EMA50 (bull) or EMA20 < EMA50 (bear)
  - Regime stable ≥ 2 H1 bars (same direction)
- **TRANSITION**
  - ADX 20–25 OR DI separation < 10 OR frequent direction flips
- **RANGE**
  - ADX < 20, EMA20≈EMA50 (convergence)
- **HIGH_VOLATILITY**
  - ATR_ratio = ATR / ATR_baseline ≥ 1.6 (tune)

---

## 4) Strategy Router (Multiple Ways to Profit)

**Do not force one strategy to work everywhere.**  
Route by regime:

### A) Trend Engine (your edge)
Enabled only when: **STRONG_TREND**

- EMA pullback entries (EMA20 / EMA50)
- Optional breakout continuation (only if validated out-of-sample)
- Hybrid exit: **locker + runner**
- Pyramiding: **only after BE**, only if risk budget allows

### B) Range Engine (for choppy years like 2024)
Enabled only when: **RANGE** and not HIGH_VOLATILITY

- Mean reversion bands (EMA50 ± k·ATR)
- RSI filter (conservative; don’t make it too tight)
- Faster exits (TP near midline) + strict invalidation

### C) No-Trade
Enabled when: **TRANSITION** or **HIGH_VOLATILITY**
- This is what saves you in unknown 2026-type conditions.

---

## 5) The V4 Adaptive Risk Engine (A.R.E.) — Prevents Blow-ups

A.R.E. has 3 jobs:
1. **Throttle trading when the system is out of sync**
2. **Reduce exposure in drawdown**
3. **Scale exposure when conditions are favorable**

### 5.1 Risk Budgets (Account-Level & Symbol-Level)
- **Account risk budget per day** (e.g., 4–6% hard stop)
- **Account risk budget per week** (rolling, e.g., 8–10%)
- **Per-symbol risk budget** (e.g., 2.5%)
- **Per-direction budget** (e.g., max 1 SL per direction per day)

> On small accounts with 0.01 lot minimum, budgets are enforced mostly by **trade count gating**, not size.

---

## 6) The Three Firewalls (Mandatory)

### Firewall 1 — Equity Drawdown Circuit Breaker (hard stop)
Stops trading based on **equity drawdown from peak**, regardless of loss counters.

Suggested tiers:
- DD ≥ 10% → reduce risk & disable pyramiding (soft mode)
- DD ≥ 15% → pause 3 days
- DD ≥ 25% → pause 7 days
- DD ≥ 35% → pause 30 days (or manual review)

**Reason:** prevents “death spiral” from streaks.

---

### Firewall 2 — Escalating Loss-Streak Pauses (win-only reset)
Fixes the issue you saw: pauses resetting counters.

Rules:
- Keep `consecutiveLosses` across pauses
- **Only TP (real win) resets** the counter (not BE micro-profit)
- Escalate pause length:

Example:
- 3 losses → pause 1 day
- 4 losses → pause 3 days
- 5+ losses → pause 5 days

After pause ends:
- Allow **1 attempt**
- If it loses again → escalates again

---

### Firewall 3 — Rolling “Bad Week” Stop
Counts losses in a rolling window, not just consecutive.

Example:
- If `lossesLast7Days >= 4` → pause 5 days
- If `netPnLLast7Days <= -X%` → pause 5 days

**Reason:** markets can kill you with spaced losses that avoid consecutive logic.

---

## 7) Adaptive Aggression (How You Still Get 100%+ Years)

You don’t get 100%+ by trading more.
You get it by **scaling when your edge is strong**.

### 7.1 Risk Tiers (Regime-Aware Risk)
Set risk (or “allowed frequency”) by regime:

- **STRONG_TREND (A-grade)**: full aggression (e.g., 2.0–2.5% per symbol max budget)
- **RANGE (B-grade)**: half aggression (e.g., 0.5–1.0% budget; fewer attempts)
- **TRANSITION / HIGH_VOL**: 0 (skip)

If sizing is clamped by min lot:
- “risk” becomes **max number of entries per day** and **max re-entry frequency**.

---

### 7.2 Disable Pyramiding in Danger Mode
Pyramiding is a profit multiplier, but only when you’re in sync.

Disable pyramiding if ANY:
- equity DD ≥ 10%
- consecutiveLosses ≥ 2
- lossesLast7Days ≥ 3
- regime stability < 3 bars

Enable pyramiding only if ALL:
- STRONG_TREND
- first position BE activated
- equity at/near highs (e.g., DD < 5%)
- no same-day SL in that direction

---

## 8) Profit Booster Mechanics (What Actually Increases Returns)

### 8.1 Hybrid Exit (Locker + Runner)
- Locker: TP at 1.5R (stabilizes equity)
- Runner: no TP, trail exits (captures 3R–5R moves)

### 8.2 “Winner Adds” (Pyramiding Done Right)
- Only add after BE on position 1
- Add uses **remaining risk budget**, not additional risk

### 8.3 Optional: Breakout Continuation (Only if validated)
If you add breakout:
- Only STRONG_TREND
- Use swing high/low (not previous candle high)
- Require range expansion relative to ATR
- Require regime stability
- If it underperforms on 2024, disable it for TRANSITION and RANGE permanently

---

## 9) Portfolio Layer (Diversification = Stability)

Your 2026 blow-up risk is magnified when you trade only one symbol.

**Portfolio principle:** different instruments trend/range differently.

Suggested expansion order:
1. XAUUSD (keep)
2. NAS100 (trend-friendly)
3. US30 (trend-friendly)
4. GBPJPY (volatile; only after risk engine is stable)

Portfolio rules:
- Account max concurrent risk budget (e.g., 5%)
- Per-symbol budget (e.g., 2.5%)
- Correlation awareness: if XAU and NAS are both trending strongly, don’t max both at once until proven safe.

---

## 10) Practical Defaults (Start Conservative, Then Scale)

### For validation (avoid false confidence):
- riskPercent: 1.0–1.5%
- pyramiding: enabled only when DD < 5%
- breakout: OFF until validated
- daily loss stop: 4%
- weekly rolling stop: 8%

### For “100%+ years” mode (only after passing out-of-sample):
- riskPercent: 2.0–2.5% (trend only)
- pyramiding: ON in A-grade trend
- portfolio: 2–3 instruments
- strict firewalls active (so you don’t blow up)

---

## 11) How This “Overcomes 2026” (Unknown Future)

V4 does not assume the market will behave like 2025.

It survives by:
- **Skipping TRANSITION/HIGH_VOL regimes**
- **Escalating pauses without resetting losses**
- **Hard equity circuit breakers**
- **Rolling-week stop**
- **Disabling pyramiding when out of sync**
- **Diversifying opportunities across symbols**

So even if 2026 is “choppy + violent fake trends”, V4:
- trades less
- loses less
- waits for real trends
- keeps capital intact for when the edge returns

---

## 12) Backtest & Validation Protocol (Anti-Overfitting)

Run these as gates; don’t proceed if a gate fails.

### Gate A — 2024 (choppy)
- Goal: survive
- Max DD should be controlled (ideally < 20–30% depending on risk)
- If slightly negative PnL but low DD → acceptable

### Gate B — 2025 (trend)
- Goal: profit extraction
- PF > 1.3
- Runner contributes majority of profits
- Pyramiding increases profits without DD exploding

### Gate C — 2026 (Jan–Feb sample, plus any more data later)
- Goal: **no blow-ups**
- If it loses: the firewalls must stop it early (e.g., -5% to -15% worst-case)
- Trading should reduce automatically (gating works)

### Gate D — Walk-forward tests
- Tune thresholds on one window
- Validate on a later window
- Never tune on all years at once

---

## 13) Implementation Checklist (What to Build Next)

### A) Risk Engine upgrades (highest priority)
- [ ] Equity peak tracking + DD tiers (10/15/25/35)
- [ ] Escalating pause without counter reset
- [ ] Rolling 7-day loss / pnl stop
- [ ] TP-only reset of consecutive losses
- [ ] Disable pyramiding in danger mode

### B) Strategy Router hardening
- [ ] Force no-trade on TRANSITION/HIGH_VOL
- [ ] Enforce per-direction daily SL lockout

### C) Portfolio layer (after stability)
- [ ] Add instrument configs
- [ ] Add per-symbol budgets
- [ ] Add correlation guardrails (simple first)

---

## 14) The “Highly Profitable” Truth (How 100%+ Happens)
100%+ years come from **a few strong trend runs**, amplified by:
- runner exits (3R–5R)
- pyramiding winners
- multiple instruments (more trend opportunities)
- strict survival rules (so you’re alive to catch them)

**The #1 reason retail bots fail:** they die in the bad regime before the good regime arrives.

V4 exists to prevent that.

---

## 15) Summary
- Keep your STRONG_TREND edge.
- Add a **real adaptive risk engine** that cannot be bypassed by resets.
- Use pyramiding only when conditions are A-grade.
- Add portfolio only after survival is proven.
- Aim for **capital preservation first**, then **profit amplification**.

---

# End of V4
