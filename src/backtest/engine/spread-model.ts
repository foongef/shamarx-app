/**
 * Time-of-day spread model.
 * Spread varies by trading session — tighter during London/NY, wider during Asian/off-hours.
 * Reads per-symbol spreads from instrument config.
 */

import { getInstrumentConfig } from './instrument-config';

export function getSpread(symbol: string, openTime: string): number {
  const { spreads } = getInstrumentConfig(symbol);
  const hour = new Date(openTime).getUTCHours();

  // London-NY overlap: 12:00-15:59 UTC — highest volume, tightest spread
  if (hour >= 12 && hour <= 15) return spreads.londonNyOverlap;

  // London session: 07:00-11:59 UTC
  if (hour >= 7 && hour <= 11) return spreads.london;

  // NY extended: 16:00-17:59 UTC
  if (hour >= 16 && hour <= 17) return spreads.nyExtended;

  // Asian session: 22:00-06:59 UTC
  if (hour >= 22 || hour <= 6) return spreads.asian;

  // Off-hours (everything else: 18-21)
  return spreads.offHours;
}
