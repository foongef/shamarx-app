/**
 * Worker thread entrypoint for the live-replay engine.
 *
 * Runs on a separate OS thread so a long replay (2y × 4 pairs ≈ 280k M15
 * events) can use a 2nd CPU core without blocking the live-trading thread.
 * The parent (LiveReplayService) loads candles via Prisma, ships them in
 * via postMessage, and we ship results back the same way.
 *
 * Pure compute — does NOT import PrismaService, NestJS DI lifecycle, or
 * anything that opens a network/DB connection. The orchestrator class has
 * an @Injectable() decorator but no DI deps, so we instantiate it raw.
 */

import { parentPort } from 'node:worker_threads';
import { LiveSmcOrchestrator } from '../../strategy/live/live-smc-orchestrator';
import { LiveRangeOrchestrator } from '../../strategy/live/live-range-orchestrator';
import { ReplayEngine } from './replay-engine';
import type { ParentMessage, WorkerMessage } from './worker-protocol';

if (!parentPort) {
  // Defensive: this file should only ever run as a worker. If someone
  // imports it from the main thread it's a programmer error, fail loud.
  throw new Error('replay-worker must be loaded as a Worker thread');
}

const port = parentPort;

const send = (msg: WorkerMessage) => port.postMessage(msg);

port.on('message', async (msg: ParentMessage) => {
  if (msg.type !== 'run') {
    send({ type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
    return;
  }

  try {
    const orchestrator = new LiveSmcOrchestrator();
    // Range orchestrator instantiated unconditionally — its per-pair
    // configs default `enabled: false`, so without an explicit override
    // it's a no-op. Production replays don't enable range yet; the
    // comparison runner sets overrides in-process (different code path).
    const rangeOrchestrator = new LiveRangeOrchestrator();
    const engine = new ReplayEngine(orchestrator, rangeOrchestrator);
    const result = await engine.run(msg.cfg, msg.candles, (processed, total) => {
      send({ type: 'progress', processed, total });
    });
    send({ type: 'done', result });
  } catch (err) {
    const e = err as Error;
    send({ type: 'error', message: e.message, stack: e.stack });
  }
});
