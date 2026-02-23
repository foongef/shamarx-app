import { Logger } from '@nestjs/common';
import {
  BacktestCandle,
  ClosedTrade,
  SimulatedPosition,
  EngineConfig,
  BacktestMetrics,
} from './types';
import { computeIndicators } from './indicator-calculator';
import { evaluateSetup } from './strategy-evaluator';
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

      // Single-pass evaluation — spread passed for entry adjustment
      const signal = evaluateSetup(
        m15Candles,
        m15Indicators,
        h1Candles,
        h1Indicators,
        i,
        spread,
        minAtr,
        pricePrecision,
      );

      if (!signal) continue;

      // V2.8: Same-day direction limit — skip if already hit SL in this direction today
      if (dailySlCount[signal.side] >= 1) continue;

      // Step 3: Calculate lot size and open position
      const slPoints = Math.abs(signal.entryPrice - signal.slPrice);
      const lotSize = riskManager.calculateLotSize(slPoints);

      const position: SimulatedPosition = {
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

      openPositions.push(position);
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
