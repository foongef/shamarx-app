/**
 * Per-pair Range Reversion config registry. Mirrors smc/pairs/index.ts.
 * Override mechanism (used by comparison runner) lets us flip `enabled`
 * per-pair per-scenario without modifying source files.
 */
import { RangePairConfig } from '../types';
import { XAUUSD_RANGE_CONFIG } from './xauusd';
import { EURUSD_RANGE_CONFIG } from './eurusd';
import { GBPUSD_RANGE_CONFIG } from './gbpusd';
import { USDJPY_RANGE_CONFIG } from './usdjpy';

export const RANGE_PAIR_REGISTRY: Record<string, RangePairConfig> = {
  XAUUSD: XAUUSD_RANGE_CONFIG,
  EURUSD: EURUSD_RANGE_CONFIG,
  GBPUSD: GBPUSD_RANGE_CONFIG,
  USDJPY: USDJPY_RANGE_CONFIG,
};

const overrides: Record<string, Partial<RangePairConfig>> = {};

export function setRangePairConfigOverride(symbol: string, partial: Partial<RangePairConfig>): void {
  const sym = symbol.toUpperCase();
  overrides[sym] = { ...overrides[sym], ...partial };
}

export function clearRangePairConfigOverrides(): void {
  for (const k of Object.keys(overrides)) delete overrides[k];
}

export function getRangePairConfig(symbol: string): RangePairConfig | null {
  const sym = symbol.toUpperCase();
  const cfg = RANGE_PAIR_REGISTRY[sym];
  if (!cfg) return null;
  const ov = overrides[sym];
  return ov ? { ...cfg, ...ov } : cfg;
}

export type { RangePairConfig };
