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
  // Iter 6/7 — raise the regime floor from 10 → 18. SMC sweeps need a real HTF
  // trend; below ADX 18 the tape is structurally chop and sweeps fail
  // systematically. General principle (not year-specific): no edge without
  // trend. Tested d1AdxFloor=14 in iter8 to get more trades — but 2023 went
  // from +11.7% → -12.8% (PF 0.54). The trade count comes from chop, not
  // edge. Keep at 18.
  d1AdxFloor: 18,

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

  // Iter 7 — scaling cap. With d1AdxFloor=18 the regime filter handles chop;
  // this filter handles the orthogonal problem: wide-SL setups have lower
  // win rate independent of trend. At small accounts the lot-floor naturally
  // selects against them; at $10k+ the floor never binds so they dilute the
  // edge. 2.0 (vs iter5's 1.5) is loose enough to keep 2023 $1k profitable
  // while still cutting the worst-quality $10k drag.
  maxSlAtrM15: 2.0,

  // Auto-detect when CONTINUATION is structurally safe (ADX rising, EMA stack
  // aligned, not over-extended). Gold trends usually pass — but during
  // exhausted moves or news spikes, the filter blocks bad CONTINUATION setups.
  autoModeFilter: true,

  // Step 4.x — anchor-sweep filter. Use Previous Day High/Low + Asian Range
  // as the only valid sweep targets, instead of any recent H1 swing. Gold's
  // intra-day chop produces lots of generic swings that aren't real liquidity
  // grabs; anchor levels are where the actual stops cluster. Live-replay
  // showed 7 TP exits / 123 SL exits without this filter — the SL bias was
  // from low-quality sweeps. Mirrors what the other 3 pairs already do.
  useAnchorSweeps: true,

  // Require the H1 bar AFTER the sweep to displace ≥ 0.5 × ATR in the trade
  // direction. Filters chop where the wick happens but no real momentum
  // follows. 0.5 matches EURUSD/GBPUSD/USDJPY tuning.
  anchorDisplacementAtr: 0.5,
};
