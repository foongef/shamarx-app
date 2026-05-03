/**
 * SMC config for USDJPY — v1, EURUSD-style anchor-sweep template.
 *
 * Same forex-style approach as EURUSD/GBPUSD: anchor sweeps at PDH/PDL/Asian
 * range, displacement filter, news blackout, auto-mode filter. USDJPY-specific
 * tweaks:
 *   - atrSpikeLimit: 3.5 (vs 2.0 for EUR) — BoJ moves create big legitimate
 *     spikes that aren't news-spike rejects.
 *   - slCooldownBars: 6 — longer cooldown around intervention aftershocks.
 *   - killzones include Tokyo (0-3 UTC) — yen flow originates there.
 *
 * If 2024 Q3 BoJ intervention period hurts results, add an intervention-skip
 * filter (disable REVERSAL when M5 ATR / baseline > 5).
 */
import { SmcPairConfig } from '../types';

export const USDJPY_SMC_CONFIG: SmcPairConfig = {
  symbol: 'USDJPY',

  sweepBufferAtr: 0.25,
  slBufferAtrM15: 0.30,

  setupExpiryH1Bars: 10,
  atrSpikeLimit: 3.5,

  trendingD1Adx: 22,
  d1AdxFloor: 10,

  recentSwingLookbackH1: 28,
  slCooldownBars: 6,

  // Tokyo (0-3), London (7-11), NY (13-17) — yen has 3 active windows.
  killzones: [
    [0, 3],
    [7, 11],
    [13, 17],
  ],

  tp1PartialFraction: 0.30,
  tp1R: 0.8,
  tp2R: 3.5,

  autoModeFilter: true,
  useAnchorSweeps: true,
  anchorDisplacementAtr: 0.5,
  newsBlackoutMinutes: 15,
};
