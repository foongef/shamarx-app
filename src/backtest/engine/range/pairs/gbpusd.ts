import { RangePairConfig } from '../types';

export const GBPUSD_RANGE_CONFIG: RangePairConfig = {
  symbol: 'GBPUSD',
  enabled: false,
  rsiOversold: 25,
  rsiOverbought: 75,
  d1AdxMaxForRange: 22,
  atrSpikeRatio: 2.0,
  minMeanDistanceAtr: 1.0,
  slBufferAtrM15: 0.5,
  killzones: [[7, 11], [13, 17]],
  tpFraction: 0.85,
  cooldownBarsAfterSL: 4,
  minBarsBetweenTriggers: 8,
};
