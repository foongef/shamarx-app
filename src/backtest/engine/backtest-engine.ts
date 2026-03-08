import { Logger } from '@nestjs/common';
import {
  BacktestCandle,
  ClosedTrade,
  SimulatedPosition,
  EngineConfig,
  BacktestMetrics,
} from './types';
import { computeIndicators } from './indicator-calculator';
import { evaluateSetup, evaluateRangeSetup, getH1Regime } from './strategy-evaluator';
import { checkPositionExit, forceClosePosition, updatePositionManagement } from './position-simulator';
import { RiskManager } from './risk-manager';
import { calculateMetrics } from './metrics-calculator';
import { getSpread } from './spread-model';
import { getInstrumentConfig } from './instrument-config';

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
  ): BacktestResult {
    const instrumentConfig = getInstrumentConfig(config.symbol);
    const { commissionPerLot, minAtr, lotSizeUnits, pricePrecision } = instrumentConfig;

    this.logger.log(
      `Starting backtest [${config.symbol}]: ${m15Candles.length} M15 candles, ${h1Candles.length} H1 candles`,
    );

    // Pre-compute indicators
    const m15Indicators = computeIndicators(m15Candles);
    const h1Indicators = computeIndicators(h1Candles);

    const riskManager = new RiskManager(config);
    const openPositions: SimulatedPosition[] = [];
    const closedTrades: ClosedTrade[] = [];
    let cooldownUntil = -1; // entry cooldown (candle index)
    let slCooldownUntil = -1; // extra cooldown after SL hit

    // V2.8: Same-day direction limit — block re-entry in a direction after 1 SL hit that day
    let dailySlCount = { BUY: 0, SELL: 0 };
    let lastDate = '';

    // Walk-forward loop
    for (let i = 0; i < m15Candles.length; i++) {
      const candle = m15Candles[i];
      const spread = getSpread(config.symbol, candle.openTime);

      // V2.8: Reset daily SL counters on new day
      const currentDate = candle.openTime.substring(0, 10);
      if (currentDate !== lastDate) {
        dailySlCount = { BUY: 0, SELL: 0 };
        lastDate = currentDate;
      }

      // Step 0: Update trade management (breakeven + trailing stop)
      for (let j = 0; j < openPositions.length; j++) {
        openPositions[j] = updatePositionManagement(openPositions[j], candle, spread);
      }

      // Step 1: Check exits on existing positions (with trailing SL)
      for (let j = openPositions.length - 1; j >= 0; j--) {
        const pos = openPositions[j];
        const commission = pos.lotSize * commissionPerLot;
        const result = checkPositionExit(pos, candle, spread, commission, lotSizeUnits);
        if (result) {
          riskManager.recordTrade(result.pnl, candle.openTime, result.exitReason);
          closedTrades.push(result);
          openPositions.splice(j, 1);

          // Set cooldown based on exit type
          if (result.exitReason === 'TP') {
            cooldownUntil = i + 2; // 30-min cooldown after TP — trend confirmed, re-enter fast
          } else if (result.exitReason === 'BREAKEVEN') {
            cooldownUntil = i + 2; // 30-min cooldown after BE — setup was valid, try again
          } else if (result.exitReason === 'SL') {
            // V2.7: Uniform 4-candle (1hr) SL cooldown for all trades
            cooldownUntil = i + 4;
            slCooldownUntil = i + 4;
            // V2.8: Track SL direction for same-day limit
            dailySlCount[pos.side]++;
          }
        }
      }

      // Step 2: Check for new setups (only if risk + cooldown allows)
      if (i <= cooldownUntil || i <= slCooldownUntil) continue;

      if (!riskManager.canTrade(currentDate, openPositions.length)) continue;

      // V4: Get adaptive trading mode
      const tradingMode = riskManager.getTradingMode();

      // V3.2: Regime routing — right strategy for right market
      const { h1Adx, adxRising } = getH1Regime(h1Candles, h1Indicators, candle.openTime);

      let signal = null;
      if (h1Adx >= 25 && adxRising) {
        // Trend Engine: STRONG_TREND EMA pullback + locker/runner (ADX must be rising)
        signal = evaluateSetup(m15Candles, m15Indicators, h1Candles, h1Indicators, i, spread, minAtr, pricePrecision);
      } else if (h1Adx < 20 && tradingMode !== 'DEFENSIVE') {
        // Range Engine: mean reversion at ATR bands (V4: disabled in DEFENSIVE)
        signal = evaluateRangeSetup(m15Candles, m15Indicators, h1Candles, h1Indicators, i, spread, minAtr, pricePrecision);
      }
      // ADX 20-25: dead zone — no trade

      if (!signal) continue;

      // --- V3.2/V4: Pyramid tagging (gated by canPyramid) ---
      if (signal.setupTags.includes('STRONG_TREND') && riskManager.canPyramid()) {
        const bePosition = openPositions.find(p =>
          p.breakevenActivated &&
          p.setupTags.includes('STRONG_TREND') &&
          !p.setupTags.includes('PYRAMID') &&
          p.side === signal.side
        );
        if (bePosition) {
          signal.setupTags.push('PYRAMID');
        }
      }

      // V2.8: Same-day direction limit — skip if already hit SL in this direction today
      if (dailySlCount[signal.side] >= 1) continue;

      // Step 3: Calculate lot size and open position
      const slPoints = Math.abs(signal.entryPrice - signal.slPrice);
      const lotSize = riskManager.calculateLotSize(slPoints);

      // V4: Direction stacking guards — position-state + event-risk cap
      const sameDirectionPositions = openPositions.filter(p => p.side === signal.side);
      if (sameDirectionPositions.length > 0) {
        // Guard A: Position-state cap
        const allAtBreakeven = sameDirectionPositions.every(p => p.breakevenActivated);
        const isStrongTrend = signal.setupTags.includes('STRONG_TREND');
        const atrRatio = m15Indicators.atr14[i] / m15Indicators.atrBaseline[i];
        const elevatedVol = !isNaN(atrRatio) && atrRatio >= 1.3;

        if (
          sameDirectionPositions.length >= 2 ||
          !allAtBreakeven ||
          !isStrongTrend ||
          tradingMode === 'DEFENSIVE' ||
          elevatedVol
        ) continue;

        // Guard B: Event-risk cap — worst-case directional loss ≤ 20% of equity
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

      // V4: Tag trade with adaptive trading mode
      signal.setupTags.push(tradingMode);

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
      };

      const isStrongTrend = signal.setupTags.includes('STRONG_TREND');
      const isPyramid = signal.setupTags.includes('PYRAMID');

      if (isStrongTrend && !isPyramid && lotSize >= 0.02) {
        const halfLot = Math.round(lotSize * 0.5 * 100) / 100;
        const risk = Math.abs(signal.entryPrice - signal.slPrice);
        const lockerTp = signal.side === 'BUY'
          ? signal.entryPrice + risk * 1.5
          : signal.entryPrice - risk * 1.5;
        const factor = Math.pow(10, pricePrecision);

        // Locker: 50% lot, TP at 1.5R
        openPositions.push({
          ...basePosition,
          lotSize: halfLot,
          tpPrice: Math.round(lockerTp * factor) / factor,
          setupTags: [...signal.setupTags, 'LOCKER'],
        });
        // Runner: 50% lot, no TP (trail-managed)
        openPositions.push({
          ...basePosition,
          lotSize: halfLot,
          tpPrice: null,
          setupTags: [...signal.setupTags, 'RUNNER'],
        });
      } else {
        // Standard single position (WEAK/MODERATE or can't split)
        openPositions.push({ ...basePosition, lotSize });
      }

      cooldownUntil = i + 2; // 30-min cooldown after entry
    }

    // Force-close any remaining open positions at last candle's close
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
        closedTrades.push(result);
      }
    }

    const metrics = calculateMetrics(closedTrades, config.initialBalance);

    this.logger.log(
      `Backtest complete: ${metrics.totalTrades} trades, ` +
        `winRate=${metrics.winRate}%, PnL=$${metrics.totalPnl}, ` +
        `maxDD=${metrics.maxDrawdownPercent}%`,
    );


    return { trades: closedTrades, metrics };
  }
}
