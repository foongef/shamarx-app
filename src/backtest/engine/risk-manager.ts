import { BacktestRiskState, EngineConfig } from './types';

const LOT_SIZE_UNITS = 100;

export class RiskManager {
  private state: BacktestRiskState;
  private config: EngineConfig;

  constructor(config: EngineConfig) {
    this.config = config;
    this.state = {
      balance: config.initialBalance,
      equity: config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      lastTradeDate: null,
    };
  }

  /**
   * Check if we can open a new trade.
   */
  canTrade(currentDate: string, openPositionCount: number): boolean {
    // Reset daily PnL if new day
    this.maybeResetDaily(currentDate);

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

    this.state.balance += pnl;
    this.state.equity = this.state.balance;
    this.state.dailyPnl += pnl;

    if (pnl < 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
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
    }
  }
}
