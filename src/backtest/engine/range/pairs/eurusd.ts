import { RangePairConfig } from '../types';

export const EURUSD_RANGE_CONFIG: RangePairConfig = {
  symbol: 'EURUSD',
  enabled: false, // toggled per pair after replay-validation
  rsiOversold: 25,
  rsiOverbought: 75,
  d1AdxMaxForRange: 22, // mirrors SmcPairConfig.trendingD1Adx so the two are regime-orthogonal
  atrSpikeRatio: 2.0,
  minMeanDistanceAtr: 1.0,
  slBufferAtrM15: 0.5,
  killzones: [[7, 11], [13, 17]],
  tpFraction: 0.85,
  cooldownBarsAfterSL: 4,
  minBarsBetweenTriggers: 8,
};
