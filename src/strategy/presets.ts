import { PresetKey } from '@prisma/client';

export interface StrategyPreset {
  riskPercent: number;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  pairs: string[];
}

export const PRESETS: Record<PresetKey, StrategyPreset> = {
  CONSERVATIVE: {
    riskPercent: 0.5,
    maxDailyLossPercent: 2.0,
    maxOpenPositions: 2,
    pairs: ['EURUSD', 'GBPUSD'],
  },
  BALANCED: {
    riskPercent: 1.0,
    maxDailyLossPercent: 3.0,
    maxOpenPositions: 3,
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  },
  AGGRESSIVE: {
    riskPercent: 1.5,
    maxDailyLossPercent: 5.0,
    maxOpenPositions: 3,
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  },
};

export function getPreset(key: PresetKey): StrategyPreset {
  return PRESETS[key];
}
