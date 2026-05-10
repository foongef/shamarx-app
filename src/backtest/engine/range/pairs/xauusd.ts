import { RangePairConfig } from '../types';

export const XAUUSD_RANGE_CONFIG: RangePairConfig = {
  symbol: 'XAUUSD',
  enabled: false,
  // XAU is more volatile and wicks more — slightly tighter RSI + larger
  // mean-distance gate to avoid noise.
  rsiOversold: 22,
  rsiOverbought: 78,
  d1AdxMaxForRange: 24, // matches XAU's higher trendingD1Adx in SMC config
  atrSpikeRatio: 2.5, // gold spikes harder during news
  minMeanDistanceAtr: 1.2,
  slBufferAtrM15: 0.6,
  killzones: [[7, 11], [13, 17]],
  tpFraction: 0.80,
  cooldownBarsAfterSL: 5,
  minBarsBetweenTriggers: 8,
};
