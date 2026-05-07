/**
 * Smoke test for the replay worker thread boundary.
 *
 * Spawns the compiled replay-worker.js, sends a minimal 'run' message with
 * synthetic candles, and asserts a 'done' or 'error' message comes back.
 * Confirms the worker boots, imports cleanly, and the message protocol
 * round-trips without DB or NestJS DI.
 *
 * Not a correctness test — just a "can the wires carry electricity" check.
 */
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { CandleBundle, ReplayConfig } from '../src/backtest/live-replay/replay-engine';
import type { ParentMessage, WorkerMessage } from '../src/backtest/live-replay/worker-protocol';

function makeSyntheticCandles(symbol: string, count: number, startMs: number, intervalMs: number) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const open = 1.1 + Math.sin(i / 50) * 0.02;
    out.push({
      symbol,
      timeframe: 'M15',
      openTime: new Date(startMs + i * intervalMs).toISOString(),
      open,
      high: open + 0.001,
      low: open - 0.001,
      close: open + 0.0005,
      volume: 100,
    });
  }
  return out;
}

async function main() {
  const workerPath = path.resolve(__dirname, '..', 'dist', 'src', 'backtest', 'live-replay', 'replay-worker.js');
  console.log('Spawning worker:', workerPath);

  const worker = new Worker(workerPath);
  const startMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Synthetic 30-day window of 4 pairs × M15+H1+D1. Tiny enough to finish in
  // milliseconds — we only care that the worker boots and replies.
  const candles: CandleBundle = {} as CandleBundle;
  for (const sym of ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY']) {
    candles[sym] = {
      m15: makeSyntheticCandles(sym, 2880, startMs, 15 * 60 * 1000),
      h1: makeSyntheticCandles(sym, 720, startMs, 60 * 60 * 1000),
      d1: makeSyntheticCandles(sym, 30, startMs, 24 * 60 * 60 * 1000),
    };
  }

  const cfg: ReplayConfig = {
    startDate: new Date(startMs).toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    initialBalance: 10000,
    riskPercent: 1,
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  };

  const result = await new Promise<WorkerMessage>((resolve, reject) => {
    const t = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error('Smoke timed out after 30s'));
    }, 30_000);

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'progress') {
        console.log(`progress: ${msg.processed}/${msg.total}`);
        return;
      }
      clearTimeout(t);
      resolve(msg);
    });
    worker.on('error', (e) => { clearTimeout(t); reject(e); });
    worker.on('exit', (code) => {
      if (code !== 0) { clearTimeout(t); reject(new Error(`worker exit ${code}`)); }
    });

    const start: ParentMessage = { type: 'run', cfg, candles };
    worker.postMessage(start);
  });

  await worker.terminate();

  if (result.type === 'done') {
    console.log('✓ worker completed:', JSON.stringify(result.result.metrics, null, 2));
    process.exit(0);
  } else if (result.type === 'error') {
    console.error('✗ worker errored:', result.message);
    if (result.stack) console.error(result.stack);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
