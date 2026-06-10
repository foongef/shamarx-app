import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LiveSmcOrchestrator } from './live-smc-orchestrator';

const EVICT_AFTER_MS = 5 * 60_000;

export type OrchestratorFactory = () => LiveSmcOrchestrator;

/**
 * Per-account orchestrator registry. The orchestrator holds per-pair
 * pending queues, RiskManager state, cooldowns. Each enabled account
 * gets its own instance, lazy-initialized on first access. Disabling
 * an account persists final snapshot to Redis then evicts after a
 * 5-minute grace period (catches toggle-bounce without losing state).
 */
@Injectable()
export class LiveSmcOrchestratorRegistry {
  private readonly logger = new Logger(LiveSmcOrchestratorRegistry.name);
  private readonly instances = new Map<string, LiveSmcOrchestrator>();
  private readonly evictTimers = new Map<string, NodeJS.Timeout>();
  private readonly creating = new Map<string, Promise<LiveSmcOrchestrator>>();

  constructor(
    @Inject('ORCHESTRATOR_FACTORY')
    private readonly factory: OrchestratorFactory,
  ) {}

  /**
   * Restore is AWAITED before the instance is returned. The previous
   * fire-and-forget restore meant the first evaluate() after a restart ran
   * against an empty actionedSweeps set — re-actioning sweeps that were
   * already traded. Prod evidence (2026-06-03..08): the same USDJPY sweep
   * entered 8 times across a deploy-heavy week.
   *
   * Concurrent first calls for the same account share one in-flight
   * creation promise so we never construct two instances racing to restore.
   */
  async getOrCreate(accountId: string): Promise<LiveSmcOrchestrator> {
    const existing = this.instances.get(accountId);
    if (existing) {
      // Cancel any pending eviction (toggle ON within grace period).
      const timer = this.evictTimers.get(accountId);
      if (timer) {
        clearTimeout(timer);
        this.evictTimers.delete(accountId);
      }
      return existing;
    }

    const inFlight = this.creating.get(accountId);
    if (inFlight) return inFlight;

    const creation = (async () => {
      const inst = this.factory();
      try {
        await inst.restoreFromRedis(accountId);
      } catch (err) {
        // Restore failure is survivable (fresh state) but must be loud —
        // it means dedup/cooldown state was lost.
        this.logger.error(
          `getOrCreate: restore failed for account=${accountId}, starting fresh: ${(err as Error).message}`,
        );
      }
      this.instances.set(accountId, inst);
      return inst;
    })();
    this.creating.set(accountId, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(accountId);
    }
  }

  async removeIfDisabled(accountId: string): Promise<void> {
    const inst = this.instances.get(accountId);
    if (!inst) return;
    await inst.persistToRedis(accountId);
    const timer = setTimeout(() => {
      this.instances.delete(accountId);
      this.evictTimers.delete(accountId);
      this.logger.log(`Evicted orchestrator instance for account=${accountId}`);
    }, EVICT_AFTER_MS);
    this.evictTimers.set(accountId, timer);
  }

  /**
   * Persist every in-memory orchestrator to its account-scoped Redis key.
   *
   * Returns the count of accounts persisted so the caller (and tests)
   * can verify the loop iterated. Failures on individual accounts are
   * isolated — one bad account doesn't block the others.
   *
   * Accounts that haven't been touched since the last persist still get
   * re-written. That's intentional: the cost is small (one Redis SET per
   * account) and it keeps the read path simple — `restoreFromRedis` only
   * has to look at the suffixed key, never the legacy unsuffixed one.
   */
  async persistAll(): Promise<number> {
    const entries = Array.from(this.instances.entries());
    let persisted = 0;
    for (const [accountId, inst] of entries) {
      try {
        await inst.persistToRedis(accountId);
        persisted++;
      } catch (err) {
        this.logger.warn(
          `persistAll: failed for account=${accountId}: ${(err as Error).message}`,
        );
      }
    }
    return persisted;
  }

  /**
   * 5-minute periodic persistence. Runs in-process via @nestjs/schedule.
   *
   * Rationale: per-account orchestrator state (pending queues, cooldowns,
   * RiskManager) lives only in memory between `getOrCreate` and the
   * eventual `removeIfDisabled`. Without this cron, a hard restart
   * (container kill, OOM, deploy) wipes that state and every enabled
   * account resets — losing actionedSweeps dedup, daily-loss counters,
   * and cooldown timers. Cheap to write; expensive to lose.
   *
   * The interval is tunable via the @Cron expression; 5 min is chosen
   * because:
   *   - Per-account state mutates at most once per M15 (~every 15 min)
   *   - On a worst-case crash, we lose ≤ 5 min of state per account
   *   - 5 min × N accounts × 1 SET = trivial Redis load
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async persistAllScheduled(): Promise<void> {
    if (this.instances.size === 0) return;
    const count = await this.persistAll();
    this.logger.debug(`persistAllScheduled: persisted ${count} orchestrator(s)`);
  }
}
