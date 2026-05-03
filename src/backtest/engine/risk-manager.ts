import { BacktestRiskState, EngineConfig, TradingMode, DetailedRegime } from './types';
import { getInstrumentConfig } from './instrument-config';

const WEEKLY_DD_THRESHOLD = 8;
const WEEKLY_DD_PAUSE_DAYS = 5;

export class RiskManager {
  private state: BacktestRiskState;
  private config: EngineConfig;
  private readonly lotSizeUnits: number;

  // Weekly drawdown circuit breaker
  private weeklyPeakEquity: number;
  private currentWeekNumber: number = -1;
  private pauseUntilDate: string | null = null;

  // Escalating consecutive loss pause
  private consecutiveLossPauseUntil: string | null = null;
  private awaitingPostPauseTrade: boolean = false;

  // Overall peak equity for dynamic risk scaling
  private overallPeakEquity: number;

  // V4: Trade log for rolling 7-day loss stop
  private tradeLog: { date: string; pnl: number; isLoss: boolean }[] = [];
  private equityDdPauseUntil: string | null = null;
  private lastDdTierTriggered: number = 0;
  private rolling7DayPauseUntil: string | null = null;

  // 40% hard kill switch — once triggered, no more trades for the rest of the
  // backtest. Default budget = 40% from peak equity.
  private static readonly HARD_KILL_DD_PERCENT = 40;
  private hardKilled: boolean = false;

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

  canTrade(currentDate: string, openPositionCount: number): boolean {
    // Hard kill switch — once tripped, no more trades ever. Manual reset only.
    if (this.hardKilled) return false;

    this.maybeResetDaily(currentDate);
    this.maybeResetWeekly(currentDate);

    const dateStr = currentDate.substring(0, 10);

    if (this.pauseUntilDate && dateStr < this.pauseUntilDate) {
      return false;
    }

    if (this.equityDdPauseUntil) {
      if (dateStr < this.equityDdPauseUntil) return false;
      this.equityDdPauseUntil = null;
    }

    if (this.rolling7DayPauseUntil && dateStr < this.rolling7DayPauseUntil) return false;

    if (this.getRolling7DayLosses(dateStr) >= 4) {
      this.rolling7DayPauseUntil = this.addTradingDays(dateStr, 5);
      return false;
    }

    if (this.consecutiveLossPauseUntil) {
      if (dateStr < this.consecutiveLossPauseUntil) return false;
      this.consecutiveLossPauseUntil = null;
      this.awaitingPostPauseTrade = true;
    }

    const dailyLossPercent = (this.state.dailyPnl / this.state.balance) * 100;
    if (dailyLossPercent <= -this.config.maxDailyLossPercent) return false;

    if (!this.awaitingPostPauseTrade && this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      const excess = this.state.consecutiveLosses - this.config.maxConsecutiveLosses;
      const pauseDays = excess >= 2 ? 5 : excess >= 1 ? 3 : 1;
      this.consecutiveLossPauseUntil = this.addTradingDays(dateStr, pauseDays);
      return false;
    }

    if (openPositionCount >= this.config.maxOpenPositions) return false;

    return true;
  }

  /**
   * V6: Dynamic lot sizing with regime, quality, and confidence multipliers.
   *
   * effectiveRisk = baseRisk (2.0%)
   *   x regimeMultiplier    (0.6 - 1.2)
   *   x qualityMultiplier   (0.5 - 1.3)
   *   x confidenceMultiplier (0.7 - 1.2)
   *   -> clamped to [0.5%, 4.0%]
   */
  calculateLotSize(
    slPoints: number,
    qualityScore?: number,
    regime?: DetailedRegime,
    engineConfidence?: number,
  ): number {
    let effectiveRisk = this.config.riskPercent;

    // V6: Regime multiplier
    const regimeMult = this.getRegimeMultiplier(regime);
    effectiveRisk *= regimeMult;

    // V6: Quality multiplier (continuous, replaces binary gate)
    const qualityMult = this.getQualityMultiplier(qualityScore);
    effectiveRisk *= qualityMult;

    // V6: Engine confidence multiplier (from performance tracker)
    const confMult = this.getConfidenceMultiplier(engineConfidence);
    effectiveRisk *= confMult;

    // DD-adaptive risk (anti-martingale) — risk scales DOWN as we lose, UP
    // (back to normal, never above) as we recover. Smoother than the prior
    // step function. Stacks below mode/quality multipliers.
    const ddPercent = this.overallPeakEquity > 0
      ? ((this.overallPeakEquity - this.state.equity) / this.overallPeakEquity) * 100
      : 0;
    effectiveRisk *= this.getDdMultiplier(ddPercent);

    // DEFENSIVE mode stacks with DD scaling (skip if recovering)
    if (this.getTradingMode() === 'DEFENSIVE' && this.state.consecutiveWins < 3) {
      effectiveRisk *= 0.5;
    }

    // V6: Clamp effective risk to [0.5%, 4.0%]
    effectiveRisk = Math.max(0.5, Math.min(4.0, effectiveRisk));

    const riskAmount = this.state.balance * (effectiveRisk / 100);
    const idealLot = riskAmount / (slPoints * this.lotSizeUnits);

    // Lot floor + cap: minimum tradeable lot is 0.01, max 1.0.
    const lotSize = Math.round(Math.max(0.01, Math.min(1.0, idealLot)) * 100) / 100;

    // V6 (round 4): honest risk cap — actual risk must not exceed effective
    // risk by more than 10%. Without this, a $100 account forced to trade
    // 0.01 lot on a 5-point SL ends up risking 5% instead of the intended 1.5%.
    const actualRiskAmount = lotSize * slPoints * this.lotSizeUnits;
    const actualRiskPct = (actualRiskAmount / this.state.balance) * 100;
    if (actualRiskPct > effectiveRisk * 1.10) {
      return 0; // skip the trade — lot floor would over-risk this account
    }

    return lotSize;
  }

  /**
   * Regime risk multiplier: STRONG_TREND most aggressive, VOLATILE most conservative.
   */
  private getRegimeMultiplier(regime?: DetailedRegime): number {
    if (!regime) return 1.0;
    switch (regime) {
      case 'STRONG_TREND': return 1.2;
      case 'WEAK_TREND': return 0.9;
      case 'RANGING': return 0.7;
      case 'VOLATILE': return 0.6;
      case 'TRANSITIONING': return 0.8;
    }
  }

  /**
   * Quality risk multiplier: high-Q setups get amplified, low-Q get dampened.
   */
  private getQualityMultiplier(quality?: number): number {
    if (quality === undefined) return 1.0;
    if (quality >= 75) return 1.3;
    if (quality >= 65) return 1.15;
    if (quality >= 55) return 1.0;
    if (quality >= 45) return 0.85;
    if (quality >= 35) return 0.7;
    return 0.5;
  }

  /**
   * Anti-martingale DD scaling. Returns 1.0 when healthy, drops sharply
   * once distress is real. Tuned (iter2b) to preserve performance during
   * normal noise (DD < 10%) and only kick in when actually wounded.
   *   DD 0-10%  → 1.00  (full risk — normal noise, no penalty)
   *   DD 10-20% → 0.50  (cooling off)
   *   DD 20-30% → 0.25  (recovery mode)
   *   DD 30-40% → 0.10  (survival mode)
   *   DD ≥ 40%  → hard kill switch trips elsewhere; this never fires
   */
  private getDdMultiplier(ddPercent: number): number {
    if (ddPercent < 10) return 1.0;
    if (ddPercent < 20) return 0.5;
    if (ddPercent < 30) return 0.25;
    return 0.10;
  }

  /**
   * Engine confidence multiplier from performance tracker.
   */
  private getConfidenceMultiplier(confidence?: number): number {
    if (confidence === undefined) return 1.0;
    if (confidence >= 70) return 1.2;
    if (confidence >= 60) return 1.1;
    if (confidence >= 50) return 1.0;
    if (confidence >= 40) return 0.9;
    if (confidence >= 30) return 0.8;
    return 0.7;
  }

  recordTrade(pnl: number, tradeDate: string, exitReason?: string): void {
    this.maybeResetDaily(tradeDate);
    this.maybeResetWeekly(tradeDate);

    this.awaitingPostPauseTrade = false;

    this.state.balance += pnl;
    this.state.equity = this.state.balance;
    this.state.dailyPnl += pnl;

    this.tradeLog.push({
      date: tradeDate.substring(0, 10),
      pnl,
      isLoss: pnl < 0 && exitReason !== 'BREAKEVEN',
    });

    if (exitReason === 'BREAKEVEN') {
      this.state.consecutiveLosses = 0;
    } else if (exitReason === 'TP') {
      this.state.consecutiveLosses = 0;
      this.state.consecutiveWins++;
    } else if (pnl < 0) {
      this.state.consecutiveLosses++;
      this.state.consecutiveWins = 0;
    }

    if (this.state.equity > this.weeklyPeakEquity) {
      this.weeklyPeakEquity = this.state.equity;
    }
    if (this.state.equity > this.overallPeakEquity) {
      this.overallPeakEquity = this.state.equity;
      this.lastDdTierTriggered = 0;
    }

    const ddPercent = this.getEquityDdPercent();
    const dateStrForPause = tradeDate.substring(0, 10);

    // Hard kill switch at 40% DD — trips once, never resets. Most aggressive
    // safety net; protects from black-swan scenarios where the tiered pauses
    // aren't enough.
    if (ddPercent >= RiskManager.HARD_KILL_DD_PERCENT) {
      this.hardKilled = true;
    }

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

    const weeklyDDPercent = ((this.weeklyPeakEquity - this.state.equity) / this.weeklyPeakEquity) * 100;
    if (weeklyDDPercent >= WEEKLY_DD_THRESHOLD) {
      this.pauseUntilDate = this.addTradingDays(tradeDate.substring(0, 10), WEEKLY_DD_PAUSE_DAYS);
    }

    this.state.lastTradeDate = tradeDate;
  }

  getBalance(): number {
    return this.state.balance;
  }

  /** True iff the 40% hard-kill switch has tripped. */
  isHardKilled(): boolean {
    return this.hardKilled;
  }

  getState(): BacktestRiskState {
    return { ...this.state };
  }

  private getEquityDdPercent(): number {
    return this.overallPeakEquity > 0
      ? ((this.overallPeakEquity - this.state.equity) / this.overallPeakEquity) * 100
      : 0;
  }

  private getRolling7DayLosses(currentDate: string): number {
    const current = new Date(currentDate).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return this.tradeLog.filter(
      (t) => t.isLoss && current - new Date(t.date).getTime() <= sevenDaysMs,
    ).length;
  }

  getTradingMode(): TradingMode {
    const ddPercent = this.getEquityDdPercent();
    const rolling7dLosses = this.getRolling7DayLosses(
      this.state.lastTradeDate?.substring(0, 10) || '',
    );

    if (ddPercent >= 15) return 'DEFENSIVE';
    if (this.state.consecutiveLosses >= 4) return 'DEFENSIVE';
    if (rolling7dLosses >= 5) return 'DEFENSIVE';

    if (ddPercent < 5 && this.state.consecutiveWins >= 2) return 'AGGRESSIVE';

    return 'NORMAL';
  }

  canPyramid(): boolean {
    if (this.getTradingMode() === 'DEFENSIVE') return false;
    if (this.getEquityDdPercent() >= 10) return false;
    if (this.state.consecutiveLosses >= 2) return false;
    return true;
  }

  private maybeResetDaily(currentDate: string): void {
    const dateStr = currentDate.substring(0, 10);
    const lastDate = this.state.lastTradeDate?.substring(0, 10);

    if (lastDate && dateStr !== lastDate) {
      this.state.dailyPnl = 0;
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

  private addTradingDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    let added = 0;
    while (added < days) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) added++;
    }
    return d.toISOString().substring(0, 10);
  }
}
