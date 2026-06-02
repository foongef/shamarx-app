/**
 * SMC config for GBPUSD — v1, EURUSD-style anchor-sweep template.
 *
 * GBPUSD is forex, not gold-like — it respects PDH/PDL/Asian-range anchors
 * cleanly (cable's classic stop-hunt behavior). Cloning EURUSD's iter4
 * config (anchor sweeps + displacement + news blackout + auto-mode filter)
 * is the right starting point. Tuned values reflect cable's slightly higher
 * volatility vs EURUSD: 8-12 pip M15 ATR (vs EUR's 4-8) → marginally wider
 * buffers and shorter expiry to avoid stale setups around London volatility
 * spikes.
 */
import { SmcPairConfig } from '../types';

export const GBPUSD_SMC_CONFIG: SmcPairConfig = {
  symbol: 'GBPUSD',

  sweepBufferAtr: 0.25,
  slBufferAtrM15: 0.30,

  setupExpiryH1Bars: 10,
  atrSpikeLimit: 2.2,

  trendingD1Adx: 22,
  d1AdxFloor: 10,

  recentSwingLookbackH1: 28,
  slCooldownBars: 6,

  // London (7-11 UTC) + London-NY overlap (13-17 UTC).
  killzones: [
    [7, 11],
    [13, 17],
  ],

  tp1PartialFraction: 0.30,
  tp1R: 0.8,
  tp2R: 3.5,

  autoModeFilter: true,
  useAnchorSweeps: true,
  // Disabled (was 0.5) — see eurusd.ts:54 for full rationale. 12-month replay
  // showed GBPUSD specifically went from +$140 (94T) to +$301 (120T) at 1.5%
  // risk after removing the displacement filter.
  anchorDisplacementAtr: 0,
  newsBlackoutMinutes: 15,
};
