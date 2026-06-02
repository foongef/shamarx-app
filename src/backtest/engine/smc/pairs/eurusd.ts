/**
 * SMC config for EURUSD — TUNED v4 (TP1 restored + auto-mode filter).
 *
 * v3 (without TP1 leg) under-performed in honest backtest with HTF warmup
 * enabled — REVERSAL win rate dropped from 58% to 44% because EURUSD trades
 * often hit the small 0.8R partial but don't reach 3R. Removing TP1 turned
 * those banked partials into either SL hits or BE-stops on the runner.
 *
 * v4 keeps the auto-mode filter (correctly rejects most bad CONTINUATION
 * setups) but restores the TP1 partial — its real role is banking small
 * wins that offset commission drag, not commission-neutral dead weight.
 *
 * tp2R: 3.5 (back to original) — gives the runner room to capture the
 * occasional big EURUSD move; small 0.8R partial ensures we don't lose
 * everything if the runner stops at BE.
 */
import { SmcPairConfig } from '../types';

export const EURUSD_SMC_CONFIG: SmcPairConfig = {
  symbol: 'EURUSD',

  sweepBufferAtr: 0.25,
  slBufferAtrM15: 0.30,

  setupExpiryH1Bars: 12,
  atrSpikeLimit: 2.0,

  trendingD1Adx: 22,
  d1AdxFloor: 10,

  recentSwingLookbackH1: 32,
  slCooldownBars: 6,

  killzones: [
    [7, 11],
    [13, 17],
  ],

  // Restored TP1 partial — banks small offsetting wins on EURUSD's
  // tight-range trades. Runner target back to 3.5R.
  tp1PartialFraction: 0.30,
  tp1R: 0.8,
  tp2R: 3.5,

  // Auto-detect when CONTINUATION is safe vs unsafe based on live D1 health.
  autoModeFilter: true,

  // Step 4.2 — only fire sweeps at PDH/PDL anchor levels (forex retail
  // liquidity clusters at session-derived levels, not random swings).
  useAnchorSweeps: true,

  // Step 4.4 — post-sweep displacement filter. Originally 0.5×ATR; disabled
  // (0) after 2026-06-02 multi-variant replay showed the filter was net
  // negative under honest (no-look-ahead) evaluation. The filter previously
  // appeared profitable only because the look-ahead bias let it cherry-pick
  // confirmed displacement bars from the future. Without that cheat, the
  // filter just rejects equally-good setups and forces a 1h evaluation lag
  // that often pushes detection past killzone close. 12-month replay over
  // 2025-06→2026-06: dispAtr=0 vs dispAtr=0.5 gave +$898 vs +$140 at 1.5%
  // risk (across all pairs). EURUSD specifically regressed slightly under
  // dispAtr=0 (-$121 vs -$7) — flagged for separate review, but keeping
  // global setting consistent for now.
  anchorDisplacementAtr: 0,

  // Step 4.5 — sit out 15min windows around NFP/FOMC/CPI/ECB.
  newsBlackoutMinutes: 15,
};
