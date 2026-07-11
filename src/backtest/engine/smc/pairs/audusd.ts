/**
 * SMC config for AUDUSD — v1.3 R3 candidate. PRE-REGISTERED as a ZERO-TUNING
 * clone of the GBPUSD template (per-pair tuning of a candidate to make it
 * pass the gauntlet is exactly the selection bias R3 forbids). Only the
 * symbol differs. Aussie trades London+NY killzones like cable; if it can't
 * clear the gauntlet on the shared template, it doesn't ship.
 */
import { SmcPairConfig } from '../types';
import { GBPUSD_SMC_CONFIG } from './gbpusd';

export const AUDUSD_SMC_CONFIG: SmcPairConfig = {
  ...GBPUSD_SMC_CONFIG,
  symbol: 'AUDUSD',
};
