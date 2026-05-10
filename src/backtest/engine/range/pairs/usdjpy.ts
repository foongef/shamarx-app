import { RangePairConfig } from '../types';

export const USDJPY_RANGE_CONFIG: RangePairConfig = {
  symbol: 'USDJPY',
  enabled: false,
  rsiOversold: 25,
  rsiOverbought: 75,
  d1AdxMaxForRange: 22,
  atrSpikeRatio: 2.0,
  minMeanDistanceAtr: 1.0,
  slBufferAtrM15: 0.5,
  killzones: [[0, 4], [13, 17]], // Asian + NY (same as SMC USDJPY)
  tpFraction: 0.85,
  cooldownBarsAfterSL: 4,
  minBarsBetweenTriggers: 8,
};
