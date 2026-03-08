import { BacktestRiskState, EngineConfig, TradingMode } from './types';
import { getInstrumentConfig } from './instrument-config';

const WEEKLY_DD_THRESHOLD = 5; // pause if equity drops 5% from weekly peak
const WEEKLY_DD_PAUSE_DAYS = 5; // pause for 5 trading days

export class RiskManager {
  private state: BacktestRiskState;
  private config: EngineConfig;
  private readonly lotSizeUnits: number;

  // Weekly drawdown circuit breaker
  private weeklyPeakEquity: number;
  private currentWeekNumber: number = -1;
  private pauseUntilDate: string | null = null;

  // Escalating consecutive loss pause — only a WIN resets the counter
  private consecutiveLossPauseUntil: string | null = null;

  // Overall peak equity for dynamic risk scaling
  private overallPeakEquity: number;

  // V4: Trade log for rolling 7-day loss stop
  private tradeLog: { date: string; pnl: number; isLoss: boolean }[] = [];
  private equityDdPauseUntil: string | null = null;
  private lastDdTierTriggered: number = 0; // 0/15/25/35 — prevents re-triggering same tier
  private rolling7DayPauseUntil: string | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
    this.lotSizeUnits = getInstrumentConfig(config.symbol).lotSizeUnits;
    this.state = {
      balance: config.initialBalance,
      equity: config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      lastTradeDate: null,
    };
    this.weeklyPeakEquity = config.initialBalance;
    this.overallPeakEquity = config.initialBalance;
  }

  /**
   * Check if we can open a new trade.
   */
  canTrade(currentDate: string, openPositionCount: number): boolean {
    // Reset daily PnL if new day
    this.maybeResetDaily(currentDate);
    this.maybeResetWeekly(currentDate);

    const dateStr = currentDate.substring(0, 10);

    // Circuit breaker: paused after weekly drawdown
    if (this.pauseUntilDate && dateStr < this.pauseUntilDate) {
      return false;
    }

    // V4: Equity DD circuit breaker — enforce pause only (triggering moved to recordTrade)
    if (this.equityDdPauseUntil) {
      if (dateStr < this.equityDdPauseUntil) return false;
      // Pause expired — clear and allow trading (DEFENSIVE mode still active via getTradingMode)
      this.equityDdPauseUntil = null;
    }

    // V4: Rolling 7-day loss stop
    if (this.rolling7DayPauseUntil && dateStr < this.rolling7DayPauseUntil) return false;

    if (this.getRolling7DayLosses(dateStr) >= 4) {
      this.rolling7DayPauseUntil = this.addTradingDays(dateStr, 5);
      return false;
    }

    // Escalating consecutive loss pause — counter persists, only a WIN resets it
    if (this.consecutiveLossPauseUntil) {
      if (dateStr < this.consecutiveLossPauseUntil) return false;
      // Pause expired → allow exactly 1 trade attempt (counter stays)
      this.consecutiveLossPauseUntil = null;
    }

    const dailyLossPercent = (this.state.dailyPnl / this.state.balance) * 100;
    if (dailyLossPercent <= -this.config.maxDailyLossPercent) return false;

    // Escalating pause: 3 losses → 1 day, 4 → 3 days, 5+ → 5 days
    if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      const excess = this.state.consecutiveLosses - this.config.maxConsecutiveLosses;
      const pauseDays = excess >= 2 ? 5 : excess >= 1 ? 3 : 1;
      this.consecutiveLossPauseUntil = this.addTradingDays(dateStr, pauseDays);
      return false;
    }

    if (openPositionCount >= this.config.maxOpenPositions) return false;

    return true;
  }

  /**
   * Calculate lot size based on current balance and risk percent.
   */
  calculateLotSize(slPoints: number): number {
    // Dynamic risk: scale down during drawdowns
    let effectiveRisk = this.config.riskPercent;
    const ddPercent = this.overallPeakEquity > 0
      ? ((this.overallPeakEquity - this.state.equity) / this.overallPeakEquity) * 100
      : 0;

    if (ddPercent > 20) {
      effectiveRisk *= 0.3;
    } else if (ddPercent > 10) {
      effectiveRisk *= 0.5;
    }

    // V4: DEFENSIVE mode stacks with DD scaling
    if (this.getTradingMode() === 'DEFENSIVE') {
      effectiveRisk *= 0.5;
    }

    const riskAmount = this.state.balance * (effectiveRisk / 100);
    const lotSize = riskAmount / (slPoints * this.lotSizeUnits);
    // Clamp between 0.01 and 1.0
    return Math.round(Math.max(0.01, Math.min(lotSize, 1.0)) * 100) / 100;
  }

  /**
   * Record a closed trade's PnL.
   * exitReason controls consecutive loss counting:
   * - SL → increment consecutiveLosses
   * - BREAKEVEN → no change (not a real loss)
   * - TP → reset consecutiveLosses to 0
   */
  recordTrade(pnl: number, tradeDate: string, exitReason?: string): void {
    this.maybeResetDaily(tradeDate);
    this.maybeResetWeekly(tradeDate);

    this.state.balance += pnl;
    this.state.equity = this.state.balance;
    this.state.dailyPnl += pnl;

    // V4: Track trade in log for rolling 7-day loss stop
    this.tradeLog.push({
      date: tradeDate.substring(0, 10),
      pnl,
      isLoss: pnl < 0 && exitReason !== 'BREAKEVEN',
    });

    if (exitReason === 'BREAKEVEN') {
      // Breakeven — don't change consecutive losses or wins
    } else if (exitReason === 'TP') {
      this.state.consecutiveLosses = 0;
      this.state.consecutiveWins++;
    } else if (pnl < 0) {
      this.state.consecutiveLosses++;
      this.state.consecutiveWins = 0;
    }
    // else: positive PnL from trailed SL — don't reset either counter

    // Update peak equity tracking
    if (this.state.equity > this.weeklyPeakEquity) {
      this.weeklyPeakEquity = this.state.equity;
    }
    if (this.state.equity > this.overallPeakEquity) {
      this.overallPeakEquity = this.state.equity;
      // New peak — reset tier tracker so future DD can trigger fresh pauses
      this.lastDdTierTriggered = 0;
    }

    // V4: Equity DD tiered circuit breaker — event-triggered on new trade
    const ddPercent = this.getEquityDdPercent();
    const dateStrForPause = tradeDate.substring(0, 10);
    if (ddPercent >= 35 && this.lastDdTierTriggered < 35) {
      this.lastDdTierTriggered = 35;
      this.equityDdPauseUntil = this.addTradingDays(dateStrForPause, 30);
    } else if (ddPercent >= 25 && this.lastDdTierTriggered < 25) {
      this.lastDdTierTriggered = 25;
      this.equityDdPauseUntil = this.addTradingDays(dateStrForPause, 7);
    } else if (ddPercent >= 15 && this.lastDdTierTriggered < 15) {
      this.lastDdTierTriggered = 15;
      this.equityDdPauseUntil = this.addTradingDays(dateStrForPause, 3);
    }

    // Check weekly drawdown circuit breaker
    const weeklyDDPercent = ((this.weeklyPeakEquity - this.state.equity) / this.weeklyPeakEquity) * 100;
    if (weeklyDDPercent >= WEEKLY_DD_THRESHOLD) {
      // Pause for 5 trading days from today
      this.pauseUntilDate = this.addTradingDays(tradeDate.substring(0, 10), WEEKLY_DD_PAUSE_DAYS);
    }

    this.state.lastTradeDate = tradeDate;
  }

  getBalance(): number {
    return this.state.balance;
  }

  getState(): BacktestRiskState {
    return { ...this.state };
  }

  // V4: Equity drawdown percentage from overall peak
  private getEquityDdPercent(): number {
    return this.overallPeakEquity > 0
      ? ((this.overallPeakEquity - this.state.equity) / this.overallPeakEquity) * 100
      : 0;
  }

  // V4: Count losses within 7 calendar days of currentDate
  private getRolling7DayLosses(currentDate: string): number {
    const current = new Date(currentDate).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return this.tradeLog.filter(
      (t) => t.isLoss && current - new Date(t.date).getTime() <= sevenDaysMs,
    ).length;
  }

  // V4: Adaptive trading mode based on drawdown, losses, and momentum
  getTradingMode(): TradingMode {
    const ddPercent = this.getEquityDdPercent();
    const rolling7dLosses = this.getRolling7DayLosses(
      this.state.lastTradeDate?.substring(0, 10) || '',
    );

    // DEFENSIVE
    if (ddPercent >= 10) return 'DEFENSIVE';
    if (this.state.consecutiveLosses >= 2) return 'DEFENSIVE';
    if (rolling7dLosses >= 3) return 'DEFENSIVE';

    // AGGRESSIVE — equity near peak + recent wins
    if (ddPercent < 5 && this.state.consecutiveWins >= 2) return 'AGGRESSIVE';

    return 'NORMAL';
  }

  // V4: Pyramid safety gate
  canPyramid(): boolean {
    if (this.getTradingMode() === 'DEFENSIVE') return false;
    if (this.getEquityDdPercent() >= 10) return false;
    if (this.state.consecutiveLosses >= 2) return false;
    return true;
  }

  private maybeResetDaily(currentDate: string): void {
    const dateStr = currentDate.substring(0, 10); // YYYY-MM-DD
    const lastDate = this.state.lastTradeDate?.substring(0, 10);

    if (lastDate && dateStr !== lastDate) {
      this.state.dailyPnl = 0;
      // consecutiveLosses intentionally NOT reset — persists across days
      // resets only on a winning trade (in recordTrade) or after pause expires
    }
  }

  private maybeResetWeekly(currentDate: string): void {
    const weekNum = this.getISOWeek(currentDate);
    if (weekNum !== this.currentWeekNumber) {
      this.currentWeekNumber = weekNum;
      this.weeklyPeakEquity = this.state.equity;
    }
  }

  private getISOWeek(dateStr: string): number {
    const d = new Date(dateStr);
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const dayOfYear = Math.floor((d.getTime() - yearStart.getTime()) / 86400000) + 1;
    return Math.ceil(dayOfYear / 7);
  }

  /**
   * Add N calendar days (approximate trading days — skip weekends).
   */
  private addTradingDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    let added = 0;
    while (added < days) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) added++; // skip weekends
    }
    return d.toISOString().substring(0, 10);
  }
}
