# V3 — Multi-Regime Trend System (XAUUSD-first)

**Goal:** Build a _high-profitability_ automated trading system that **captures large trend expansions**, survives chop, and scales with controlled drawdowns.  
**Reality note:** No strategy is “always profitable.” V3 is designed to maximize _expectancy_ (edge) + _survivability_ (risk controls), so you can compound when conditions are favorable.

---

## 0) Core Philosophy (Prop-Style)

1. **Don’t fight trends.** In strong trends, _high ATR and “overextension” are features_, not bugs.
2. **Avoid loss clustering.** Most blow-ups happen from repeated losses in the same day/regime.
3. **Let winners run.** One trend week should pay for multiple small losses.
4. **Trade fewer regimes, trade them better.** Classify market state and use the correct entry type.

---

## 1) Instruments & Timeframes

- **Primary:** XAUUSD
- **Optional portfolio add-ons (after stable):** NAS100, US30, GBPJPY
- **Entry timeframe:** M15
- **Regime timeframe:** H1
- **Optional context timeframe:** H4 (major S/R zones only)

---

## 2) V3 Regime Classification (H1)

V3 uses **3 regimes**, and each regime enables different entries + rules.

### Indicators (H1)

- EMA20, EMA50
- ADX14, +DI14, -DI14
- ATR14 + ATR_SMA50 (or ATR median)

### Regime rules

#### A) RANGING (no-trade)

- ADX < 20 OR DI separation weak
- OR EMA20 and EMA50 converging (optional)

**No entries.**

#### B) NORMAL_TREND (pullback mode)

- ADX >= 20
- DI separation >= 6
- EMA20 vs EMA50 agrees with DI direction
- Regime stability: last **2 H1 bars** same direction

**Entries enabled:** EMA20 Pullback

#### C) STRONG_TREND (expansion mode)

- ADX >= 25 AND ADX rising (ADX[i] > ADX[i-1])
- DI separation >= 10
- EMA separation: |EMA20-EMA50| >= H1_ATR \* 0.25 (optional sanity)
- Regime stability: last **3 H1 bars** same direction

**Entries enabled:** Breakout Continuation + EMA50 Deep Pullback  
**Risk can scale up slightly** (optional)

---

## 3) Session Rules (DST-safe)

Use timezone-aware sessions (already implemented).

### Default (XAUUSD)

- London: 08:00–16:59 local (Europe/London)
- New York: 08:00–13:59 local (America/New_York)

### Spread/volatility gating

- If spread is above your “bad spread” threshold for that hour bucket → skip new entries.
- If “news spike” detected via ATR ratio (ATR / ATR_SMA50 > 1.6) → skip entries for 60–120 minutes (optional).

---

## 4) V3 Entry Types (3 strategies under one regime engine)

### Entry Type 1 — EMA20 Pullback (NORMAL_TREND + STRONG_TREND)

**Intent:** High win-rate continuation entries.

**Conditions (M15):**

- Regime: NORMAL_TREND or STRONG_TREND
- Pullback interaction: price touches EMA20 zone
  - zone = EMA20 ± (ATR_M15 \* 0.6)
- Directional commitment candle:
  - BUY: low dips into zone, close > EMA20, bullish close
  - SELL: high into zone, close < EMA20, bearish close
- Confirmation: one of:
  - Engulfing
  - Pin bar rejection (preferred)
  - Strong close (optional; can be weaker)

**Tag:** `V3_EMA20`

---

### Entry Type 2 — EMA50 Deep Pullback (STRONG_TREND only)

**Intent:** Higher R:R entries in strong trends.

**Conditions (M15):**

- Regime: STRONG_TREND only
- EMA20 and EMA50 separated by >= ATR_M15 \* 0.5 (avoid convergence chop)
- Pullback interaction: touches EMA50 zone
  - zone = EMA50 ± (ATR_M15 \* 0.75)
- Commitment:
  - BUY: close back above EMA50 + bullish candle
  - SELL: close back below EMA50 + bearish candle
- Confirmation must be stronger:
  - Pin bar OR engulfing (no “weak strong-close-only”)

**Tag:** `V3_EMA50`

---

### Entry Type 3 — Breakout Continuation (STRONG_TREND only)

**Intent:** Catch trend expansions and stop missing the biggest moves.

**Conditions (M15):**

- Regime: STRONG_TREND only
- Breakout:
  - BUY: close > previous high AND close above EMA20
  - SELL: close < previous low AND close below EMA20
- Momentum sanity:
  - BUY: RSI >= 55 (or RSI slope positive)
  - SELL: RSI <= 45
- Optional: range expansion candle (range >= ATR \* 0.8)

**Tag:** `V3_BREAKOUT`

---

## 5) Position Management (Profit Engine)

### 5.1 Breakeven + Trail (mandatory)

- When price reaches **+1R**, move SL to **BE (cost-aware)**:
  - BUY: SL = entry + spread/2 (+ optional commission-in-price)
  - SELL: SL = entry - spread/2 (- optional commission-in-price)
- After BE, track peak favorable move and trail.

### 5.2 Adaptive trail (simple, effective)

- Before 1.5R: trail distance = 1.0R
- After 1.5R: trail distance = 0.75R
- After 2.5R (optional): trail distance = 0.6R

This locks more profit in runaway trends while still giving room early.

### 5.3 Partial take profit (optional but very strong)

- Close **30–50%** at **1.5R**
- Let the rest run with trailing stop  
  This dramatically improves equity curve smoothness.

---

## 6) Stop Loss & Take Profit Rules

### SL (structure + ATR guardrails)

- Use recent swing structure (M15 swings) with ATR clamps:
  - SL distance clamp: [1.0 ATR, 3.0 ATR]
- Add spread buffer (ATR \* 0.3) to avoid spread stop-outs

### TP approach (recommended)

- Use **2.0R TP as “hard cap” only for the partial** (if using partials)
- For the runner portion, let trailing stop exit.

If not using partials:

- Use TP = 2.0R in STRONG_TREND only
- Use TP = 1.5R in NORMAL_TREND

---

## 7) Risk Management (High Profitability without Blow-up)

### 7.1 Base risk

- Suggested starting risk: **1.0–1.5%** while validating
- Aggressive mode (after stable): **2.0–2.5%** (you accept 40–50% DD)

### 7.2 Pyramiding (max 2 positions) — but **shared risk budget**

**Rule:** Never double total risk.

Example:

- Base risk budget per symbol: 2.5%
- Position 1 risk: 1.7%
- Position 2 risk: 0.8% (only if Position 1 is BE and in profit)

**Add condition:** Second entry only allowed if:

- firstPosition.breakevenActivated == true
- regime still STRONG_TREND
- not after a same-day SL in that direction

### 7.3 Same-day same-direction SL limit (mandatory)

- After 1 SL in a direction today:
  - block more entries in the same direction until day changes  
    OR require “stronger conditions”:
  - ADX >= 28 and DI separation >= 12

### 7.4 Drawdown circuit breaker (mandatory)

- Daily DD stop: if day PnL <= -4% → stop trading for rest of day
- Weekly DD pause: if rolling 5-day DD <= -8% → pause 2 trading days

This prevents multi-week death spirals.

---

## 8) Execution Realism (Must match live)

- Entry filled at bid/ask (already)
- Exit triggers use correct side:
  - BUY TP/SL triggered by **BID**
  - SELL TP/SL triggered by **ASK**
- Commission applied per lot round-trip
- Same-candle ambiguity resolution:
  - Conservative: assume SL first when both touched
  - Upgrade later: M1 intrabar resolution

---

## 9) Metrics that matter (Profitability-focused)

Track these per entry type and per regime:

- Profit Factor
- Expectancy in R
- Max Drawdown %
- Max Losing Streak
- Average Winner (R) / Average Loser (R)
- % trades that reach +1R (BE activation rate)
- Distribution of exits: TP / SL / BE / Trail
- Performance by session bucket (London vs NY vs overlap)

**Objective:**

- Expectancy > +0.10R per trade
- PF > 1.3
- Max losing streak manageable under your risk (e.g., <= 8)
- DD under target (40–50% in aggressive mode)

---

## 10) Implementation Map (NestJS + Engine)

### Files

- `strategy-evaluator.ts`
  - Add regime type: RANGING / NORMAL_TREND / STRONG_TREND
  - Implement 3 entry types (EMA20 / EMA50 / Breakout)
  - Tag entries by type
- `position-simulator.ts`
  - BE activation at +1R (cost-aware)
  - Adaptive trailing
  - Partial TP (optional)
- `risk-manager.ts`
  - Shared risk budgeting for pyramids
  - Same-day direction SL limiter
  - Daily/weekly circuit breaker
- `spread-model.ts`
  - Session-aware spread
  - Skip entries when spread too high

### Config knobs (keep configurable per instrument)

- ADX thresholds (20/25)
- DI separation thresholds (6/10)
- stability bars (2/3)
- TP multipliers (1.5/2.0)
- trail distances (1.0R → 0.75R)
- session windows
- max positions and risk split

---

## 11) Backtest Protocol (to avoid overfitting)

1. Backtest **2024 full year** (low volatility)
2. Backtest **2025 full year** (trend year)
3. Backtest **Jan–Jun 2025** (stress)
4. Backtest **Jan 2026** (if you have it; volatility stress)

**Pass criteria:**

- No catastrophic streaks without circuit breaker
- Strategy still participates in 2025 uptrends (doesn’t “filter trends”)
- Trade count: ~15–40 / month on XAUUSD depending on conditions

---

## 12) What makes V3 “highly profitable”

V3 increases profitability by:

- Adding **Breakout Continuation** (captures expansions)
- Allowing **pyramiding winners** (scales in strong trend)
- Using **trailing runners** (lets winners pay for many losses)
- Preventing **loss clustering** (direction/day limits + breakers)
- Using regimes correctly (don’t treat volatile trend as “bad”)

---

## 13) Next steps checklist

- [ ] Implement regime type (NORMAL vs STRONG) + stability
- [ ] Add breakout entry
- [ ] Add EMA50 deep pullback entry
- [ ] Add BE + adaptive trailing + optional partials
- [ ] Add shared-risk pyramiding
- [ ] Add daily + weekly circuit breakers
- [ ] Run 2024/2025 backtests and compare by entry type tags
- [ ] Forward test on demo (Pepperstone/MetaAPI) for spread+slippage reality
