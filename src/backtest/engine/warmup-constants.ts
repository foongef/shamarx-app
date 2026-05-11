/**
 * Centralised warmup window for all REPLAY / BACKTEST paths.
 *
 * The strategy reads D1 EMA50 + D1 ADX(14) as the bias / regime gate.
 * `technicalindicators` seeds EMA-N with SMA-N of the first N closes, so
 * the first 50 D1 bars feed the seed and the indicator is materially
 * distorted until well after the seed weight decays. Empirically we
 * confirmed that at 90 calendar days of preload, two replays over the
 * SAME date window can produce different trades when their `startDate`
 * is positioned differently — the bias gate flips at marginal cases.
 *
 * At 220 days (~150 D1 trading bars), the EMA-50 has fully converged
 * (residual seed-distortion < 1%) and replays are deterministic regardless
 * of how far before the user window we set `htfStart`.
 *
 * NOTE: live trading does NOT consume this constant. Live's per-evaluation
 * fetch uses fixed-size rolling buffers (M15=100, H1=500, D1=400) which
 * always contain hundreds of bars of warmup. This file exists solely for
 * the replay/backtest callers below — touching it changes only those
 * paths.
 *
 * Callers (kept in sync via import; do not redefine locally):
 *   - src/backtest/backtest.service.ts          (POST /api/backtest)
 *   - src/backtest/live-replay/live-replay.service.ts  (POST /api/live-replay)
 *   - scripts/compare-smc-gates.ts              (gate-validation runner)
 *   - scripts/run-live-replay.ts                (standalone CLI replay)
 *   - scripts/run-baseline.ts                   (28-month baseline harness)
 *   - scripts/single-cell.ts                    (one-pair quick check)
 *
 * Bumping this value invalidates any prior replay/backtest results that
 * were computed under a different warmup. Re-run the canonical baseline
 * after changing it.
 */
export const HTF_WARMUP_DAYS = 220;
