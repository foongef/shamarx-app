/**
 * SMC config for USDJPY — SCAFFOLD, not yet tuned.
 *
 * USDJPY behavior is dominated by BoJ policy and intervention. CONTINUATION
 * mode works well during sustained yen-weakening trends; REVERSAL mode is
 * unreliable around intervention spikes (BoJ creates sharp wicks that don't
 * snap back the way retail-driven gold sweeps do).
 *
 * TODO: backtest 2023-2026 (esp. Q3 2024 BoJ intervention period), sweep
 * parameters, document results. Consider an "intervention skip" filter that
 * disables REVERSAL mode if M5 ATR / baseline > 5 (intervention signature).
 */
import { SmcPairConfig } from '../types';

export const USDJPY_SMC_CONFIG: SmcPairConfig = {
  symbol: 'USDJPY',

  sweepBufferAtr: 0.12,
  slBufferAtrM15: 0.20,

  setupExpiryH1Bars: 8,
  atrSpikeLimit: 3.5,           // raised — BoJ moves create big legitimate spikes

  trendingD1Adx: 22,            // yen trends are clean when present
  d1AdxFloor: 10,

  recentSwingLookbackH1: 24,
  slCooldownBars: 6,             // longer cooldown — intervention aftershocks

  // Tokyo (0-3 UTC) for direct yen flow, London (7-11), NY (13-17)
  killzones: [
    [0, 3],
    [7, 11],
    [13, 17],
  ],

  tp1PartialFraction: 0.30,
  tp1R: 0.8,
  tp2R: 3.5,
};
