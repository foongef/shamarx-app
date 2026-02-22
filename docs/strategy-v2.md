# Trading Strategy V2 — Trend-Following EMA20 Pullback

## Overview

Strategy V2 is a **trend-following pullback system** for XAUUSD (Gold) on the M15 timeframe. It uses the H1 timeframe for trend direction and regime classification, then enters on M15 pullbacks to the 20-period EMA during confirmed trending conditions.

The core philosophy: **only trade when the market is trending, during liquid sessions, in the direction of the higher timeframe.**

### Instrument & Timeframes

| Parameter | Value |
|-----------|-------|
| Instrument | XAUUSD (Gold) |
| Entry timeframe | M15 (15-minute) |
| Trend timeframe | H1 (1-hour) |
| Lot sizing unit | 100 oz per lot |

---

## Pre-Computed Indicators

All indicators are computed over the full candle array before the walk-forward loop begins. Each array is index-aligned so `indicators[i]` corresponds to `candles[i]`. Indices before the indicator has enough warmup data are filled with `NaN`.

### M15 Indicators

| Indicator | Period | Purpose |
|-----------|--------|---------|
| EMA 20 | 20 | Pullback target / dynamic support-resistance |
| EMA 50 | 50 | (Computed but not used in V2 entry logic) |
| EMA 200 | 200 | (Computed but not used in V2 entry logic) |
| RSI 14 | 14 | Momentum filter — avoid overbought/oversold entries |
| ATR 14 | 14 | Volatility measure — used for tolerances, SL sizing, spread buffer |

### H1 Indicators

| Indicator | Period | Purpose |
|-----------|--------|---------|
| EMA 20 | 20 | Trend direction (EMA cross) |
| EMA 50 | 50 | Trend direction (EMA cross) |
| ADX 14 | 14 | Regime classification (trending vs ranging) |
| +DI 14 | 14 | Directional movement — bullish pressure |
| -DI 14 | 14 | Directional movement — bearish pressure |

---

## Entry Logic — 7 Filters in Sequence

Every M15 candle is evaluated. All 7 conditions must pass for an entry signal. The order is designed so the cheapest filters (session, regime) run first.

### Filter 1: Minimum Candle Index

```
idx >= 50
```

The first 50 candles are skipped to ensure all indicators have warmed up.

### Filter 2: Session Filter

Only trade during the two most liquid gold sessions:

| Session | UTC Hours | Rationale |
|---------|-----------|-----------|
| London | 07:00 - 10:59 | High liquidity, strong directional moves on gold |
| New York | 13:00 - 15:59 | Overlap with London, high volume |

All other hours (Asian session, off-hours) are skipped. Asian session gold is typically choppy and range-bound, producing false signals.

**Implementation:** `isActiveTradingSession()` parses the candle's `openTime` UTC hour.

### Filter 3: H1 Regime (ADX)

Uses `ADX(14)` on H1 candles to classify the current market regime:

| ADX Value | +DI vs -DI | Regime | Action |
|-----------|------------|--------|--------|
| < 20 | — | RANGING | **No trades** |
| >= 20 | +DI > -DI | BULLISH | Look for BUY setups |
| >= 20 | -DI > +DI | BEARISH | Look for SELL setups |

This is the single most important filter. It prevents all entries during consolidation/chop where directional trades get stopped out.

**Implementation:** `getH1Regime()` uses binary search to find the most recent H1 candle at or before the current M15 candle's time, then reads the H1 ADX/DI values at that index.

### Filter 4: H1 EMA Bias Confirmation

The H1 EMA cross direction must agree with the ADX regime direction:

| Condition | Bias |
|-----------|------|
| H1 EMA20 > H1 EMA50 | BULLISH |
| H1 EMA20 < H1 EMA50 | BEARISH |
| H1 EMA20 = H1 EMA50 | NEUTRAL (skip) |

**Both** the ADX regime and the EMA bias must agree. If ADX says BULLISH but EMAs say BEARISH (or NEUTRAL), the candle is skipped.

This is a relaxed version of V1's H1 bias which required price to be above/below both EMAs. V2 only requires the EMA cross direction, which responds faster at trend transitions.

### Filter 5: RSI Range

RSI must be in a "healthy momentum" zone — not overbought/oversold:

| Side | RSI Range | Rationale |
|------|-----------|-----------|
| BUY | 40 - 65 | Confirms upward momentum without being overextended |
| SELL | 35 - 60 | Confirms downward momentum without being overextended |

### Filter 6: Pullback to M15 EMA20

The M15 candle must interact with the EMA20 zone:

**Zone definition:** `EMA20 +/- ATR * 0.5`

**For BUY:**
1. Candle low must dip into the EMA20 zone: `candle.low <= EMA20 + tolerance * 0.5`
2. Candle must close above EMA20: `candle.close > EMA20`
3. Candle must be bullish: `candle.close > candle.open`

**For SELL:**
1. Candle high must rise into the EMA20 zone: `candle.high >= EMA20 - tolerance * 0.5`
2. Candle must close below EMA20: `candle.close < EMA20`
3. Candle must be bearish: `candle.close < candle.open`

This identifies candles that "test" the moving average and bounce — the classic pullback-to-EMA pattern.

### Filter 7: Confirmation Pattern

At least one of these candlestick patterns must be present:

#### Engulfing Pattern
The current candle's body completely engulfs the previous candle's body:

- **Bullish engulfing:** Previous candle bearish, current candle bullish, `curr.open <= prev.close`, `curr.close >= prev.open`
- **Bearish engulfing:** Previous candle bullish, current candle bearish, `curr.open >= prev.close`, `curr.close <= prev.open`

#### Strong Close
A candle with conviction — large body relative to range, closing near the extreme:

- Body >= 60% of total range (`|close - open| / (high - low) >= 0.6`)
- For bullish: close in the upper 25% of range (`(close - low) / range >= 0.75`)
- For bearish: close in the lower 25% of range (`(high - close) / range >= 0.75`)

---

## Entry Execution

When all 7 filters pass:

- **Entry price:** Current candle's close price
- **Side:** BUY if regime is BULLISH, SELL if BEARISH

### Setup Tags

Each trade is tagged for later analysis:

| Tag | Meaning |
|-----|---------|
| `PULLBACK_EMA20` | Always present — identifies the strategy |
| `V2` | Strategy version marker |
| `ENGULFING` | Engulfing pattern detected |
| `STRONG_CLOSE` | Strong close pattern detected |
| `ADX_BULL` | H1 ADX regime was bullish |
| `ADX_BEAR` | H1 ADX regime was bearish |

---

## Stop Loss Placement

The SL uses a **swing-based approach with ATR guardrails**.

### Calculation

1. **Find swing levels:** Detect swing highs/lows in the last 50 M15 candles using a left/right lookback of 2 candles
2. **Pick the protective swing:**
   - BUY: Take the lowest of the last 3 swing lows
   - SELL: Take the highest of the last 3 swing highs
3. **Apply minimum distance:** SL must be at least `ATR * 1.0` away from entry
   - BUY: `SL = min(swingLow, entry - ATR * 1.0) - spreadBuffer`
   - SELL: `SL = max(swingHigh, entry + ATR * 1.0) + spreadBuffer`
4. **Spread buffer:** `ATR * 0.3` added beyond the swing level to avoid getting picked off by the spread
5. **Clamp distance:** SL distance is clamped to `[ATR * 1.0, ATR * 3.0]` to avoid both too-tight and too-wide stops

If no swing points are found, falls back to `entry +/- ATR * 2.0`.

### Why These Values

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Min SL distance | ATR * 1.0 | Prevents getting stopped out by normal noise |
| Max SL distance | ATR * 3.0 | Prevents excessive risk per trade |
| Spread buffer | ATR * 0.3 | Accounts for bid/ask spread on gold |
| Swing lookback | 50 candles (~12.5 hours) | Captures meaningful structure without going too far back |

---

## Take Profit

**Fixed reward-to-risk ratio:**

```
TP = entry +/- (SL_distance * 1.5)
```

- BUY: `TP = entry + risk * 1.5`
- SELL: `TP = entry - risk * 1.5`

This gives a 1:1.5 risk-reward ratio. At a 40% win rate, this is breakeven. The filters aim for a win rate above 40% to generate positive expectancy.

---

## Position Exit

Each open position is checked against every new M15 candle:

| Condition | Exit Price | Exit Reason |
|-----------|------------|-------------|
| BUY: `candle.low <= SL` | SL price | `SL` |
| BUY: `candle.high >= TP` | TP price | `TP` |
| SELL: `candle.high >= SL` | SL price | `SL` |
| SELL: `candle.low <= TP` | TP price | `TP` |

**Same-candle resolution:** If both SL and TP could hit on the same candle, the candle's direction is used to infer which hit first:
- BUY + bullish candle = TP hit first
- BUY + bearish candle = SL hit first
- (Reversed for SELL)

**End-of-data:** Any positions still open at the last candle are force-closed at the closing price with exit reason `FORCED_CLOSE`.

---

## Cooldown System

Prevents rapid re-entry into the same market zone after a trade.

| Event | Cooldown Duration | Rationale |
|-------|-------------------|-----------|
| After any trade closes | 8 candles (2 hours) | Let the market develop new structure |
| After a stop loss | 12 candles (3 hours) | The zone has proven hostile; wait longer |
| After entry | 8 candles (2 hours) | Don't stack entries in the same move |

The SL cooldown and normal cooldown run independently. The engine skips entry evaluation until **both** cooldowns have expired.

---

## Risk Management

Risk management runs independently from the strategy logic and can veto new trades.

### Configuration Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `initialBalance` | User-specified | Starting account balance |
| `riskPercent` | User-specified | % of balance risked per trade |
| `maxDailyLossPercent` | 3.0% | Max daily loss before halting |
| `maxConsecutiveLosses` | 3 | Max losing streak before halting |
| `maxOpenPositions` | 3 | Max simultaneous positions |

### Lot Sizing

Position size is calculated from the SL distance:

```
riskAmount = balance * (riskPercent / 100)
lotSize = riskAmount / (slPoints * 100)    // 100 oz per lot for gold
lotSize = clamp(lotSize, 0.01, 1.0)        // min 0.01, max 1.0 lots
```

### Trade Gating

Before each new entry, the risk manager checks:

1. **Daily loss limit:** If `dailyPnl / balance <= -maxDailyLossPercent` → no trade
2. **Consecutive losses:** If `consecutiveLosses >= maxConsecutiveLosses` → no trade
3. **Position count:** If `openPositions >= maxOpenPositions` → no trade

Daily PnL resets at the day boundary (YYYY-MM-DD change). Consecutive losses reset on any winning trade.

---

## Engine Walk-Forward Loop

The backtest engine processes M15 candles sequentially in a single pass:

```
for each M15 candle:
    1. Check exits on all open positions
       - If SL hit → record trade, set 12-candle cooldown
       - If TP hit → record trade, set 8-candle cooldown
    2. If cooldown active → skip to next candle
    3. If risk manager vetoes → skip to next candle
    4. Evaluate setup (all 7 filters)
       - If signal found → calculate lot size, open position, set 8-candle cooldown
```

At the end of the data, any remaining open positions are force-closed.

---

## Metrics Tracked

After all trades are closed, the following metrics are calculated:

| Metric | Description |
|--------|-------------|
| Total trades | Number of completed trades |
| Win count / Loss count | Trades with positive / negative PnL |
| Win rate (%) | `winCount / totalTrades * 100` |
| Total PnL ($) | Sum of all trade PnL |
| Profit factor | `grossProfit / grossLoss` |
| Max drawdown ($) | Largest peak-to-trough equity drop |
| Max drawdown (%) | Drawdown as % of peak equity |
| Sharpe ratio | Risk-adjusted return |
| Avg win / Avg loss ($) | Average PnL for wins / losses |
| Avg R:R | Average reward-to-risk ratio |
| Largest win / Largest loss ($) | Best and worst single trade |
| Max consecutive wins/losses | Longest streak |
| Final balance ($) | Account balance after all trades |
| Return (%) | `(finalBalance - initialBalance) / initialBalance * 100` |

---

## V1 vs V2 Comparison

| Aspect | V1 (BOS Strategy) | V2 (Pullback Strategy) |
|--------|-------------------|------------------------|
| Entry trigger | Break of Structure (BOS) → deferred pullback | Direct pullback to EMA20 |
| Regime filter | None | ADX(14) >= 20 required |
| Session filter | None | London + New York only |
| H1 bias | Strict: price above/below both EMAs | Relaxed: EMA20 vs EMA50 cross only |
| Phases | 2-phase (BOS detect → pullback wait) | Single-pass evaluation |
| BOS invalidation | Checked if price closed back through level | N/A — no BOS used |
| SL minimum | ATR * 0.3 | ATR * 1.0 |
| SL maximum | ATR * 5.0 | ATR * 3.0 |
| Cooldown after SL | None (only 8-candle entry cooldown) | 12 candles (3 hours) |
| RSI range (BUY) | 50 - 70 | 40 - 65 |
| RSI range (SELL) | 30 - 50 | 35 - 60 |

### Why V1 Failed

V1's BOS-based approach had three fatal flaws during January 2025 XAUUSD data:

1. **No regime filter** — Traded during the Jan 3-9 consolidation (price ~2580, ranging) where every BOS signal was noise, not a real trend break
2. **No session filter** — Entered trades at 01:30 UTC (Asian session) where gold is illiquid and choppy
3. **H1 bias too strict** — Required price above/below both EMAs, which lags badly at trend transitions and gave stale BEARISH signals during recovery phases

---

## File Reference

| File | Responsibility |
|------|---------------|
| `src/backtest/engine/types.ts` | All type definitions (candles, positions, trades, config, metrics) |
| `src/backtest/engine/indicator-calculator.ts` | Pre-computes EMA, RSI, ATR, ADX over full candle arrays |
| `src/backtest/engine/strategy-evaluator.ts` | All entry logic: regime, session, bias, pullback, confirmation |
| `src/backtest/engine/backtest-engine.ts` | Walk-forward loop, cooldown management, ties everything together |
| `src/backtest/engine/position-simulator.ts` | SL/TP exit checks, PnL calculation, force-close |
| `src/backtest/engine/risk-manager.ts` | Lot sizing, daily loss limits, consecutive loss tracking |
| `src/backtest/engine/metrics-calculator.ts` | Post-run metric computation |
