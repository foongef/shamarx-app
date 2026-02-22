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
import { checkPositionExit, forceClosePosition } from './position-simulator';
import { RiskManager } from './risk-manager';
import { calculateMetrics } from './metrics-calculator';

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
    this.logger.log(
      `Starting backtest: ${m15Candles.length} M15 candles, ${h1Candles.length} H1 candles`,
    );

    // Pre-compute indicators
    const m15Indicators = computeIndicators(m15Candles);
    const h1Indicators = computeIndicators(h1Candles);

    const riskManager = new RiskManager(config);
    const openPositions: SimulatedPosition[] = [];
    const closedTrades: ClosedTrade[] = [];

    // Walk-forward loop
    for (let i = 0; i < m15Candles.length; i++) {
      const candle = m15Candles[i];

      // Step 1: Check exits on existing positions
      for (let j = openPositions.length - 1; j >= 0; j--) {
        const result = checkPositionExit(openPositions[j], candle);
        if (result) {
          riskManager.recordTrade(result.pnl, candle.openTime);
          closedTrades.push(result);
          openPositions.splice(j, 1);
        }
      }

      // Step 2: Check for new setups (only if risk allows)
      const currentDate = candle.openTime.substring(0, 10);
      if (!riskManager.canTrade(currentDate, openPositions.length)) continue;

      const signal = evaluateSetup(
        m15Candles,
        m15Indicators,
        h1Candles,
        h1Indicators,
        i,
      );

      if (!signal) continue;

      // Step 3: Calculate lot size and open position
      const slPoints = Math.abs(signal.entryPrice - signal.slPrice);
      const lotSize = riskManager.calculateLotSize(slPoints);

      const position: SimulatedPosition = {
        side: signal.side,
        entryPrice: signal.entryPrice,
        slPrice: signal.slPrice,
        tpPrice: signal.tpPrice,
        lotSize,
        entryTime: candle.openTime,
        entryIndex: i,
        setupTags: signal.setupTags,
        h1Bias: signal.h1Bias,
        rsiAtEntry: signal.rsiAtEntry,
        atrAtEntry: signal.atrAtEntry,
      };

      openPositions.push(position);
    }

    // Force-close any remaining open positions at last candle's close
    if (openPositions.length > 0 && m15Candles.length > 0) {
      const lastCandle = m15Candles[m15Candles.length - 1];
      for (const pos of openPositions) {
        const result = forceClosePosition(
          pos,
          lastCandle.close,
          lastCandle.openTime,
        );
        riskManager.recordTrade(result.pnl, lastCandle.openTime);
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
