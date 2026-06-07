/**
 * Snapshot of market + portfolio state at signal-fire time.
 * Stored as JSON in JournalEntry.entryContext. All numbers are absolute
 * (not deltas) so old rows stay interpretable without context.
 */
export interface JournalEntryContext {
  evalTime: string;
  d1Adx: number;
  d1Bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  h1Atr: number;
  killzone: 'LONDON' | 'NY' | 'ASIAN' | null;
  pendingQueueSize: number;
  spread: number;
  accountEquity: number;
  openPositionsCount: number;
  openDirectionsForSymbol: Array<'BUY' | 'SELL'>;
  anchorLevel: number | null;
  anchorType: AnchorType | null;
  source?: 'backfill';
}

/**
 * Snapshot of trade exit. Populated when PositionMonitor transitions a
 * Trade to CLOSED. `mfeMaePips` is null when we can't load the relevant
 * M15 candles (rare; should not block close).
 */
export interface JournalExitContext {
  closedAt: string;
  exitReason: 'TP' | 'SL' | 'BREAKEVEN' | 'FORCED_CLOSE';
  holdMinutes: number;
  exitPrice: number;
  mfeMaePips: { mfe: number; mae: number } | null;
  trailedSlAtClose: number;
  originalSlPrice: number | null;
  beActivated: boolean;
  source?: 'backfill';
}

export type JournalOutcome = 'WIN' | 'LOSS' | 'BE' | 'FORCED_CLOSE';

export type AnchorType =
  | 'PDH'
  | 'PDL'
  | 'ASIAN_H'
  | 'ASIAN_L'
  | 'WEEKLY_H'
  | 'WEEKLY_L';

/** Predefined tag suggestions shown as colored chips in the UI.
 *  Custom tags also persist as plain strings; this list is just the
 *  default surface area. */
export const CANONICAL_JOURNAL_TAGS = [
  'News spike',
  'Bad regime',
  'SL too tight',
  'Wrong mode',
  'Setup looked good',
  'Late entry',
] as const;
export type CanonicalJournalTag = typeof CANONICAL_JOURNAL_TAGS[number];
