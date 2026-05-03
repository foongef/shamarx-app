/**
 * V6-alt SMC strategy — public surface.
 *
 * Imported lazily by backtest-engine.ts when strategyVersion === 'V6-alt'.
 *
 * Architecture:
 *   - smc-engine.ts: pair-agnostic main loop
 *   - sweep-detector.ts: pair-agnostic sweep + mode detection
 *   - types.ts: shared types
 *   - trail-config.ts: TP1 + runner trail presets
 *   - pairs/: per-pair tuning configs (XAUUSD, EURUSD, GBPUSD, USDJPY, ...)
 *
 * To add a new pair: drop a config file in pairs/<symbol>.ts and register
 * it in pairs/index.ts. No other code changes needed.
 */
export { runSmcBacktest } from './smc-engine';
export { getSmcPairConfig, SMC_PAIR_REGISTRY } from './pairs';
export type { SmcPairConfig, SmcMode, PendingSetup } from './types';
