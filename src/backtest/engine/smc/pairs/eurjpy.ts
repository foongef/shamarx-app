/**
 * SMC config for EURJPY — v1.3 R3 candidate. PRE-REGISTERED zero-tuning
 * clone of the USDJPY template (JPY-quote pip semantics + Tokyo killzone).
 */
import { SmcPairConfig } from '../types';
import { USDJPY_SMC_CONFIG } from './usdjpy';

export const EURJPY_SMC_CONFIG: SmcPairConfig = {
  ...USDJPY_SMC_CONFIG,
  symbol: 'EURJPY',
};
