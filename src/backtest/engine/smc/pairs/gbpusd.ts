/**
 * SMC config for GBPUSD — SCAFFOLD, not yet tuned.
 *
 * GBPUSD is the closest forex analog to gold: high volatility, news-driven
 * swings, frequent liquidity sweeps around the London open. Should transfer
 * well from XAUUSD with mild adjustments.
 *
 * TODO: backtest 2023-2026, sweep these parameters, document results.
 */
import { SmcPairConfig } from '../types';

export const GBPUSD_SMC_CONFIG: SmcPairConfig = {
  symbol: 'GBPUSD',

  // Volatile like gold, but cleaner sweeps — slightly tighter buffer works
  sweepBufferAtr: 0.12,
  slBufferAtrM15: 0.22,

  setupExpiryH1Bars: 8,
  atrSpikeLimit: 2.5,

  trendingD1Adx: 21,
  d1AdxFloor: 10,

  recentSwingLookbackH1: 24,
  slCooldownBars: 4,

  // London open (6-10 UTC), London-NY overlap (12-17 UTC, includes London fix)
  killzones: [
    [6, 10],
    [12, 17],
  ],

  tp1PartialFraction: 0.30,
  tp1R: 0.8,
  tp2R: 3.5,
};
