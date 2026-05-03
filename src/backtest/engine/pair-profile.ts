/**
 * V6: Per-pair behavioral profile.
 *
 * Extends InstrumentConfig (which carries spread/lot/precision) with strategy-level
 * tuning that varies across instruments: trading sessions, ATR percentiles,
 * which engines to enable, news/D1 confluence behavior.
 *
 * Adding a new pair = drop a profile object into PAIR_PROFILES + add the matching
 * InstrumentConfig in instrument-config.ts.
 */
import { InstrumentConfig, getInstrumentConfig } from './instrument-config';

export interface PairProfile {
  symbol: string;
  instrument: InstrumentConfig;

  // Trading sessions in UTC hours (start inclusive, end exclusive).
  sessions: {
    london: [number, number];
    ny: [number, number];
    overlap: [number, number]; // London-NY overlap; tightest spreads
    asian?: [number, number];   // Optional — most pairs skip Asian
  };

  // Pre-computed ATR(14) H1 percentiles from a representative training window
  // (XAUUSD: 2024 calendar year). Used to classify VolatilityRegime.
  baselineAtr: {
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  };

  // Toggle which entry engines run. V6 disables RANGE_ENGINE in favor of BB_REVERSAL.
  engineToggles: {
    trendPullback: boolean;
    fvgFill: boolean;
    rangeReversion: boolean; // legacy V5.5b RANGE_ENGINE
    bbReversal: boolean;     // V6 replacement
  };

  // V6 confluence + filter knobs
  d1ConfluenceRequired: boolean;
  newsBlackoutEnabled: boolean;
  newsBlackoutMinutes: number;     // ± minutes around HIGH-impact events
  chandelierAtrMult: number;       // ATR multiplier for chandelier trail
  qualityFloor: number;            // min quality score to take a trade
  maxLotSize: number;              // safety cap; forex usually 2.0, gold 1.0
}

const XAUUSD_CONFIG = getInstrumentConfig('XAUUSD');
const EURUSD_CONFIG = getInstrumentConfig('EURUSD');

export const PAIR_PROFILES: Record<string, PairProfile> = {
  // V6 profile — fixes the 2025 weakness via D1 confluence + BB reversal + news blackout.
  XAUUSD: {
    symbol: 'XAUUSD',
    instrument: XAUUSD_CONFIG,
    sessions: {
      london:  [7, 12],
      overlap: [12, 16],
      ny:      [16, 20],
    },
    // ATR(14) on H1 from XAUUSD 2024 distribution. These get refined after the
    // first full-year backtest on the new Dukascopy data.
    baselineAtr: { p25: 1.8, p50: 2.6, p75: 3.8, p90: 5.5 },
    engineToggles: {
      trendPullback:  true,
      fvgFill:        true,
      // V6 keeps both range engines: BB Reversal as primary (mean-reversion at extremes),
      // legacy Range as fallback when BB doesn't trigger. The two have different signal
      // shapes — BB needs RSI extreme + reversal candle, Range needs EMA50 band tag.
      rangeReversion: true,
      bbReversal:     true,
    },
    d1ConfluenceRequired: true,
    newsBlackoutEnabled:  true,
    newsBlackoutMinutes:  5,
    chandelierAtrMult:    2.5,
    qualityFloor:         30,
    maxLotSize:           1.0,
  },

  // V6 profile for EURUSD — initial scaffold using XAUUSD-derived defaults.
  // Will need tuning after first matrix run; baselineAtr in pip-equivalent
  // (EURUSD ATR(14) on H1 typically 0.0008-0.0020 in pip space ≈ 8-20 pips).
  EURUSD: {
    symbol: 'EURUSD',
    instrument: EURUSD_CONFIG,
    sessions: {
      london:  [7, 12],
      overlap: [12, 16],
      ny:      [16, 20],
    },
    // Pre-computed from EURUSD H1 ATR(14) distribution; rough scaffold
    baselineAtr: { p25: 0.0008, p50: 0.0012, p75: 0.0018, p90: 0.0028 },
    engineToggles: {
      trendPullback:  true,
      fvgFill:        true,
      rangeReversion: true,
      bbReversal:     true,
    },
    d1ConfluenceRequired: true,
    newsBlackoutEnabled:  true,
    newsBlackoutMinutes:  5,
    chandelierAtrMult:    2.5,
    qualityFloor:         30,
    maxLotSize:           2.0,
  },
};

/**
 * Returns the V6 PairProfile for a symbol, or `null` if no profile is defined
 * (caller should fall back to legacy V5.5b behavior in that case).
 */
export function getPairProfile(symbol: string): PairProfile | null {
  return PAIR_PROFILES[symbol] ?? null;
}

/** Active session at the given UTC time, or null if outside all configured sessions. */
export function getActiveSession(
  profile: PairProfile,
  utcHour: number,
): 'london' | 'ny' | 'overlap' | 'asian' | null {
  const within = (range: [number, number]) => utcHour >= range[0] && utcHour < range[1];
  if (within(profile.sessions.overlap)) return 'overlap';
  if (within(profile.sessions.london)) return 'london';
  if (within(profile.sessions.ny)) return 'ny';
  if (profile.sessions.asian && within(profile.sessions.asian)) return 'asian';
  return null;
}
