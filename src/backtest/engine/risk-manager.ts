import { BacktestRiskState, EngineConfig } from './types';
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

  constructor(config: EngineConfig) {
    this.config = config;
    this.lotSizeUnits = getInstrumentConfig(config.symbol).lotSizeUnits;
    this.state = {
      balance: config.initialBalance,
      equity: config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
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

    if (exitReason === 'BREAKEVEN') {
      // Breakeven — don't change consecutive losses
    } else if (pnl < 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    // Update peak equity tracking
    if (this.state.equity > this.weeklyPeakEquity) {
      this.weeklyPeakEquity = this.state.equity;
    }
    if (this.state.equity > this.overallPeakEquity) {
      this.overallPeakEquity = this.state.equity;
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
