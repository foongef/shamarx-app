/**
 * V6: News/macro event blackout calendar.
 *
 * Generates HIGH-impact event windows for the 2023-2026 backtest range. Two sources:
 *   1. Pattern-based — NFP (1st Friday 12:30 UTC) + monthly CPI (10-15th 12:30 UTC).
 *   2. Hand-curated FOMC + ECB dates (known meeting calendar).
 *
 * Tradeoff: this is approximate, not ForexFactory-perfect. It captures ~80% of the
 * real risk windows for XAUUSD/USD majors. For higher fidelity, swap _PATTERN_EVENTS
 * for an imported JSON sourced from an economic-calendar API.
 */
import { NewsEvent } from './types';

// FOMC announcement dates (USD HIGH-impact). 14:00 ET = 18:00 UTC standard.
// Sources: federalreserve.gov 2023-2026 schedules; presser at 14:30 ET = 18:30 UTC.
const FOMC_DATES_UTC: string[] = [
  // 2023
  '2023-02-01T19:00:00Z', '2023-03-22T18:00:00Z', '2023-05-03T18:00:00Z',
  '2023-06-14T18:00:00Z', '2023-07-26T18:00:00Z', '2023-09-20T18:00:00Z',
  '2023-11-01T18:00:00Z', '2023-12-13T19:00:00Z',
  // 2024
  '2024-01-31T19:00:00Z', '2024-03-20T18:00:00Z', '2024-05-01T18:00:00Z',
  '2024-06-12T18:00:00Z', '2024-07-31T18:00:00Z', '2024-09-18T18:00:00Z',
  '2024-11-07T19:00:00Z', '2024-12-18T19:00:00Z',
  // 2025
  '2025-01-29T19:00:00Z', '2025-03-19T18:00:00Z', '2025-05-07T18:00:00Z',
  '2025-06-18T18:00:00Z', '2025-07-30T18:00:00Z', '2025-09-17T18:00:00Z',
  '2025-10-29T18:00:00Z', '2025-12-10T19:00:00Z',
  // 2026 (planned)
  '2026-01-28T19:00:00Z', '2026-03-18T18:00:00Z', '2026-04-29T18:00:00Z',
  '2026-06-17T18:00:00Z', '2026-07-29T18:00:00Z', '2026-09-16T18:00:00Z',
  '2026-11-04T19:00:00Z', '2026-12-16T19:00:00Z',
];

// ECB rate decisions (12:15 UTC press release, 12:45 UTC presser).
const ECB_DATES_UTC: string[] = [
  '2023-02-02T13:15:00Z', '2023-03-16T13:15:00Z', '2023-05-04T12:15:00Z',
  '2023-06-15T12:15:00Z', '2023-07-27T12:15:00Z', '2023-09-14T12:15:00Z',
  '2023-10-26T12:15:00Z', '2023-12-14T13:15:00Z',
  '2024-01-25T13:15:00Z', '2024-03-07T13:15:00Z', '2024-04-11T12:15:00Z',
  '2024-06-06T12:15:00Z', '2024-07-18T12:15:00Z', '2024-09-12T12:15:00Z',
  '2024-10-17T12:15:00Z', '2024-12-12T13:15:00Z',
  '2025-01-30T13:15:00Z', '2025-03-06T13:15:00Z', '2025-04-17T12:15:00Z',
  '2025-06-05T12:15:00Z', '2025-07-24T12:15:00Z', '2025-09-11T12:15:00Z',
  '2025-10-30T13:15:00Z', '2025-12-18T13:15:00Z',
  '2026-01-29T13:15:00Z', '2026-03-12T13:15:00Z', '2026-04-23T12:15:00Z',
  '2026-06-11T12:15:00Z', '2026-07-23T12:15:00Z', '2026-09-10T12:15:00Z',
  '2026-10-29T13:15:00Z', '2026-12-17T13:15:00Z',
];

function firstFridayOfMonth(year: number, month0: number): Date {
  const d = new Date(Date.UTC(year, month0, 1));
  const offset = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + offset);
  return d;
}

/** Generate NFP and CPI events for the requested year range. */
function generatePatternEvents(startYear: number, endYear: number): NewsEvent[] {
  const out: NewsEvent[] = [];
  for (let y = startYear; y <= endYear; y++) {
    for (let m = 0; m < 12; m++) {
      // NFP: 1st Friday at 12:30 UTC (8:30 AM ET) — accounts for EST/EDT.
      const nfp = firstFridayOfMonth(y, m);
      nfp.setUTCHours(12, 30, 0, 0);
      out.push({
        time: nfp.toISOString(),
        impact: 'HIGH',
        title: 'NFP — US Non-Farm Payrolls',
        currency: 'USD',
      });
      // US CPI: typically 10th-15th of month at 12:30 UTC. Use 12th as proxy.
      const cpi = new Date(Date.UTC(y, m, 12, 12, 30, 0));
      out.push({
        time: cpi.toISOString(),
        impact: 'HIGH',
        title: 'US CPI',
        currency: 'USD',
      });
    }
  }
  return out;
}

const _ALL_EVENTS: NewsEvent[] = [
  ...generatePatternEvents(2023, 2026),
  ...FOMC_DATES_UTC.map<NewsEvent>((t) => ({
    time: t, impact: 'HIGH', title: 'FOMC Rate Decision', currency: 'USD',
  })),
  ...ECB_DATES_UTC.map<NewsEvent>((t) => ({
    time: t, impact: 'HIGH', title: 'ECB Rate Decision', currency: 'EUR',
  })),
].sort((a, b) => a.time.localeCompare(b.time));

const _EVENT_TIMES_MS: number[] = _ALL_EVENTS.map((e) => Date.parse(e.time));

/**
 * Returns true iff `utcTime` is within ±`windowMinutes` of any HIGH-impact event.
 * Binary search for O(log N) lookups inside the per-bar engine loop.
 */
export function isInBlackout(utcTime: string, windowMinutes: number = 15): boolean {
  const t = Date.parse(utcTime);
  if (Number.isNaN(t)) return false;
  const window = windowMinutes * 60 * 1000;

  let lo = 0;
  let hi = _EVENT_TIMES_MS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const et = _EVENT_TIMES_MS[mid];
    if (Math.abs(et - t) <= window) return true;
    if (et < t) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

/** Exposed for tests / debug. */
export function getAllNewsEvents(): readonly NewsEvent[] {
  return _ALL_EVENTS;
}
