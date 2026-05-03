import { Logger } from '@nestjs/common';
import {
  BacktestCandle,
  ClosedTrade,
  SimulatedPosition,
  EngineConfig,
  BacktestMetrics,
  EngineState,
  RegimeState,
  EngineType,
  D1Bias,
} from './types';
import { computeIndicators } from './indicator-calculator';
import {
  evaluateSetup,
  evaluateRangeSetup,
  evaluateFVGEntry,
  calculateQualityScore,
  updateSwingTracker,
  detectBOSEvents,
  detectFVGs,
  detectRegime,
  getRegimeParams,
  getD1Bias,
} from './strategy-evaluator';
import { checkPositionExit, forceClosePosition, updatePositionManagement } from './position-simulator';
import { RiskManager } from './risk-manager';
import { PerformanceTracker } from './performance-tracker';
import { calculateMetrics } from './metrics-calculator';
import { getSpread } from './spread-model';
import { getInstrumentConfig } from './instrument-config';
import { getPairProfile } from './pair-profile';
import { isInBlackout } from './news-calendar';
import { evaluateBBReversal } from './bb-reversal-evaluator';
import { evaluateEmaCross } from './ema-cross-evaluator';
import { evaluateMomentumContinuation } from './momentum-continuation-evaluator';

export interface BacktestResult {
  trades: ClosedTrade[];
  metrics: BacktestMetrics;
}

export class BacktestEngine {
  private readonly logger = new Logger(BacktestEngine.name);

  run(
    m15Candles: BacktestCandle[],
    h1Candles: BacktestCandle[],
    config: EngineConfig,
    htf: { h4Candles?: BacktestCandle[]; d1Candles?: BacktestCandle[] } = {},
  ): BacktestResult {
    const instrumentConfig = getInstrumentConfig(config.symbol);
    const { commissionPerLot, minAtr, lotSizeUnits, pricePrecision } = instrumentConfig;
    const strategyVersion = config.strategyVersion ?? 'V5.5b';
    const pairProfile = getPairProfile(config.symbol);
    const h4Candles = htf.h4Candles ?? [];
    const d1Candles = htf.d1Candles ?? [];
    const d1Indicators = d1Candles.length > 0 ? computeIndicators(d1Candles) : null;

    this.logger.log(
      `Starting [${strategyVersion}] backtest [${config.symbol}]: ${m15Candles.length} M15, ${h1Candles.length} H1, ${h4Candles.length} H4, ${d1Candles.length} D1 candles`,
    );

    // V6-alt: Route to greenfield SMC engine. Returns same result shape.
    if (strategyVersion === 'V6-alt') {
      // Lazy-loaded to keep V6 working even if SMC module is absent.
      const { runSmcBacktest } = require('./smc');
      return runSmcBacktest(m15Candles, h1Candles, h4Candles, d1Candles, config);
    }

    // Pre-compute indicators
    const m15Indicators = computeIndicators(m15Candles);
    const h1Indicators = computeIndicators(h1Candles);

    const riskManager = new RiskManager(config);
    const performanceTracker = new PerformanceTracker();
    const openPositions: SimulatedPosition[] = [];
    const closedTrades: ClosedTrade[] = [];
    let cooldownUntil = -1;
    let slCooldownUntil = -1;

    // V6: Regime state machine
    let regimeState: RegimeState | null = null;

    // V5: Engine state for BOS/FVG tracking
    const engineState: EngineState = {
      swingTracker: { recentHighs: [], recentLows: [] },
      activeBOSLevels: [],
      activeFVGs: [],
    };

    // V2.8: Same-day direction limit
    let dailySlCount = { BUY: 0, SELL: 0 };
    let lastDate = '';

    // Walk-forward loop
    for (let i = 0; i < m15Candles.length; i++) {
      const candle = m15Candles[i];
      const spread = getSpread(config.symbol, candle.openTime);

      const currentDate = candle.openTime.substring(0, 10);
      if (currentDate !== lastDate) {
        dailySlCount = { BUY: 0, SELL: 0 };
        lastDate = currentDate;
      }

      // V6: Update regime state machine
      regimeState = detectRegime(h1Candles, h1Indicators, candle.openTime, regimeState, performanceTracker);

      // V6: Compute D1 bias + news blackout (only when V6 active and pair-profile present)
      let d1Bias: D1Bias = 'NEUTRAL';
      let inNewsBlackout = false;
      if (strategyVersion === 'V6' && pairProfile) {
        if (d1Indicators) {
          d1Bias = getD1Bias(d1Candles, d1Indicators, candle.openTime);
        }
        if (pairProfile.newsBlackoutEnabled) {
          inNewsBlackout = isInBlackout(candle.openTime, pairProfile.newsBlackoutMinutes);
        }
        if (regimeState) {
          regimeState.d1Bias = d1Bias;
          regimeState.inNewsBlackout = inNewsBlackout;
        }
      }

      // V5: Update swing tracker, detect BOS events and FVGs
      updateSwingTracker(engineState.swingTracker, m15Candles, i);
      const newBOSLevels = detectBOSEvents(m15Candles, i, engineState.swingTracker, engineState.activeBOSLevels);
      engineState.activeBOSLevels.push(...newBOSLevels);
      const newFVGs = detectFVGs(m15Candles, m15Indicators, i);
      engineState.activeFVGs.push(...newFVGs);

      // Expire stale BOS levels and FVGs
      engineState.activeBOSLevels = engineState.activeBOSLevels.filter(
        (l) => !l.traded && i - l.breakIndex <= l.expiryCandles,
      );
      engineState.activeFVGs = engineState.activeFVGs.filter(
        (f) => !f.traded && i - f.createdAtIndex <= f.expiryCandles,
      );

      // Step 0: Update trade management (breakeven + trailing stop)
      for (let j = 0; j < openPositions.length; j++) {
        openPositions[j] = updatePositionManagement(openPositions[j], candle, spread);
      }

      // V6: max-bars-in-trade force close at 48 M15 bars (12h).
      // Stops slow grinders against direction from bleeding R out.
      const V6_MAX_BARS = 48;
      if (strategyVersion === 'V6') {
        for (let j = openPositions.length - 1; j >= 0; j--) {
          const pos = openPositions[j];
          if (i - pos.entryIndex >= V6_MAX_BARS && !pos.breakevenActivated) {
            const commission = pos.lotSize * commissionPerLot;
            const result = forceClosePosition(pos, candle.close, candle.openTime, commission, lotSizeUnits);
            result.setupTags = [...result.setupTags, 'MAX_BARS'];
            riskManager.recordTrade(result.pnl, candle.openTime, result.exitReason);
            performanceTracker.recordTrade(result);
            closedTrades.push(result);
            openPositions.splice(j, 1);
            cooldownUntil = i + 1;
          }
        }
      }

      // Step 1: Check exits on existing positions
      for (let j = openPositions.length - 1; j >= 0; j--) {
        const pos = openPositions[j];
        const commission = pos.lotSize * commissionPerLot;
        const result = checkPositionExit(pos, candle, spread, commission, lotSizeUnits);
        if (result) {
          riskManager.recordTrade(result.pnl, candle.openTime, result.exitReason);
          performanceTracker.recordTrade(result);
          closedTrades.push(result);
          openPositions.splice(j, 1);

          // V6 (round 3): trimmed cooldowns to allow back-to-back entries.
          // V5.5b path keeps the original (1/1/2) for backward compat.
          const isV6 = strategyVersion === 'V6';
          if (result.exitReason === 'TP') {
            cooldownUntil = i + (isV6 ? 0 : 1);
          } else if (result.exitReason === 'BREAKEVEN') {
            cooldownUntil = i + (isV6 ? 0 : 1);
          } else if (result.exitReason === 'SL') {
            cooldownUntil = i + (isV6 ? 1 : 2);
            slCooldownUntil = i + (isV6 ? 1 : 2);
            dailySlCount[pos.side]++;
          }
        }
      }

      // === V6: Scale-In Check (Phase 5) ===
      if (regimeState && (regimeState.regime === 'STRONG_TREND' || regimeState.regime === 'WEAK_TREND')) {
        this.checkScaleIns(
          openPositions, regimeState, performanceTracker, riskManager,
          config, candle, m15Indicators, i, spread, pricePrecision, lotSizeUnits,
        );
      }

      // Step 2: Check for new setups (only if risk + cooldown allows)
      if (i <= cooldownUntil || i <= slCooldownUntil) continue;

      // V6: News blackout — skip new entries (open positions still managed normally)
      if (inNewsBlackout) continue;

      if (!riskManager.canTrade(currentDate, openPositions.length)) continue;

      const tradingMode = riskManager.getTradingMode();

      // V6: Compute weekly floor adjusted min quality
      const minQuality = this.getAdjustedMinQuality(candle.openTime, performanceTracker);

      // V6: Regime-aware routing
      let signal = null;

      // 1. Trend Engine: available in STRONG_TREND and WEAK_TREND
      if (regimeState && (regimeState.regime === 'STRONG_TREND' || regimeState.regime === 'WEAK_TREND' || regimeState.regime === 'TRANSITIONING')) {
        signal = evaluateSetup(
          m15Candles, m15Indicators, h1Candles, h1Indicators, i,
          spread, minAtr, pricePrecision, regimeState, minQuality,
        );
      }

      // 2. FVG Fill: available in all non-deep-ranging regimes
      if (!signal && regimeState) {
        signal = evaluateFVGEntry(
          m15Candles, m15Indicators, h1Candles, h1Indicators, i,
          engineState.activeFVGs, spread, minAtr, pricePrecision, regimeState, minQuality,
        );
        if (signal) {
          for (const fvg of engineState.activeFVGs) {
            if (!fvg.traded && fvg.direction === signal.side &&
                i - fvg.createdAtIndex <= fvg.expiryCandles) {
              fvg.traded = true;
              break;
            }
          }
        }
      }

      // 3. Range / BB Reversal: only in RANGING regime and not DEFENSIVE
      //    V6 with bbReversal=true uses Bollinger reversal; legacy V5.5b uses RANGE_ENGINE.
      if (!signal && regimeState && regimeState.regime === 'RANGING' && tradingMode !== 'DEFENSIVE') {
        const useBB = strategyVersion === 'V6' && pairProfile?.engineToggles.bbReversal;
        const useRange = (strategyVersion !== 'V6') || (pairProfile?.engineToggles.rangeReversion ?? true);

        if (useBB) {
          signal = evaluateBBReversal(
            m15Candles, m15Indicators, h1Candles, h1Indicators, i,
            spread, minAtr, pricePrecision, regimeState, minQuality,
          );
        }
        if (!signal && useRange) {
          signal = evaluateRangeSetup(
            m15Candles, m15Indicators, h1Candles, h1Indicators, i,
            spread, minAtr, pricePrecision, regimeState, minQuality,
          );
        }
      }

      // 4. EMA Cross + Retest (V6 only) — generic trend-follow firing in all regimes
      if (!signal && strategyVersion === 'V6' && tradingMode !== 'DEFENSIVE') {
        signal = evaluateEmaCross(
          m15Candles, m15Indicators, h1Candles, h1Indicators, i,
          spread, minAtr, pricePrecision, regimeState, minQuality,
        );
      }

      // 5. Momentum Continuation (V6 only) — high-frequency last-resort engine.
      // Lower per-trade edge but designed to lift trade count toward 10-15/mo target.
      if (!signal && strategyVersion === 'V6' && tradingMode !== 'DEFENSIVE') {
        signal = evaluateMomentumContinuation(
          m15Candles, m15Indicators, h1Candles, h1Indicators, i,
          spread, minAtr, pricePrecision, regimeState, minQuality,
        );
      }

      if (!signal) continue;

      // V6: Quality score (already computed inline for V6 evaluators)
      if (signal.qualityScore === undefined) {
        const qualityScore = calculateQualityScore(m15Candles, m15Indicators, h1Candles, h1Indicators, i, signal);
        signal.qualityScore = qualityScore;
      }

      // V6: D1 trend confluence as a quality penalty (-10 when counter-D1).
      // D1 bias already returns NEUTRAL during near-flat slope (hysteresis in getD1Bias),
      // so penalty only fires when D1 is genuinely directional.
      if (strategyVersion === 'V6' && pairProfile?.d1ConfluenceRequired && d1Bias !== 'NEUTRAL') {
        const counterD1 =
          (signal.side === 'BUY' && d1Bias === 'BEARISH') ||
          (signal.side === 'SELL' && d1Bias === 'BULLISH');
        if (counterD1) {
          signal.qualityScore = Math.max(0, signal.qualityScore - 10);
          signal.setupTags.push('COUNTER_D1');
        } else {
          signal.qualityScore = Math.min(100, signal.qualityScore + 5);  // small bonus for HTF agreement
          signal.setupTags.push('WITH_D1');
        }
      }

      // V6: enforce per-pair quality floor
      const qFloor = pairProfile?.qualityFloor ?? 35;
      if (strategyVersion === 'V6' && signal.qualityScore < qFloor) continue;

      signal.setupTags.push(`Q${signal.qualityScore}`);

      // Same-day direction limit
      if (dailySlCount[signal.side] >= 3) continue;

      // V6: Derive engine type for performance tracker
      // EMA_CROSS reuses TREND_PULLBACK bucket since they're both trend-follow patterns.
      const engineType: EngineType = signal.setupTags.includes('BB_REVERSAL') ? 'BB_REVERSAL'
        : signal.setupTags.includes('RANGE_ENGINE') ? 'RANGE_ENGINE'
        : signal.setupTags.includes('FVG_FILL') ? 'FVG_FILL'
        : 'TREND_PULLBACK';

      // V6: Dynamic lot sizing with regime + quality + confidence
      const slPoints = Math.abs(signal.entryPrice - signal.slPrice);
      const engineConfidence = performanceTracker.getEngineConfidence(engineType);
      const lotSize = riskManager.calculateLotSize(
        slPoints,
        signal.qualityScore,
        regimeState?.regime,
        engineConfidence,
      );

      // V6 round 4: lot=0 means RiskManager rejected the trade (over-risk).
      if (lotSize <= 0) continue;

      // Direction stacking guards
      const sameDirectionPositions = openPositions.filter(p => p.side === signal.side);
      if (sameDirectionPositions.length > 0) {
        const allAtBreakeven = sameDirectionPositions.every(p => p.breakevenActivated);
        const isStrongTrend = regimeState?.regime === 'STRONG_TREND';
        const atrRatio = m15Indicators.atr14[i] / m15Indicators.atrBaseline[i];
        const elevatedVol = !isNaN(atrRatio) && atrRatio >= 1.3;

        if (
          sameDirectionPositions.length >= 2 ||
          !allAtBreakeven ||
          !isStrongTrend ||
          tradingMode === 'DEFENSIVE' ||
          elevatedVol
        ) continue;

        const MAX_EVENT_RISK_PCT = 20;
        const newPositionRisk = slPoints * lotSize * lotSizeUnits;
        const sameDirectionRisk = sameDirectionPositions.reduce((sum, p) => {
          const posRisk = Math.abs(p.entryPrice - p.slPrice) * p.lotSize * lotSizeUnits;
          return sum + posRisk;
        }, 0);
        const totalDirectionRisk = sameDirectionRisk + newPositionRisk;
        const maxEventRisk = riskManager.getBalance() * (MAX_EVENT_RISK_PCT / 100);
        if (totalDirectionRisk > maxEventRisk) continue;
      }

      // Tag trade with adaptive mode and regime
      signal.setupTags.push(tradingMode);

      const regimeParams = (signal as any).regimeTradeParams ?? getRegimeParams(regimeState?.regime ?? 'RANGING');

      const basePosition: SimulatedPosition = {
        side: signal.side,
        entryPrice: signal.entryPrice,
        slPrice: signal.slPrice,
        tpPrice: signal.tpPrice,
        originalSlPrice: signal.slPrice,
        breakevenActivated: false,
        peakFavorablePrice: signal.entryPrice,
        lotSize,
        entryTime: candle.openTime,
        entryIndex: i,
        setupTags: signal.setupTags,
        h1Bias: signal.h1Bias,
        rsiAtEntry: signal.rsiAtEntry,
        atrAtEntry: signal.atrAtEntry,
        trailConfig: regimeParams,
        regimeAtEntry: regimeState?.regime,
      };

      const isStrongOrHighQ = regimeState?.regime === 'STRONG_TREND' || (signal.qualityScore ?? 0) >= 65;
      const isPyramid = signal.setupTags.includes('PYRAMID');

      // V6: High-quality / strong-trend get locker + runner split
      if (isStrongOrHighQ && !isPyramid && lotSize >= 0.02) {
        const risk = Math.abs(signal.entryPrice - signal.slPrice);
        const lockerTp = signal.side === 'BUY'
          ? signal.entryPrice + risk * 1.0
          : signal.entryPrice - risk * 1.0;
        const factor = Math.pow(10, pricePrecision);
        const lockerLot = Math.round(lotSize * 0.3 * 100) / 100;

        // Runner: full lot, regime TP
        openPositions.push({
          ...basePosition,
          lotSize,
          setupTags: [...signal.setupTags, 'RUNNER'],
        });
        // Locker: 30% lot, 1.0R TP
        if (lockerLot >= 0.01) {
          openPositions.push({
            ...basePosition,
            lotSize: lockerLot,
            tpPrice: Math.round(lockerTp * factor) / factor,
            setupTags: [...signal.setupTags, 'LOCKER'],
          });
        }
      } else {
        openPositions.push({ ...basePosition, lotSize });
      }

      cooldownUntil = i + 1;
    }

    // Force-close any remaining open positions
    if (openPositions.length > 0 && m15Candles.length > 0) {
      const lastCandle = m15Candles[m15Candles.length - 1];
      for (const pos of openPositions) {
        const commission = pos.lotSize * commissionPerLot;
        const result = forceClosePosition(
          pos,
          lastCandle.close,
          lastCandle.openTime,
          commission,
          lotSizeUnits,
        );
        riskManager.recordTrade(result.pnl, lastCandle.openTime, result.exitReason);
        performanceTracker.recordTrade(result);
        closedTrades.push(result);
      }
    }

    const metrics = calculateMetrics(closedTrades, config.initialBalance);

    this.logger.log(
      `V6.0 backtest complete: ${metrics.totalTrades} trades, ` +
        `winRate=${metrics.winRate}%, PnL=$${metrics.totalPnl}, ` +
        `maxDD=${metrics.maxDrawdownPercent}%`,
    );

    return { trades: closedTrades, metrics };
  }

  /**
   * V6 Phase 5: Scale-in / Add-to-winners.
   *
   * For open positions at 1.0-1.5R profit in trend regime:
   * - Must be at breakeven, direction matches regime, engine confidence > 50
   * - Open scale-in: 50% of parent lot, SL at parent entry (free trade), no TP (trail only)
   * - One scale-in per parent, tagged SCALED_IN
   */
  private checkScaleIns(
    openPositions: SimulatedPosition[],
    regimeState: RegimeState,
    tracker: PerformanceTracker,
    riskManager: RiskManager,
    config: EngineConfig,
    candle: BacktestCandle,
    m15Indicators: { atr14: number[] },
    idx: number,
    spread: number,
    pricePrecision: number,
    lotSizeUnits: number,
  ): void {
    // Can't scale in during defensive mode or at position limit
    if (riskManager.getTradingMode() === 'DEFENSIVE') return;
    if (openPositions.length >= config.maxOpenPositions) return;

    const engineConfidence = tracker.getEngineConfidence('TREND_PULLBACK');
    if (engineConfidence <= 50) return;

    const factor = Math.pow(10, pricePrecision);

    for (const pos of openPositions) {
      // Only scale into non-scale-in, trend positions at breakeven
      if (pos.isScaleIn) continue;
      if (pos.hasScaleIn) continue;
      if (!pos.breakevenActivated) continue;
      if (pos.setupTags.includes('RANGE_ENGINE')) continue;
      if (pos.setupTags.includes('SCALED_IN')) continue;
      if (pos.setupTags.includes('LOCKER')) continue;

      // Direction must match current regime
      if (pos.side === 'BUY' && regimeState.direction !== 'BULLISH') continue;
      if (pos.side === 'SELL' && regimeState.direction !== 'BEARISH') continue;

      // Check profit level: 1.0-1.5R
      const risk = Math.abs(pos.entryPrice - pos.originalSlPrice);
      if (risk === 0) continue;

      const halfSpread = spread / 2;
      const currentPrice = pos.side === 'BUY'
        ? candle.close - halfSpread // bid
        : candle.close + halfSpread; // ask
      const profit = pos.side === 'BUY'
        ? currentPrice - pos.entryPrice
        : pos.entryPrice - currentPrice;
      const rMultiple = profit / risk;

      if (rMultiple < 1.0 || rMultiple > 1.5) continue;

      // Scale-in: 50% of parent lot, SL at parent entry (free trade), no TP
      const scaleInLot = Math.round(pos.lotSize * 0.5 * 100) / 100;
      if (scaleInLot < 0.01) continue;

      // Event risk check
      const scaleInRisk = Math.abs(currentPrice - pos.entryPrice) * scaleInLot * lotSizeUnits;
      const MAX_EVENT_RISK_PCT = 20;
      const maxEventRisk = riskManager.getBalance() * (MAX_EVENT_RISK_PCT / 100);
      const existingRisk = openPositions.reduce((sum, p) => {
        return sum + Math.abs(p.entryPrice - p.slPrice) * p.lotSize * lotSizeUnits;
      }, 0);
      if (existingRisk + scaleInRisk > maxEventRisk) continue;

      const entryPrice = pos.side === 'BUY'
        ? candle.close + halfSpread
        : candle.close - halfSpread;

      const scaleIn: SimulatedPosition = {
        side: pos.side,
        entryPrice: Math.round(entryPrice * factor) / factor,
        slPrice: pos.entryPrice, // SL at parent entry = free trade
        tpPrice: null, // Trail only
        originalSlPrice: pos.entryPrice,
        breakevenActivated: false,
        peakFavorablePrice: entryPrice,
        lotSize: scaleInLot,
        entryTime: candle.openTime,
        entryIndex: idx,
        setupTags: [...pos.setupTags.filter(t => !t.startsWith('Q') && t !== 'RUNNER' && t !== 'LOCKER'), 'SCALED_IN'],
        h1Bias: pos.h1Bias,
        rsiAtEntry: pos.rsiAtEntry,
        atrAtEntry: m15Indicators.atr14[idx] ?? pos.atrAtEntry,
        trailConfig: pos.trailConfig,
        regimeAtEntry: regimeState.regime,
        isScaleIn: true,
        parentEntryPrice: pos.entryPrice,
      };

      openPositions.push(scaleIn);
      pos.hasScaleIn = true; // Mark parent
      break; // One scale-in per candle
    }
  }

  /**
   * V6 Phase 6: Weekly Trade Floor.
   * Lower min quality threshold on Thu/Fri if behind 3 trades/week.
   */
  private getAdjustedMinQuality(currentTime: string, tracker: PerformanceTracker): number {
    const DEFAULT_MIN_QUALITY = 35;
    const deficit = tracker.getWeeklyTradeDeficit(currentTime);

    if (deficit === 0) return DEFAULT_MIN_QUALITY;

    const d = new Date(currentTime);
    const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri

    if (dayOfWeek === 5) {
      // Friday
      if (deficit >= 3) return 22;
      if (deficit >= 2) return 28;
      return 30;
    } else if (dayOfWeek === 4) {
      // Thursday
      if (deficit >= 2) return 28;
      return 30;
    }

    return DEFAULT_MIN_QUALITY;
  }
}
