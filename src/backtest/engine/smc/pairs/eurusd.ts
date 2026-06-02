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

  // Step 4.4 — post-sweep displacement filter. Per-pair carve-out: EURUSD
  // is the ONLY pair that regresses when this filter is disabled.
  // 12-month replay (2025-06 → 2026-06, $1k @ 1.5%):
  //   dispAtr=0:    -$123 (48.2% WR over 114 trades) ← below 50% WR
  //   dispAtr=0.5:  -$7   (56.0% WR over 108 trades) ← near-break-even
  // Removing the filter for EURUSD turns a marginal pair into a net
  // drag. Hypothesis: EURUSD's typical sweep size is closer to noise
  // floor, so the post-sweep momentum confirmation is genuinely earning
  // its keep here (unlike XAUUSD/GBPUSD/USDJPY where it was net-negative).
  // The other 3 pairs keep dispAtr=0 — see PR #28 for full rationale.
  anchorDisplacementAtr: 0.5,

  // Step 4.5 — sit out 15min windows around NFP/FOMC/CPI/ECB.
  newsBlackoutMinutes: 15,
};
