/**
 * Time-of-day spread model for XAUUSD.
 * Spread varies by trading session — tighter during London/NY, wider during Asian/off-hours.
 */

/** Spread in points (dollars per oz) */
export function getSpread(openTime: string): number {
  const hour = new Date(openTime).getUTCHours();

  // London session: 07:00-10:59 UTC
  if (hour >= 7 && hour <= 10) return 0.25;

  // NY session: 13:00-15:59 UTC
  if (hour >= 13 && hour <= 15) return 0.25;

  // Asian session: 22:00-06:59 UTC
  if (hour >= 22 || hour <= 6) return 0.50;

  // Off-hours (everything else: 11-12, 16-21)
  return 0.40;
}
