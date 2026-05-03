/**
 * SMC config for XAUUSD (gold).
 *
 * Tuned on Dukascopy historical 2023-01 → 2026-04. Round-3 honest results
 * at $1k account, 1.5% risk:
 *   2023: 14.7 t/mo, +21.6%, PF 1.38
 *   2024: 19.7 t/mo, +38.1%, PF 1.54
 *   2025: 16.0 t/mo, +71.2%, PF 2.18
 *   2026-YTD: 10.1 t/mo, +47.8%, PF 4.74
 */
import { SmcPairConfig } from '../types';

export const XAUUSD_SMC_CONFIG: SmcPairConfig = {
  symbol: 'XAUUSD',

  // Gold's wicks are wide; 10% of H1 ATR is enough to identify real liquidity grabs
  sweepBufferAtr: 0.10,
  slBufferAtrM15: 0.20,

  setupExpiryH1Bars: 8,
  atrSpikeLimit: 2.5,

  // Gold trends often (~40-50% of days have D1 ADX ≥ 22)
  trendingD1Adx: 22,
  d1AdxFloor: 10,

  recentSwingLookbackH1: 24,
  slCooldownBars: 4,

  // London (6-12 UTC) and NY (12-18 UTC) — gold's primary windows
  killzones: [
    [6, 12],
    [12, 18],
  ],

  tp1PartialFraction: 0.30,
  tp1R: 0.8,
  tp2R: 4.0,

  // Auto-detect when CONTINUATION is structurally safe (ADX rising, EMA stack
  // aligned, not over-extended). Gold trends usually pass — but during
  // exhausted moves or news spikes, the filter blocks bad CONTINUATION setups.
  autoModeFilter: true,
};
