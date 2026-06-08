import { Inject, Injectable, Logger } from '@nestjs/common';
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

  constructor(
    @Inject('ORCHESTRATOR_FACTORY')
    private readonly factory: OrchestratorFactory,
  ) {}

  getOrCreate(accountId: string): LiveSmcOrchestrator {
    let inst = this.instances.get(accountId);
    if (inst) {
      // Cancel any pending eviction (toggle ON within grace period).
      const timer = this.evictTimers.get(accountId);
      if (timer) {
        clearTimeout(timer);
        this.evictTimers.delete(accountId);
      }
      return inst;
    }
    inst = this.factory();
    void inst.restoreFromRedis(accountId);
    this.instances.set(accountId, inst);
    return inst;
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
}
