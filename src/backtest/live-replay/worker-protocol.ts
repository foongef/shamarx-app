/**
 * Wire protocol between LiveReplayService (parent) and replay-worker.ts (worker).
 *
 * All payloads must survive structuredClone — no class instances with methods,
 * no Date objects on hot paths (use ISO strings), no functions. Plain data only.
 */

import type { ReplayConfig, CandleBundle, ReplayResult } from './replay-engine';

// ─── Parent → Worker ──────────────────────────────────────────────────────

export type ParentMessage =
  | { type: 'run'; cfg: ReplayConfig; candles: CandleBundle };

// ─── Worker → Parent ──────────────────────────────────────────────────────

export type WorkerMessage =
  | { type: 'progress'; processed: number; total: number }
  | { type: 'done'; result: ReplayResult }
  | { type: 'error'; message: string; stack?: string };

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Extract a typed message — narrow the discriminated union by `type`. */
export function isWorkerMessage(v: unknown): v is WorkerMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in v &&
    typeof (v as { type: unknown }).type === 'string'
  );
}
