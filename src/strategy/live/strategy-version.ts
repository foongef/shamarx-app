/**
 * GIDEON version marker — bump when the STRATEGY's live behavior changes
 * (entries, exits, sizing, gates), not for infra/plumbing work. The name
 * 'GIDEON' stamped on Trade.strategyName never changes (position-monitor
 * routes exits by it); this constant is the human-facing release number
 * surfaced in live/status and the decision log.
 *
 * History:
 *  1.0.0  Baseline GIDEON (ex V6-alt): H1 sweep + D1 bias, killzones,
 *         TP1 partial + runner trail, per-pair configs.
 *  1.0.1  2026-07-07 — shared-signal mode: ONE canonical brain per bar,
 *         per-account execution gates + proportional sizing (fixes
 *         opposite-trades drift between tenants). Signals unchanged.
 *  1.2.0  2026-07-12 — SETUP-QUALITY GATE live on all 4 pairs
 *         (maxSlSweepRatio 0.5): enter only when the structural stop is
 *         tight relative to the sweep candle. 10y evidence + all three
 *         true-replay windows passed (22-24: +$855 vs +$6 baseline;
 *         last-12mo: +$667/PF1.51 vs +$76; 24-26: equal net, PF 1.27,
 *         40% fewer trades). Skipped bars keep the setup pending →
 *         emergent retest entries. EURUSD stays enabled (profitable in
 *         every window under the gate).
 *  1.1.1  2026-07-09 — stale-pending guard: drop queued setups whose
 *         structure SL is no longer on the protective side of the current
 *         entry price (price overran the setup while pending). Fixes
 *         TRADING_BAD_STOPS limit rejections AND removes phantom
 *         instant-win entries from replays.
 *  1.1.0  2026-07-09 — RETRACE ENTRIES: broker-side LIMIT parked 50% of
 *         entry→SL back toward the sweep, 12-bar GTD expiry, lots ×2 for
 *         equal dollar risk. Hardened replay Jan5–Jul8: PF 1.42→2.63,
 *         +$944 vs +$290 on $1k @1.5%, zero losing months, lower DD.
 *         Kill-switch: RETRACE_ENTRY=false.
 */
export const GIDEON_VERSION = '1.2.0';
