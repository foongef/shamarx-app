# V3.5 — Profit Booster Layer (High-Return System, 100%+ Target)

## Objective
Transform an already profitable trend-following core into a high-return, multi-regime trading system.

Target:
- Annual return: 80% – 150%
- Max Drawdown: < 40–50%
- Profit Factor: > 1.3

---

## Core Philosophy
- Trade only when edge exists
- Let winners run large
- Cut losing streaks early

---

## System Architecture

Market Regime Detector -> Strategy Router -> Trend/Range Engine -> Profit Booster -> Risk Engine -> Execution

---

## Market Regime Detector (H1)

### STRONG_TREND
- ADX >= 25
- DI separation >= 10
- ADX rising
- EMA20 aligned with EMA50

### NORMAL_TREND
- ADX 20–25
- DI separation >= 6

### RANGE
- ADX < 20

### TRANSITION
- No trade

---

## Strategy Router
- STRONG_TREND → Full Trend Engine
- NORMAL_TREND → Light Trend Engine
- RANGE → Range Engine
- TRANSITION → No trade

---

## Trend Engine

### EMA20 Pullback
- Price touches EMA20 ± ATR * 0.6
- Trend aligned

### EMA50 Pullback
- ADX >= 25
- Deeper pullback for better RR

### Breakout Continuation
- Close above recent high
- Strong candle
- RSI >= 55

---

## Pyramiding
- Only after BE activated
- Only in STRONG_TREND
- Max total risk per symbol: 2.5%

---

## Hybrid Exit

### Position A (50%)
- TP = 1.5R

### Position B (50%)
- No TP
- Trailing:

+1R → BE  
+1.5R → trail 1R  
+2R → trail 0.75R  
+3R → trail 0.5R  

---

## Range Engine
- RSI extremes (35/65)
- Mean reversion to EMA20
- Disabled if ADX >= 25

---

## Risk Engine

### Escalating Pause
- 3 losses → 1 day
- 4 losses → 3 days
- 5 losses → 5 days

### Reset Rule
- Only TP resets losses

### Same Direction Lock
- 1 SL per direction per day

### Daily Stop
- -4% stop

### Weekly Stop
- -8% pause

---

## Portfolio
- XAUUSD
- NAS100
- US30
- GBPJPY

Max risk:
- 5% total
- 2.5% per symbol

---

## Metrics
- Profit Factor
- Win Rate (PnL > 0)
- Max DD
- Expectancy

---

## Backtest Protocol
- 2024 → survive
- 2025 → profit
- 2026 → adaptive

---

## Expected Outcome
- 80% – 150% yearly return
- Controlled drawdown
- Stability across regimes

---

## Final Principle

Profit = Big Winners - Controlled Losses
