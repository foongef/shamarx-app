/**
 * DecisionLogService — records one row per orchestrator evaluation so
 * live-vs-replay divergence becomes a diff instead of a mystery.
 *
 * Live rows are buffered and flushed in batches (a write per M15 bar per
 * pair per account would be needless write amplification); replay rows are
 * inserted in bulk by the replay service. Rows older than 45 days are
 * pruned nightly.
 *
 * Parity diff (first divergent bar):
 *   SELECT l."barTime", l.symbol, l.decision AS live, r.decision AS replay
 *   FROM "DecisionLog" l
 *   JOIN "DecisionLog" r ON r.symbol = l.symbol AND r."barTime" = l."barTime"
 *     AND r.source = 'replay' AND r."replaySessionId" = $1
 *   WHERE l.source = 'live' AND l."accountId" = $2 AND l.decision <> r.decision
 *   ORDER BY l."barTime" LIMIT 20;
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@app/prisma';

export interface DecisionRecord {
  source: 'live' | 'replay';
  accountId?: string | null;
  replaySessionId?: string | null;
  symbol: string;
  barTime: Date;
  decision: string;
  signalSide?: string | null;
  context?: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 50;
const RETENTION_DAYS = 45;

@Injectable()
export class DecisionLogService implements OnModuleDestroy {
  private readonly logger = new Logger(DecisionLogService.name);
  private buffer: DecisionRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Fire-and-forget: never let logging break an evaluation. */
  record(rec: DecisionRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length >= FLUSH_THRESHOLD) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      // Don't hold the process open just for pending log rows.
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.prisma.decisionLog.createMany({
        data: batch.map((r) => ({
          source: r.source,
          accountId: r.accountId ?? null,
          replaySessionId: r.replaySessionId ?? null,
          symbol: r.symbol,
          barTime: r.barTime,
          decision: r.decision,
          signalSide: r.signalSide ?? null,
          context: (r.context ?? {}) as object,
        })),
      });
    } catch (err) {
      // Telemetry only — drop the batch rather than block trading or grow
      // the buffer unboundedly during a DB outage.
      this.logger.warn(
        `decision-log flush dropped ${batch.length} rows: ${(err as Error).message}`,
      );
    }
  }

  /** Bulk insert for replay runs — called once per chunk by the replay service. */
  async recordBatch(recs: DecisionRecord[]): Promise<number> {
    if (recs.length === 0) return 0;
    const res = await this.prisma.decisionLog.createMany({
      data: recs.map((r) => ({
        source: r.source,
        accountId: r.accountId ?? null,
        replaySessionId: r.replaySessionId ?? null,
        symbol: r.symbol,
        barTime: r.barTime,
        decision: r.decision,
        signalSide: r.signalSide ?? null,
        context: (r.context ?? {}) as object,
      })),
    });
    return res.count;
  }

  @Cron('0 20 3 * * *') // daily 03:20 UTC
  async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);
    try {
      const res = await this.prisma.decisionLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (res.count > 0) {
        this.logger.log(`pruned ${res.count} decision-log rows older than ${RETENTION_DAYS}d`);
      }
    } catch (err) {
      this.logger.warn(`decision-log prune failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
