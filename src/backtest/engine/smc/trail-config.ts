/**
 * V6-alt trail configurations.
 *
 * Two trail presets used by the position simulator:
 *   - SMC_TP1_TRAIL: tight trail for the small fast-partial leg (just take 0.8R)
 *   - SMC_RUNNER_TRAIL: looser trail for the runner (BE only at 1.5R; let it ride to 4R+)
 *
 * Kept pair-agnostic for now — these are universal "small partial + big runner"
 * mechanics. If a future pair needs different trail aggressiveness, fork these
 * into per-pair configs.
 */
import { RegimeTradeParams } from '../types';

export const SMC_TP1_TRAIL: RegimeTradeParams = {
  trendTpR: 0.8,
  fvgTpR: 0.8,
  beThresholdR: 0.6,
  tpRemovalR: 0,            // never remove TP1's TP — just take the partial
  slClampMaxAtr: 3.0,
};

export const SMC_RUNNER_TRAIL: RegimeTradeParams = {
  trendTpR: 4.0,
  fvgTpR: 0.8,
  beThresholdR: 1.5,        // BE only at 1.5R (don't kill runners)
  tpRemovalR: 3.0,          // remove TP at 3R, let trail capture beyond TP2
  slClampMaxAtr: 4.0,
};
