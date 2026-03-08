# V4.1 — Adaptive Aggression Profit Engine (Spec)
**Purpose:** Keep V4’s survival (no 2026 blow-ups) **while restoring / increasing 2025 upside** via **offensive mode** that *only* activates when the system is statistically “in sync”.

> **Reality check (important):** No spec can guarantee profits in all market conditions.  
> The goal of V4.1 is **asymmetric performance**:  
> **(1) lose less / stop faster in bad regimes**, **(2) press harder in proven good regimes**, and **(3) preserve capital so you’re alive for the next trend run**.

---

## 0) What We Already Have (V4 baseline)
From your V3.2/V4 notes, V4 already implements:
- Trend/range/dead routing
- STRONG_TREND-only trend engine
- Locker/Runner exits
- TP-only loss reset
- Escalating pauses (win-only reset)
- Per-direction daily SL lockout
- Weekly DD breaker
- Rolling 7-day stop
- High-volatility regime filter (if you implemented it)
- Defensive mode that reduces trades in drawdown

**V4 effect:** 2026 survival improved (good), 2025 PnL reduced due to fewer trades (expected).

---

## 1) V4.1 Goals
### Primary
1. **Restore upside in strong years** (e.g., 2025) without removing V4 firewalls.
2. **Increase “winner exploitation”** (capture 3R–5R runs) via controlled pyramiding and re-entry.
3. Keep 2026-style protection: **no account death**; max DD constrained by firewalls.

### Secondary
4. Increase trade count **by opportunity scaling** (better re-entry + pyramiding), not by loosening quality filters.

---

## 2) V4.1 Non-Goals
- Not adding a new signal tier (do **not** reintroduce NORMAL_TREND engine).
- Not lowering core quality filters to “get more trades”.
- Not adding multi-instrument yet (that’s V4.2+). V4.1 is about **one-symbol profit capture**.

---

## 3) Core Idea: Three Modes (Offense/Neutral/Defense)
V4 has DEFENSIVE behavior. V4.1 adds **AGGRESSIVE** with strict activation criteria.

### 3.1 Mode Types
- **DEFENSIVE:** protect capital; reduce attempts; pyramiding OFF.
- **NORMAL:** default behavior.
- **AGGRESSIVE:** only when conditions are A-grade; pyramiding ON; re-entry faster; allows 2 positions.

### 3.2 Mode Decision Inputs
All computed at runtime:
- `equityPeak`, `equityDrawdownPct`
- `consecutiveLosses`, `consecutiveWins` (wins by pnl>0)
- `winsLastN`, `lossesLastN` over rolling window (e.g., 20 trades or 7 days)
- Current `regime` (STRONG_TREND / RANGE / TRANSITION / HIGH_VOL)
- Optional: `trendStabilityBars` (H1 stable bars)

---

## 4) Mode Switching Rules (Deterministic, Testable)

### 4.1 DEFENSIVE enter
Enter DEFENSIVE if ANY:
- `equityDrawdownPct >= 10`
- `consecutiveLosses >= 2`
- `lossesLast7Days >= 3`
- `rollingPnl7DaysPct <= -3` (tune)
- `regime in (TRANSITION, HIGH_VOL)`

Exit DEFENSIVE only if ALL:
- `equityDrawdownPct < 7`
- `consecutiveLosses == 0`
- `regime == STRONG_TREND` for ≥ 2 H1 bars

### 4.2 AGGRESSIVE enter (A-grade only)
Enter AGGRESSIVE if ALL:
- `regime == STRONG_TREND`
- `trendStabilityBars >= 3`  (H1 regime consistent)
- `equityDrawdownPct < 5`
- AND (either):
  - `consecutiveWins >= 2`  
  **OR**
  - `winRateLast20Trades >= 0.60` with `tradesLast20 >= 10`

Exit AGGRESSIVE if ANY:
- `equityDrawdownPct >= 7`
- `consecutiveLosses >= 1`
- `lossesLast7Days >= 2`
- `regime != STRONG_TREND`

### 4.3 NORMAL
If neither DEFENSIVE nor AGGRESSIVE, mode is NORMAL.

---

## 5) Behavior by Mode (This Is the Profit Engine)

### 5.1 Trade Gating
| Feature | DEFENSIVE | NORMAL | AGGRESSIVE |
|---|---:|---:|---:|
| Max new entries/day/direction | 1 | 1–2 | 2 |
| SL cooldown after SL | longer | normal | shorter |
| Re-entry after TP | longer | normal | faster |
| Rolling 7-day stop | strict | standard | **relaxed only when STRONG_TREND stable** |
| Pyramiding | OFF | limited | ON |

> **Key:** AGGRESSIVE does not bypass equity DD circuit breakers.

### 5.2 Pyramiding (Winner Exploitation)
**Current:** pyramiding triggered only once → too strict.  
**V4.1:** pyramiding triggers when the first position becomes “free risk” and trend remains A-grade.

**Rules**
- Allowed only if `mode == AGGRESSIVE` (or `mode == NORMAL` with extra strict conditions).
- First position must have `breakevenActivated == true`.
- Total open positions per symbol ≤ 2.
- Total symbol risk budget ≤ `maxSymbolRiskPct` (e.g., 2.5%).  
  If your sizing is clamped (0.01 lots), enforce budget by **max positions** and **entry frequency**.

**Pyramid Entry Timing**
- Prefer pyramid on **next valid pullback** after BE activation.
- Or allow “continuation add” if price breaks last swing high/low with ATR expansion (optional).

**Pyramid sizing**
- Conservative: pyramid position risk = 50–70% of initial position risk.
- If sizing clamped, keep lot same but cap to 2 total positions.

### 5.3 Runner Exit Logic
To get “highly profitable” years, runners must capture fat tails.
- Runner has **no TP** in STRONG_TREND
- Trailing should allow 3R–5R.

Recommended trail schedule (runner):
- +1.0R: move SL to BE (already)
- +1.5R: trail distance = 1.0R
- +2.0R: trail distance = 0.75R
- +3.0R: trail distance = 0.60R
- +4.0R: trail distance = 0.50R

**Locker TP**
- 50% at 1.5R (or 1.2R in weak trend, but trend engine is STRONG_TREND only here)
- If you already have locker/runner split, keep it.

---

## 6) Make Firewalls “Asymmetric” (Keep Defense, Add Offense)
Your V4 reduced 2025 PnL by filtering trades during drawdown. V4.1 modifies this:

### 6.1 Rolling 7-day Stop: Relax only in A-grade trend
In **AGGRESSIVE + STRONG_TREND stable**, treat rolling stop as **throttle**, not hard stop:
- Instead of pausing entirely, **reduce entry frequency** and **disable pyramiding**.

Example:
- If `lossesLast7Days >= 4` → pause 5 days (still)
- Else if `lossesLast7Days == 3` → AGGRESSIVE → NORMAL, pyramiding OFF, max entries/day = 1

### 6.2 DEFENSIVE mode should not kill “A-grade recovery”
When regime flips back to stable STRONG_TREND and you are out of deep DD, allow NORMAL quickly (avoid missing 2025 continuation moves).

---

## 7) Concrete Implementation Changes (Files)

> The filenames below match your structure (based on your earlier V2/V3 file list).  
> Adjust paths if your repo differs.

### 7.1 `src/backtest/engine/types.ts`
Add:
- `TradingMode = 'DEFENSIVE' | 'NORMAL' | 'AGGRESSIVE'`
- Extend risk state:
  - `equityPeak: number`
  - `equityDrawdownPct: number`
  - `consecutiveWins: number`
  - `winsLast20: number`, `lossesLast20: number` (optional)
  - `lossesLast7Days: number`, `pnlLast7Days: number`
  - `mode: TradingMode`
- Position fields (if not existing):
  - `isPyramid?: boolean`
  - `parentTradeId?: string` (optional)

### 7.2 `src/backtest/engine/risk-manager.ts`
Add functions:
- `updateEquityPeakAndDD(equity, state) -> state`
- `computeMode(state, regime, trendStabilityBars) -> TradingMode`
- `applyModeThrottles(mode, state) -> gating decisions`

Modify `recordTrade()`:
- Track `consecutiveWins` and `consecutiveLosses` by **pnl sign**:
  - `pnl > 0` increments wins, resets losses? (keep TP-only reset for losses if that’s your policy)
  - **Important:** keep TP-only reset for the *loss counter* if desired, but still track wins for mode switching.
- Maintain rolling windows (7-day and 20-trade):
  - Store a small queue of trades with timestamps/pnl to compute rolling stats.

Return gating decisions used by engine:
- `canOpenNewPosition: boolean`
- `maxEntriesPerDayPerDirection: number`
- `allowPyramiding: boolean`
- `cooldownAfterTP: number`
- `cooldownAfterSL: number`

### 7.3 `src/backtest/engine/backtest-engine.ts`
In walk-forward loop:
1. Update trade management (existing)
2. Check exits
3. Update risk state (equity peak, DD, rolling windows)
4. Determine regime & trend stability
5. Determine `mode` via risk manager
6. Apply firewalls (equity DD tier pauses, weekly pause, rolling loss pause)
7. Apply mode throttles (entry limits, pyramiding on/off, cooldown rules)
8. Evaluate entries and handle pyramiding entries

Add:
- `entriesTakenTodayByDirection` counters to enforce per-day caps per mode.
- A daily reset at day boundary.

### 7.4 `src/backtest/engine/strategy-evaluator.ts`
No major loosening of quality filters.
Add helpers:
- `getTrendStabilityBars(h1Candles, h1Indicators, currentTime) -> number`
- Signal tags:
  - `MODE_AGGRESSIVE`, `MODE_DEFENSIVE`
  - `PYRAMID_ADD`

Optional improvement for pyramid entry:
- allow second entry even if confirmation candle differs, but only when:
  - regime stable
  - first position is BE
  - entry is at EMA20/EMA50 pullback

### 7.5 `src/backtest/engine/position-simulator.ts`
Ensure runner trail schedule supports >3R runs.
If you have adaptive trailing, add the extra tiers listed above.

Also ensure BE activation is accurate with spread:
- BUY BE check uses `candle.high - spread/2`
- SELL BE check uses `candle.low + spread/2`

### 7.6 `src/backtest/engine/metrics-calculator.ts`
Make sure win/loss classification uses **pnl** (you already fixed PF issues earlier).
Add reporting:
- trades by mode (how many entries opened in each mode)
- PnL by mode
- pyramiding count + PnL

---

## 8) Default Parameters (Starting Point)
These are initial defaults for testing; tune via walk-forward.

### Mode thresholds
- Defensive enter DD: 10%
- Aggressive enter DD: < 5%
- Aggressive requires: stable trend ≥ 3 H1 bars
- Aggressive requires: 2 consecutive wins OR 60% win rate last 20 trades (min 10 trades)

### Cooldowns
- NORMAL:
  - after TP: 4 candles
  - after SL: 8 candles
- AGGRESSIVE:
  - after TP: 2 candles
  - after SL: 6 candles
- DEFENSIVE:
  - after TP: 6 candles
  - after SL: 12 candles

### Entry caps/day/direction
- DEFENSIVE: 1
- NORMAL: 2
- AGGRESSIVE: 2 (or 3 if proven safe)

### Pyramiding
- Only AGGRESSIVE
- Max 2 open positions
- Only after BE on first
- Disable if DD≥10% or lossesLast7Days≥3

---

## 9) Validation Plan (Must Follow)
### A) Regression
- Confirm V4 protection still works on 2026 (Jan–Feb):
  - DD capped (no -100%)
  - trading pauses trigger

### B) Profit Restoration
- Run 2025 full year:
  - Expect trades closer to V3.2 (recover some of the 11 missing)
  - PnL should increase toward V3.2 levels or beyond
  - Watch DD doesn’t jump above ~25–35% (depending on account size)

### C) Chop Survival
- Run 2024 full year:
  - Outcome may remain slightly negative, but ensure:
    - no deep DD spirals
    - defensive mode triggers correctly
    - trade count doesn’t explode

### D) Walk-forward
- Tune thresholds on H1 2025 H1 and validate on late 2025/early 2026.

---

## 10) What “Highly Profitable” Means Here
V4.1 aims to produce high returns by:
- **Capturing fat-tail winners** via runner trail tiers
- **Scaling winners** via pyramiding in A-grade trend only
- **Reducing missed continuation trades** via faster re-entry in AGGRESSIVE
- **Preserving capital** via V4 firewalls

If you achieve:
- PF > 1.4 in 2025
- DD bounded in 2026-like conditions
- No account death paths
…then multi-instrument (V4.2) becomes the next major return driver.

---

## 11) Next Version (After V4.1)
**V4.2 — Portfolio Layer**
- per-symbol budgets
- correlation throttles
- same V4.1 mode logic applied per-symbol with account-level caps

---

# End of V4.1 Spec
