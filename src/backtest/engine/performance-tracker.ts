import { ClosedTrade, EngineType } from './types';

interface TrackedTrade {
  engineType: EngineType;
  rMultiple: number;
  won: boolean;
  pnl: number;
  weekKey: string; // YYYY-WNN
}

export interface EngineStats {
  winRate: number;        // 0-100
  avgR: number;
  expectancy: number;     // avgWin * winRate - avgLoss * lossRate
  hotStreak: number;      // consecutive wins at tail
  profitFactor: number;   // gross wins / gross losses
  tradeCount: number;
}

const ENGINE_WINDOW_SIZE = 30;
const GLOBAL_WINDOW_SIZE = 60;
const MIN_TRADES_FOR_CONFIDENCE = 10;

export class PerformanceTracker {
  private engineWindows: Record<EngineType, TrackedTrade[]> = {
    TREND_PULLBACK: [],
    FVG_FILL: [],
    RANGE_ENGINE: [],
    BB_REVERSAL: [],
    SMC: [],
  };
  private globalWindow: TrackedTrade[] = [];
  private weeklyTradeCounts: Map<string, number> = new Map();

  /**
   * Record a closed trade for rolling statistics.
   */
  recordTrade(trade: ClosedTrade): void {
    const engineType = this.deriveEngineType(trade);
    const rMultiple = trade.rMultiple ?? 0;
    const won = trade.pnl > 0 && trade.exitReason !== 'BREAKEVEN';
    const weekKey = this.getISOWeekKey(trade.exitTime);

    const tracked: TrackedTrade = {
      engineType,
      rMultiple,
      won,
      pnl: trade.pnl,
      weekKey,
    };

    // Add to engine-specific window
    const engineWindow = this.engineWindows[engineType];
    engineWindow.push(tracked);
    if (engineWindow.length > ENGINE_WINDOW_SIZE) {
      engineWindow.shift();
    }

    // Add to global window
    this.globalWindow.push(tracked);
    if (this.globalWindow.length > GLOBAL_WINDOW_SIZE) {
      this.globalWindow.shift();
    }

    // Update weekly count
    const count = this.weeklyTradeCounts.get(weekKey) ?? 0;
    this.weeklyTradeCounts.set(weekKey, count + 1);
  }

  /**
   * Get rolling stats for a specific engine.
   */
  getEngineStats(engineType: EngineType): EngineStats {
    return this.computeStats(this.engineWindows[engineType]);
  }

  /**
   * Get rolling stats across all engines.
   */
  getGlobalStats(): EngineStats {
    return this.computeStats(this.globalWindow);
  }

  /**
   * Engine confidence score 0-100, derived from rolling win rate + expectancy.
   * Returns 50 (neutral) when insufficient data.
   */
  getEngineConfidence(engineType: EngineType): number {
    const stats = this.getEngineStats(engineType);
    if (stats.tradeCount < MIN_TRADES_FOR_CONFIDENCE) return 50;

    // Win rate component: 0-50 points (50% WR = 25 pts, 70% = 35 pts)
    const wrScore = Math.min(50, stats.winRate * 0.5);

    // Expectancy component: 0-30 points (0.5R expectancy = 15 pts, 1.0R = 30 pts)
    const expScore = Math.min(30, Math.max(0, stats.expectancy * 30));

    // Hot streak bonus: 0-20 points (3 wins = 10, 5+ = 20)
    const streakScore = Math.min(20, stats.hotStreak * 4);

    return Math.round(Math.min(100, Math.max(0, wrScore + expScore + streakScore)));
  }

  /**
   * Get global confidence across all engines.
   */
  getGlobalConfidence(): number {
    const stats = this.getGlobalStats();
    if (stats.tradeCount < MIN_TRADES_FOR_CONFIDENCE) return 50;

    const wrScore = Math.min(50, stats.winRate * 0.5);
    const expScore = Math.min(30, Math.max(0, stats.expectancy * 30));
    const streakScore = Math.min(20, stats.hotStreak * 4);

    return Math.round(Math.min(100, Math.max(0, wrScore + expScore + streakScore)));
  }

  /**
   * Get the trade deficit for the current week.
   * Returns how many trades short of the 3/week minimum.
   * Positive = deficit, 0 = met or exceeded.
   */
  getWeeklyTradeDeficit(currentTime: string): number {
    const weekKey = this.getISOWeekKey(currentTime);
    const count = this.weeklyTradeCounts.get(weekKey) ?? 0;
    return Math.max(0, 3 - count);
  }

  /**
   * Get total trades this week.
   */
  getWeeklyTradeCount(currentTime: string): number {
    const weekKey = this.getISOWeekKey(currentTime);
    return this.weeklyTradeCounts.get(weekKey) ?? 0;
  }

  private computeStats(trades: TrackedTrade[]): EngineStats {
    if (trades.length === 0) {
      return { winRate: 0, avgR: 0, expectancy: 0, hotStreak: 0, profitFactor: 0, tradeCount: 0 };
    }

    const wins = trades.filter(t => t.won);
    const losses = trades.filter(t => !t.won);
    const winRate = (wins.length / trades.length) * 100;

    const avgR = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;

    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

    const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length : 0;
    const avgLossR = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length) : 0;
    const expectancy = (avgWinR * wins.length - avgLossR * losses.length) / trades.length;

    // Hot streak: consecutive wins at the tail
    let hotStreak = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].won) hotStreak++;
      else break;
    }

    return { winRate, avgR, expectancy, hotStreak, profitFactor, tradeCount: trades.length };
  }

  private deriveEngineType(trade: ClosedTrade): EngineType {
    if (trade.engineType) return trade.engineType;
    if (trade.setupTags.includes('RANGE_ENGINE')) return 'RANGE_ENGINE';
    if (trade.setupTags.includes('FVG_FILL')) return 'FVG_FILL';
    return 'TREND_PULLBACK';
  }

  private getISOWeekKey(dateStr: string): string {
    const d = new Date(dateStr);
    // ISO week: week containing Thursday determines the year
    const thursday = new Date(d);
    thursday.setDate(d.getDate() + (4 - (d.getDay() || 7)));
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${thursday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }
}
