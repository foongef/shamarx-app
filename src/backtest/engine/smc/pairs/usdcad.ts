/**
 * SMC config for USDCAD — v1.3 R3 candidate. PRE-REGISTERED zero-tuning
 * clone of the GBPUSD template (see audusd.ts for the rationale). CAD's
 * liquidity is NY-centred but the template's London+NY killzones cover it;
 * no per-pair adjustment until/unless it ships and earns a tuning cycle.
 */
import { SmcPairConfig } from '../types';
import { GBPUSD_SMC_CONFIG } from './gbpusd';

export const USDCAD_SMC_CONFIG: SmcPairConfig = {
  ...GBPUSD_SMC_CONFIG,
  symbol: 'USDCAD',
};
