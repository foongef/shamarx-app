/**
 * Per-pair SMC config registry.
 *
 * To add a new pair:
 *   1. Create a new file in this folder (e.g. `audusd.ts`) exporting an
 *      SmcPairConfig object.
 *   2. Import it here and add it to SMC_PAIR_REGISTRY below.
 *   3. Done — `getSmcPairConfig("AUDUSD")` will return your config.
 *
 * The strategy core in ../smc-engine.ts and ../sweep-detector.ts reads
 * from this registry; no other files need changes.
 */
import { SmcPairConfig } from '../types';
import { XAUUSD_SMC_CONFIG } from './xauusd';
import { EURUSD_SMC_CONFIG } from './eurusd';
import { GBPUSD_SMC_CONFIG } from './gbpusd';
import { USDJPY_SMC_CONFIG } from './usdjpy';

export const SMC_PAIR_REGISTRY: Record<string, SmcPairConfig> = {
  XAUUSD: XAUUSD_SMC_CONFIG,
  EURUSD: EURUSD_SMC_CONFIG,
  GBPUSD: GBPUSD_SMC_CONFIG,
  USDJPY: USDJPY_SMC_CONFIG,
};

export function getSmcPairConfig(symbol: string): SmcPairConfig {
  const cfg = SMC_PAIR_REGISTRY[symbol.toUpperCase()];
  if (!cfg) {
    throw new Error(
      `No SMC pair config for ${symbol}. Available: ${Object.keys(SMC_PAIR_REGISTRY).join(', ')}. ` +
      `Add a config file in src/backtest/engine/smc/pairs/ and register it in pairs/index.ts.`,
    );
  }
  return cfg;
}

export type { SmcPairConfig };
