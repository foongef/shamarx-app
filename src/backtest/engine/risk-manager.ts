import { BacktestRiskState, EngineConfig } from './types';

const LOT_SIZE_UNITS = 100;
const WEEKLY_DD_THRESHOLD = 5; // pause if equity drops 5% from weekly peak
const WEEKLY_DD_PAUSE_DAYS = 5; // pause for 5 trading days

export class RiskManager {
  private state: BacktestRiskState;
  private config: EngineConfig;

  // Weekly drawdown circuit breaker
  private weeklyPeakEquity: number;
  private currentWeekNumber: number = -1;
  private pauseUntilDate: string | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
    this.state = {
      balance: config.initialBalance,
      equity: config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      lastTradeDate: null,
    };
    this.weeklyPeakEquity = config.initialBalance;
  }

  /**
   * Check if we can open a new trade.
   */
  canTrade(currentDate: string, openPositionCount: number): boolean {
    // Reset daily PnL if new day
    this.maybeResetDaily(currentDate);
    this.maybeResetWeekly(currentDate);

    // Circuit breaker: paused after weekly drawdown
    if (this.pauseUntilDate && currentDate.substring(0, 10) < this.pauseUntilDate) {
      return false;
    }

    const dailyLossPercent = (this.state.dailyPnl / this.state.balance) * 100;
    if (dailyLossPercent <= -this.config.maxDailyLossPercent) return false;
    if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) return false;
    if (openPositionCount >= this.config.maxOpenPositions) return false;

    return true;
  }

  /**
   * Calculate lot size based on current balance and risk percent.
   */
  calculateLotSize(slPoints: number): number {
    const riskAmount = this.state.balance * (this.config.riskPercent / 100);
    // lot_size = risk_amount / (sl_points * 100oz)
    const lotSize = riskAmount / (slPoints * LOT_SIZE_UNITS);
    // Clamp between 0.01 and 1.0
    return Math.round(Math.max(0.01, Math.min(lotSize, 1.0)) * 100) / 100;
  }

  /**
   * Record a closed trade's PnL.
   */
  recordTrade(pnl: number, tradeDate: string): void {
    this.maybeResetDaily(tradeDate);
    this.maybeResetWeekly(tradeDate);

    this.state.balance += pnl;
    this.state.equity = this.state.balance;
    this.state.dailyPnl += pnl;

    if (pnl < 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    // Update weekly peak
    if (this.state.equity > this.weeklyPeakEquity) {
      this.weeklyPeakEquity = this.state.equity;
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
      this.state.consecutiveLosses = 0;
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
