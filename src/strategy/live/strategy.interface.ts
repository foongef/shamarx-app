/**
 * Common interface for live trading strategies. Both LiveSmcOrchestrator
 * (the original stop-hunt reversal) and any new strategies (Range
 * Reversion, etc.) implement this so LiveStrategyService and ReplayEngine
 * can fan out across multiple strategies through the same call site.
 *
 * The signal shape is reused across strategies (`SmcLiveSignal`) — the
 * legs/SL/TP/lot fields are strategy-neutral; only `mode`, `setupTags`,
 * and `reason` differ per strategy.
 */
import { BacktestCandle } from '../../backtest/engine/types';
import { SmcLiveSignal } from './smc-live-evaluator';
import { LiveContext, PrecomputedIndicators } from './live-smc-orchestrator';

export interface IStrategyOrchestrator {
  /** Stable identifier — used in trade tagging (`strategyName` column),
   *  Redis persistence keys, and telemetry events. Examples:
   *  'stop-hunt', 'range-reversion'. */
  readonly name: string;

  /** Evaluate a single M15 close. Returns a signal if the strategy wants
   *  to fire on this candle, null otherwise. Same signature as
   *  LiveSmcOrchestrator.evaluate so callers don't need different
   *  call sites per strategy. */
  evaluate(
    symbol: string,
    m15Candles: BacktestCandle[],
    h1Candles: BacktestCandle[],
    d1Candles: BacktestCandle[],
    ctx: LiveContext,
    precomputed?: PrecomputedIndicators,
    cursor?: { m15: number; h1: number; d1: number },
  ): SmcLiveSignal | null;

  /** Notify the strategy that a signal it produced was just placed at
   *  the broker. Strategies use this to update internal state
   *  (cooldowns, dedup sets). */
  recordEntry(symbol: string, signal: SmcLiveSignal): void;

  /** Notify the strategy that one of its positions just closed. The
   *  RiskManager owned by the strategy uses this to track consecutive
   *  losses, daily PnL, drawdown, etc. */
  recordExit(
    symbol: string,
    exitReason: 'SL' | 'TP' | 'OTHER',
    exitTimeIso: string,
    pnl?: number,
  ): void;

  /** Reset all per-pair state — used at the start of a fresh replay. */
  resetAll(): void;

  /** Snapshot for Redis persistence. Implementations should produce a
   *  JSON-safe POJO. */
  serialize(): Record<string, unknown>;

  /** Re-hydrate from a Redis snapshot. Defensive: missing keys must
   *  fall through to fresh defaults. */
  restore(snapshot: Record<string, any>): void;
}
