# Trading Strategy V2.1 — Realism + Quality Improvements

## Overview

Strategy V2.1 builds on V2's trend-following pullback system with **backtest realism improvements** and **strategy quality upgrades**. The core setup is identical (EMA20 pullback with ADX regime + session filter), but V2.1 closes the gap between backtest and live performance by modeling spreads, commissions, and conservative fill assumptions.

### What Changed from V2

| Area | V2 | V2.1 |
|------|----|----|
| Entry fill | `candle.close` | Spread-adjusted (BUY at ask, SELL at bid) |
| SL/TP checks | Raw candle high/low | Bid/ask adjusted high/low |
| Same-candle SL+TP | Candle direction heuristic (optimistic) | Always SL (conservative) |
| Commission | Not modeled | $7/lot round-trip deducted from PnL |
| ADX filter | `ADX >= 20` | `ADX >= 20` + DI separation >= 5 |
| Session filter | Fixed UTC hours | DST-safe (timezone-aware) |
| Take profit | 1.5R | 1.5R (kept — 2.0R tested but reverted) |
| Risk management | Daily limits only | Daily limits + weekly drawdown circuit breaker |

### Instrument & Timeframes

| Parameter | Value |
|-----------|-------|
| Instrument | XAUUSD (Gold) |
| Entry timeframe | M15 (15-minute) |
| Trend timeframe | H1 (1-hour) |
| Lot sizing unit | 100 oz per lot |

---

## Spread Modeling

V2.1 applies a bid/ask spread that varies by time of day, reflecting real gold market conditions.

### Spread Table

| Session | UTC Hours | Spread (pts) |
|---------|-----------|-------------|
| London | 07:00 - 10:59 | 0.25 |
| New York | 13:00 - 15:59 | 0.25 |
| Asian | 22:00 - 06:59 | 0.50 |
| Off-hours | 11:00 - 12:59, 16:00 - 21:59 | 0.40 |

### Where Spread is Applied

**Entry price adjustment:**
- BUY: `entry = candle.close + spread / 2` (filled at ask)
- SELL: `entry = candle.close - spread / 2` (filled at bid)

**SL/TP exit checks** — the position simulator adjusts candle prices to reflect bid/ask:

| Side | Check | Formula | Rationale |
|------|-------|---------|-----------|
| BUY SL | Bid touches SL | `candle.low - spread/2 <= slPrice` | Longs exit at bid |
| BUY TP | Bid touches TP | `candle.high - spread/2 >= tpPrice` | Longs exit at bid |
| SELL SL | Ask touches SL | `candle.high + spread/2 >= slPrice` | Shorts exit at ask |
| SELL TP | Ask touches TP | `candle.low + spread/2 <= tpPrice` | Shorts exit at ask |

**Implementation:** `getSpread()` in `spread-model.ts` returns the spread for a given candle timestamp using UTC hour lookup. The spread is passed per-candle to both the evaluator (entry adjustment) and the position simulator (exit checks).

---

## Commission Modeling

Each trade incurs a round-trip commission based on position size.

### Calculation

```
commission = lotSize * 7.0   // $7 per lot round-trip (Pepperstone Raw typical)
```

Commission is deducted from raw PnL at trade close time:

```
pnl = (priceDiff * direction * lotSize * 100) - commission
```

### Tracking

- Each `ClosedTrade` stores its `commission` value
- `BacktestMetrics` includes `totalCommission` — the sum of all trade commissions
- The frontend trade table shows a "Comm." column per trade
- The frontend metrics grid shows a "Total Commission" card

---

## Entry Logic — 8 Filters in Sequence

V2.1 strengthens Filter 3 (ADX) and improves session filtering. All 7 conditions must pass. The order runs cheapest filters first.

### Filter 1: Minimum Candle Index

```
idx >= 50
```

Unchanged from V2. Ensures indicator warmup.

### Filter 2: Session Filter (DST-Safe)

Only trade during London and New York sessions, with **timezone-aware hour extraction** that automatically handles DST transitions.

| Session | Timezone | Local Hours | UTC (Winter) | UTC (Summer) |
|---------|----------|-------------|-------------|-------------|
| London | Europe/London | 08:00 - 11:59 | 08:00 - 11:59 | 07:00 - 10:59 |
| New York | America/New_York | 08:00 - 10:59 | 13:00 - 15:59 | 12:00 - 14:59 |

**Implementation:** Uses `Intl.DateTimeFormat` with `timeZone` option to extract the local hour for any UTC timestamp. No external dependency required.

```ts
function getLocalHour(utcTime: string, tz: string): number {
  const d = new Date(utcTime);
  return parseInt(
    new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: tz }).format(d),
  );
}
```

**V2 vs V2.1:** V2 used fixed UTC ranges (07-10, 13-15) which drifted by 1 hour during summer time. V2.1 checks the actual local time in London and New York, so sessions are always correct regardless of DST.

### Filter 3: H1 Regime (Strengthened ADX)

Uses `ADX(14)` on H1 with one additional sub-condition:

| Condition | Threshold | Purpose |
|-----------|-----------|---------|
| ADX value | >= 20 | Market is trending (unchanged) |
| DI separation | `\|+DI - -DI\| >= 5` | Clear directional dominance |

If any condition fails, the regime is classified as `RANGING` and the candle is skipped.

**Note:** ADX rising (`ADX[i] > ADX[i-1]`) was tested but removed — it filtered out too many valid signals, reducing trade count to ~7 in 3 months. DI separation alone provides sufficient quality filtering.

**Why DI separation:** Prevents entries when +DI and -DI are nearly equal (e.g., +DI=18, -DI=16 with ADX=22 is ambiguous direction)

### Filter 4: H1 EMA Bias Confirmation

Unchanged from V2. The H1 EMA20/EMA50 cross direction must agree with the ADX regime direction.

### Filter 5: RSI Range

Unchanged from V2.

| Side | RSI Range |
|------|-----------|
| BUY | 40 - 65 |
| SELL | 35 - 60 |

### Filter 6: Pullback to M15 EMA20

Unchanged from V2. Candle must interact with EMA20 zone (`EMA20 +/- ATR * 0.5`), dip into the zone, and close in the trade direction.

### Filter 7: Confirmation Pattern

Unchanged from V2. Requires engulfing or strong close.

### ~~Filter 8: SR Feasibility Check~~ (Removed)

SR feasibility was originally planned but removed after testing. M15 swing points are inherently close to pullback entries (by definition, a pullback retraces toward prior structure), so the check vetoed nearly all valid signals.

**TODO:** Revisit with H1/H4 major S/R levels instead of M15 micro-swings.

---

## Entry Execution

When all 8 filters pass:

- **Entry price:** Spread-adjusted close (`candle.close +/- spread/2`)
- **Side:** BUY if regime is BULLISH, SELL if BEARISH

### Setup Tags

| Tag | Meaning |
|-----|---------|
| `PULLBACK_EMA20` | Always present — identifies the strategy |
| `V2.1` | Strategy version marker |
| `ENGULFING` | Engulfing pattern detected |
| `STRONG_CLOSE` | Strong close pattern detected |
| `ADX_BULL` | H1 ADX regime was bullish |
| `ADX_BEAR` | H1 ADX regime was bearish |

---

## Stop Loss Placement

Unchanged from V2. Swing-based with ATR guardrails.

1. Detect swing highs/lows in last 50 M15 candles (lookback = 2)
2. BUY: `SL = min(lowest 3 swing lows, entry - ATR * 1.0) - ATR * 0.3`
3. SELL: `SL = max(highest 3 swing highs, entry + ATR * 1.0) + ATR * 0.3`
4. Clamp SL distance to `[ATR * 1.0, ATR * 3.0]`

Fallback if no swings found: `entry +/- ATR * 2.0`.

---

## Take Profit

**Kept at 1.5R** (same as V2).

```
TP = entry +/- (SL_distance * 1.5)
```

- BUY: `TP = entry + risk * 1.5`
- SELL: `TP = entry - risk * 1.5`

**Why 1.5R (not 2.0R):** 2.0R was tested but reverted. At 2.0R, the win rate dropped to ~28% — below the 34% breakeven threshold. At 1.5R, the strategy achieves ~54% win rate, giving positive expectancy:

```
E = 0.54 * 1.5 - 0.46 * 1.0 = 0.81 - 0.46 = +0.35R per trade
```

1.5R is more achievable for EMA20 pullback entries on gold, where the typical move after confirmation is 1.5-2.0R before encountering resistance.

---

## Position Exit

### Conservative Same-Candle Resolution

**V2:** Used candle direction to guess which hit first (optimistic — BUY + bullish candle = TP).

**V2.1:** When both SL and TP are hit on the same candle, **always assume SL hits first**.

| Scenario | V2 Result | V2.1 Result |
|----------|-----------|-------------|
| BUY, bullish candle, both hit | TP | **SL** |
| BUY, bearish candle, both hit | SL | **SL** |
| SELL, bearish candle, both hit | TP | **SL** |
| SELL, bullish candle, both hit | SL | **SL** |

**Why:** On M15 candles, we cannot know the intra-candle price path. The conservative assumption prevents the backtest from inflating win rates on ambiguous candles. If the strategy is profitable with this assumption, it will be at least as good in live trading.

### Exit Checks (Spread-Adjusted)

| Side | Condition | Exit Price | Exit Reason |
|------|-----------|------------|-------------|
| BUY | `candle.low - spread/2 <= SL` | SL price | `SL` |
| BUY | `candle.high - spread/2 >= TP` | TP price | `TP` |
| SELL | `candle.high + spread/2 >= SL` | SL price | `SL` |
| SELL | `candle.low + spread/2 <= TP` | TP price | `TP` |

**End-of-data:** Remaining positions are force-closed at the last candle's close. Commission is still deducted.

---

## Cooldown System

Unchanged from V2.

| Event | Cooldown Duration | Rationale |
|-------|-------------------|-----------|
| After any trade closes | 8 candles (2 hours) | Let the market develop new structure |
| After a stop loss | 12 candles (3 hours) | The zone has proven hostile; wait longer |
| After entry | 8 candles (2 hours) | Don't stack entries in the same move |

---

## Risk Management

V2.1 adds a **weekly drawdown circuit breaker** and fixes a consecutive-loss reset bug from V2.

### Configuration Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `initialBalance` | User-specified | Starting account balance |
| `riskPercent` | User-specified | % of balance risked per trade |
| `maxDailyLossPercent` | 3.0% | Max daily loss before halting |
| `maxConsecutiveLosses` | 3 | Max losing streak before halting (resets daily) |
| `maxOpenPositions` | 3 | Max simultaneous positions |

### Lot Sizing

```
riskAmount = balance * (riskPercent / 100)
lotSize = riskAmount / (slPoints * 100)    // 100 oz per lot for gold
lotSize = clamp(lotSize, 0.01, 1.0)
```

### Weekly Drawdown Circuit Breaker (New in V2.1)

Prevents extended losing streaks from causing catastrophic drawdowns.

| Parameter | Value |
|-----------|-------|
| Weekly DD threshold | 5% from weekly peak equity |
| Pause duration | 5 trading days (skips weekends) |

**How it works:**
1. At the start of each ISO week, `weeklyPeakEquity` is set to the current equity
2. After every trade, if equity exceeds `weeklyPeakEquity`, the peak is updated
3. If equity drops 5% or more from the weekly peak, trading is paused for 5 trading days
4. The pause is enforced by `canTrade()` checking `currentDate < pauseUntilDate`
5. After the pause expires, trading resumes normally

**Why this matters:** In testing, a 15-trade losing streak over May-June 2025 caused a 74% max drawdown. The circuit breaker would have detected the 5% weekly drop after the first 3-4 losses and paused trading, limiting drawdown to ~15-20%.

### Daily Resets

- `dailyPnl` resets to 0 at the start of each new trading day
- `consecutiveLosses` resets to 0 at the start of each new trading day

**Note:** In V2, `consecutiveLosses` was never reset, which caused a permanent lockout after 3 consecutive losses (since no new trades could be taken to reset the counter). V2.1 fixes this by resetting on daily boundaries.

---

## Engine Walk-Forward Loop

```
for each M15 candle:
    spread = getSpread(candle.openTime)

    1. Check exits on all open positions
       - commission = position.lotSize * 7.0
       - Check SL/TP with spread-adjusted bid/ask prices
       - If both hit → SL wins (conservative)
       - If SL hit → record trade (PnL minus commission), set 12-candle cooldown
       - If TP hit → record trade (PnL minus commission), set 8-candle cooldown

    2. If cooldown active → skip to next candle

    3. If risk manager vetoes → skip to next candle

    4. Evaluate setup (all 8 filters, with spread for entry adjustment)
       - If signal found → calculate lot size, open position, set 8-candle cooldown
```

At the end of the data, remaining open positions are force-closed with commission deducted.

---

## Metrics Tracked

All V2 metrics plus commission tracking:

| Metric | Description |
|--------|-------------|
| Total trades | Number of completed trades |
| Win count / Loss count | Trades with positive / negative PnL |
| Win rate (%) | `winCount / totalTrades * 100` |
| Total PnL ($) | Sum of all trade PnL (after commission) |
| **Total Commission ($)** | Sum of all trade commissions **(new)** |
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

## V2 vs V2.1 Comparison

| Aspect | V2 | V2.1 |
|--------|----|----|
| Entry price | `candle.close` | `candle.close +/- spread/2` |
| SL/TP exit checks | Raw candle OHLC | Bid/ask adjusted OHLC |
| Same-candle SL+TP | Candle direction heuristic | Always SL (conservative) |
| Commission | Not modeled | `lotSize * $7` deducted from PnL |
| ADX filter | ADX >= 20 | ADX >= 20 + DI separation >= 5 |
| Session filter | Fixed UTC hours | DST-safe via `Intl.DateTimeFormat` |
| Take profit | 1.5R | 1.5R (unchanged) |
| Consecutive losses | Never resets (bug) | Resets daily |
| Weekly drawdown | None | 5% DD from weekly peak → 5-day pause |
| Version tag | `V2` | `V2.1` |

### Why These Changes

1. **Spread + Commission** — V2 backtests showed inflated PnL because they ignored trading costs. With gold spread at 0.25-0.50 pts and $7/lot commission, each trade costs $25-50 for a 1-lot position. Over 50 trades, that's $1,250-$2,500 — enough to turn a profitable backtest unprofitable live.

2. **Conservative same-candle resolution** — V2's heuristic gave ~50% of ambiguous candles to TP. In reality, we don't know the intra-candle path on M15 bars. Assuming SL provides a lower bound on performance.

3. **DI separation on ADX** — V2 would enter when +DI and -DI were nearly equal (ambiguous direction). DI separation >= 5 ensures clear directional dominance. (ADX rising was tested but removed — too restrictive.)

4. **DST-safe sessions** — V2's fixed UTC hours shifted by 1 hour during summer time, accidentally including/excluding the wrong hours. Timezone-aware logic is always correct.

5. **Weekly drawdown circuit breaker** — V2 had no protection against extended losing streaks. A 15-loss streak in testing caused 74% drawdown. The circuit breaker pauses trading after a 5% weekly equity drop, limiting cascading losses.

6. **Daily consecutive loss reset** — V2 never reset the consecutive loss counter, causing permanent lockout after 3 losses. V2.1 resets on daily boundaries.

### Changes Tested and Reverted

| Change | Why Reverted |
|--------|-------------|
| **2.0R TP** | Win rate dropped to ~28% (below 34% breakeven). 1.5R achieves 54% win rate. |
| **ADX rising** | Filtered too aggressively — only 7 trades in 3 months. |
| **SR feasibility** | M15 swing points are inherently close to pullback entries, vetoing nearly all signals. Needs H1/H4 S/R instead. |

---

## File Reference

| File | Responsibility |
|------|---------------|
| `src/backtest/engine/spread-model.ts` | Time-of-day spread lookup **(new)** |
| `src/backtest/engine/types.ts` | Type definitions (added `commission`, `totalCommission`) |
| `src/backtest/engine/indicator-calculator.ts` | Pre-computes indicators (unchanged) |
| `src/backtest/engine/strategy-evaluator.ts` | Entry logic: DST sessions, DI separation, spread-adjusted entry, 1.5R TP |
| `src/backtest/engine/backtest-engine.ts` | Walk-forward loop, spread + commission plumbing |
| `src/backtest/engine/position-simulator.ts` | Spread-adjusted exits, commission in PnL, conservative same-candle |
| `src/backtest/engine/risk-manager.ts` | Lot sizing, daily loss limits, weekly drawdown circuit breaker |
| `src/backtest/engine/metrics-calculator.ts` | Metrics including `totalCommission` |
| `libs/prisma/schema.prisma` | `commission` column on `BacktestTrade` |
| `src/backtest/backtest.service.ts` | Maps `commission` to/from DB |
| `src/backtest/dto/backtest-result.dto.ts` | `commission` on trade DTO, `totalCommission` on metrics DTO |
| `apps/web/src/lib/types.ts` | Frontend types with commission fields |
| `apps/web/src/components/backtest/trade-table.tsx` | "Comm." column |
| `apps/web/src/components/backtest/metrics-grid.tsx` | "Total Commission" card |
