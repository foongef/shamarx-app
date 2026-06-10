/**
 * LIVE strategy service — runs V6-alt SMC evaluation on each M15 candle close
 * and places orders via execution-service.
 *
 * Activates ONLY when LIVE_MODE=true. The legacy BOS evaluator in
 * `strategy.service.ts` continues to exist (not invoked) for backward compat.
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { Timeframe, SERVICE_URLS, CandleDto } from '@app/common';
import {
  SmcLiveEvaluator,
  SmcLiveSignal,
  SmcLiveSignalLeg,
  LiveEvaluationContext,
} from './smc-live-evaluator';
import { LiveSmcOrchestrator } from './live-smc-orchestrator';
import { LiveControlService } from './live-control.service';
import { BacktestCandle } from '../../backtest/engine/types';
import { MailService, TradeOpenedPayload } from '../../mail/mail.service';
import { JournalService } from '../../journal/journal.service';
import { BrokerAccountsService } from '../../broker-accounts/broker-accounts.service';
import { BrokerHttpClient } from './broker-http-client';
import { LiveSmcOrchestratorRegistry } from './live-smc-orchestrator-registry';
import { getPreset, StrategyPreset } from '../presets';
import type { BrokerAccount, User } from '@prisma/client';

type BrokerAccountWithUser = BrokerAccount & { user: User };

const M15_BUFFER = 100;
const H1_BUFFER = 500;
const D1_BUFFER = 400;
/** Bar duration per timeframe — used by fetchCandles to filter out the
 *  currently-open trailing bar that MetaApi includes in /candles responses. */
const TIMEFRAME_DURATION_MS: Record<string, number> = {
  M15: 15 * 60 * 1000,
  H1: 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
  D1: 24 * 60 * 60 * 1000,
};
const ORCHESTRATOR_STATE_KEY = 'live:orchestrator:state';
/** Telemetry feed (events ring + per-pair lastEval + UTC counters) — persisted
 *  so the dashboard Engine Worker view survives container restarts. Tied to
 *  the same debounced-flush scheduler as the orchestrator state. */
const TELEMETRY_FEED_KEY = 'live:telemetry:feed';

const TELEMETRY_RING_SIZE = 200;

/** Debounce window for orchestrator-state persistence. 4 pairs evaluating at
 *  the same M15 boundary mark dirty within ~50ms of each other; coalescing
 *  them into one Redis write keeps the write rate at ~16/hour instead of ~64. */
const PERSIST_DEBOUNCE_MS = 500;

/** Periodic safety-net interval. Catches mutations that don't go through
 *  evaluatePair() (e.g. position-monitor's recordExit when broker closes a
 *  position) without coupling those callers to the persistence path. Worst-
 *  case state-loss window on a hard crash = this value. */
const PERSIST_INTERVAL_MS = 30_000;

/** Telemetry event captured for the dashboard's Engine Worker view.
 *  Stored in an in-memory ring buffer — not persisted, lost on restart.
 *  Persistence isn't worth the write traffic; the dashboard is fine
 *  with "since last restart" history. */
export type TelemetryEvent =
  | { ts: string; symbol: string; type: 'eval'; decision: 'no-sweep' | 'pending-only' | 'cooldown' }
  | { ts: string; symbol: string; type: 'sweep-detected'; direction: 'BUY' | 'SELL'; mode: string; entryHint: number }
  | { ts: string; symbol: string; type: 'signal-fired'; side: 'BUY' | 'SELL'; mode: string; entryPrice: number };

@Injectable()
export class LiveStrategyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveStrategyService.name);
  private readonly liveMode: boolean;
  private readonly pairs: string[];
  private readonly evaluator: SmcLiveEvaluator;
  private subscribed = false;

  /** Sweep timestamps already actioned this session per symbol — prevents double-entry */
  private actionedSweeps = new Map<string, Set<string>>();

  /** Ring buffer of recent telemetry events for the dashboard Engine Worker view.
   *  Capped at TELEMETRY_RING_SIZE to keep memory bounded; oldest events drop. */
  private events: TelemetryEvent[] = [];

  /** Per-pair last-evaluation snapshot — small map, dashboard reads this for
   *  the pair scanner strip's "X seconds ago" badges. */
  private lastEval = new Map<string, { ts: string; decision: 'no-sweep' | 'pending-only' | 'cooldown' }>();

  /** UTC-day-keyed counters. Reset lazily on the first event of a new day. */
  private counters = { date: '', evals: 0, sweeps: 0, signals: 0 };

  // ─── Persistence scheduler ────────────────────────────────────────────
  // Pattern:
  //   - markPersistDirty(): dirty flag + 500ms debounce → coalesces bursts
  //   - PERSIST_INTERVAL_MS interval: backstop, catches mutations from
  //     anywhere (e.g. position-monitor.recordExit) without the caller
  //     having to know about persistence
  //   - flushOrchestratorState(): idempotent, in-flight guarded, retries
  //     on failure (re-marks dirty)
  //   - onModuleDestroy: clears timers + final await flush

  private persistDirty = false;
  private persistDebounceTimer: NodeJS.Timeout | null = null;
  private persistIntervalTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;

  private get fanOutEnabled(): boolean {
    return (this.config.get<string>('ENABLE_MULTI_ACCOUNT_FANOUT') || 'false').toLowerCase() === 'true';
  }

  private markPersistDirty(): void {
    this.persistDirty = true;
    if (this.persistDebounceTimer) return;
    this.persistDebounceTimer = setTimeout(() => {
      this.persistDebounceTimer = null;
      this.flushOrchestratorState().catch(() => { /* logged inside */ });
    }, PERSIST_DEBOUNCE_MS);
  }

  private async flushOrchestratorState(): Promise<void> {
    if (!this.persistDirty || this.persistInFlight) return;
    this.persistInFlight = true;
    this.persistDirty = false; // optimistic — re-marked on failure
    try {
      const snapshot = this.orchestrator.serialize();
      await this.redis.set(ORCHESTRATOR_STATE_KEY, JSON.stringify(snapshot));
      // Persist the dashboard telemetry feed alongside strategy state — both
      // are touched on every evaluatePair, so coalescing into the same flush
      // is free. Restored on onModuleInit so the Engine Worker view doesn't
      // empty out after a deploy.
      const feed = {
        events: this.events,
        lastEval: Array.from(this.lastEval.entries()),
        counters: this.counters,
      };
      await this.redis.set(TELEMETRY_FEED_KEY, JSON.stringify(feed));
    } catch (err) {
      // Re-mark so the next debounce / interval / shutdown retries the write.
      // We never lose a mutation — at worst we're delayed by the interval.
      this.persistDirty = true;
      this.logger.warn(`Could not persist orchestrator state: ${(err as Error).message}`);
    } finally {
      this.persistInFlight = false;
    }
  }

  private pushEvent(ev: TelemetryEvent) {
    // Roll counters at UTC midnight — not exact but close enough for a UI badge.
    const today = ev.ts.slice(0, 10);
    if (this.counters.date !== today) {
      this.counters = { date: today, evals: 0, sweeps: 0, signals: 0 };
    }
    if (ev.type === 'eval') {
      this.counters.evals++;
      this.lastEval.set(ev.symbol, { ts: ev.ts, decision: ev.decision });
    } else if (ev.type === 'sweep-detected') {
      this.counters.sweeps++;
    } else if (ev.type === 'signal-fired') {
      this.counters.signals++;
    }
    this.events.push(ev);
    if (this.events.length > TELEMETRY_RING_SIZE) {
      this.events.splice(0, this.events.length - TELEMETRY_RING_SIZE);
    }
    // Pull the feed into the same debounced Redis flush as the orchestrator
    // state so a deploy / OOM doesn't empty the dashboard.
    this.markPersistDirty();
  }

  /** Public-facing minimal pulse for the marketing landing page. Does NOT
   *  expose entry hints, event detail, or position data — safe for
   *  unauthenticated readers. Only enough to drive the visible "engine is
   *  alive" animations: per-pair lastEvalAt + lastDecision + UTC counters. */
  getPublicPulse() {
    const pairs: Record<string, { lastEvalAt: string | null; lastDecision: string }> = {};
    for (const sym of this.pairs) {
      const e = this.lastEval.get(sym);
      pairs[sym] = {
        lastEvalAt: e?.ts ?? null,
        lastDecision: e?.decision ?? 'unknown',
      };
    }
    return {
      serverNowIso: new Date().toISOString(),
      pairs,
      counters: {
        evalsToday: this.counters.evals,
        sweepsToday: this.counters.sweeps,
        signalsToday: this.counters.signals,
      },
      isRunning: this.liveControl.isRunning(),
    };
  }

  /** Read-only snapshot for the dashboard Engine Worker view. Combines
   *  in-memory ring buffer + per-pair last-eval + orchestrator pending state.
   *  Live trading not affected — pure read. */
  getTelemetry() {
    const now = new Date().toISOString();
    const orchestratorState = this.orchestrator.getTelemetry();

    const pairs: Record<string, {
      lastEvalAt: string | null;
      lastDecision: string;
      cooldownBarsRemaining: number;
      pendingCount: number;
      pending: Array<{
        direction: 'BUY' | 'SELL';
        mode: string;
        entryHint: number;
        detectedAtH1Idx: number;
        expiresAtH1Idx: number;
      }>;
    }> = {};

    for (const sym of this.pairs) {
      const e = this.lastEval.get(sym);
      const o = orchestratorState[sym];
      pairs[sym] = {
        lastEvalAt: e?.ts ?? null,
        lastDecision: e?.decision ?? 'unknown',
        cooldownBarsRemaining: o?.cooldownBarsRemaining ?? 0,
        pendingCount: o?.pendingCount ?? 0,
        pending: o?.pending ?? [],
      };
    }

    // Cap recent events to last 50 — the full ring buffer is bigger but the
    // UI only needs the visible window.
    const recentEvents = this.events.slice(-50).reverse();

    return {
      serverNowIso: now,
      pairs,
      counters: {
        date: this.counters.date,
        evalsToday: this.counters.evals,
        sweepsToday: this.counters.sweeps,
        signalsToday: this.counters.signals,
      },
      recentEvents,
      isRunning: this.liveControl.isRunning(),
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly liveControl: LiveControlService,
    private readonly orchestrator: LiveSmcOrchestrator,
    private readonly mail: MailService,
    private readonly journal: JournalService,
    private readonly brokerAccounts: BrokerAccountsService,
    private readonly brokerHttp: BrokerHttpClient,
    private readonly orchestratorRegistry: LiveSmcOrchestratorRegistry,
  ) {
    this.liveMode = (this.config.get<string>('LIVE_MODE') || 'false').toLowerCase() === 'true';
    const pairsCsv = this.config.get<string>('STRATEGY_PAIRS') || 'XAUUSD,EURUSD,GBPUSD,USDJPY';
    this.pairs = pairsCsv.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    this.evaluator = new SmcLiveEvaluator();
  }

  async onModuleInit() {
    if (!this.liveMode) {
      this.logger.log('LIVE_MODE=false — live strategy is DORMANT (legacy BOS service still bound)');
      return;
    }
    this.logger.log(`LIVE_MODE=true — SMC-V2 live trading enabled for ${this.pairs.join(', ')}`);
    for (const pair of this.pairs) this.actionedSweeps.set(pair, new Set());

    // Seed the orchestrator's long-lived per-pair RiskManager with the REAL
    // broker equity. Replay calls setDefaultRiskCfg with cfg.initialBalance
    // before each run; live previously never called it, so the canTrade()
    // pause/drawdown brake thresholds operated on the default $10k mental
    // model regardless of actual account size. On a $1k account that means
    // the 5% drawdown brake would fire at $500 lost — 50% of the real
    // balance. Lot sizing was already correct (uses ctx.accountEquity per
    // signal), this only fixes the daily-loss / consecutive-loss state.
    try {
      const acct = await this.fetchAccount();
      const riskPercent = this.liveControl.getRiskPercent();
      this.orchestrator.setDefaultRiskCfg({
        initialBalance: acct.equity,
        riskPercent,
        maxOpenPositions: 4,
      });
      this.logger.log(
        `RiskManager seeded from broker: equity=${acct.equity} risk=${riskPercent}% maxOpen=4`,
      );
    } catch (err) {
      this.logger.warn(
        `Could not seed RiskManager from broker (using defaults): ${(err as Error).message}`,
      );
    }

    // Restore orchestrator state from Redis so a container restart mid-day
    // doesn't drop the pending-sweeps queue or cooldown timers.
    try {
      const raw = await this.redis.get(ORCHESTRATOR_STATE_KEY);
      if (raw) {
        this.orchestrator.restore(JSON.parse(raw));
        this.logger.log('Restored orchestrator state from Redis');
      }
    } catch (err) {
      this.logger.warn(`Could not restore orchestrator state: ${(err as Error).message}`);
    }

    // Restore the dashboard telemetry feed (Engine Worker view + pair scanner
    // badges + daily counters). Without this every deploy empties the panel
    // and gives the false impression that the engine just woke up.
    try {
      const raw = await this.redis.get(TELEMETRY_FEED_KEY);
      if (raw) {
        const feed = JSON.parse(raw) as {
          events?: TelemetryEvent[];
          lastEval?: Array<[string, { ts: string; decision: 'no-sweep' | 'pending-only' | 'cooldown' }]>;
          counters?: { date: string; evals: number; sweeps: number; signals: number };
        };
        if (Array.isArray(feed.events)) {
          this.events = feed.events.slice(-TELEMETRY_RING_SIZE);
        }
        if (Array.isArray(feed.lastEval)) {
          this.lastEval = new Map(feed.lastEval);
        }
        if (feed.counters) {
          this.counters = feed.counters;
        }
        this.logger.log(
          `Restored telemetry feed: ${this.events.length} events, ${this.lastEval.size} pair eval snapshots`,
        );
      }
    } catch (err) {
      this.logger.warn(`Could not restore telemetry feed: ${(err as Error).message}`);
    }

    await this.redis.subscribe(REDIS_CHANNELS.CANDLE_STORED, (message) => {
      try {
        const data = JSON.parse(message);
        if (data.timeframe !== Timeframe.M15) return;
        const symbol = (data.symbol || '').toUpperCase();
        if (!this.pairs.includes(symbol)) return;
        // Runtime gate: skip evaluation when the engine is "paused" via the
        // dashboard Start/Stop button, even when LIVE_MODE=true.
        if (!this.liveControl.isRunning()) return;
        if (this.fanOutEnabled) {
          this.evaluatePairAllAccounts(symbol).catch((err) =>
            this.logger.error(`[${symbol}] fan-out eval failed: ${(err as Error).message}`, (err as Error).stack),
          );
        } else {
          this.evaluatePair(symbol).catch((err) =>
            this.logger.error(`Live eval failed for ${symbol}: ${err.message}`, err.stack),
          );
        }
      } catch (err) {
        this.logger.warn(`Bad CANDLE_STORED payload: ${(err as Error).message}`);
      }
    });
    this.subscribed = true;

    // Backstop persistence interval — flushes any state mutated outside
    // evaluatePair() (most importantly position-monitor.recordExit when the
    // broker closes a position) within PERSIST_INTERVAL_MS of the change.
    // No-ops when nothing is dirty.
    this.persistIntervalTimer = setInterval(() => {
      this.flushOrchestratorState().catch(() => { /* logged inside */ });
    }, PERSIST_INTERVAL_MS);
  }

  async onModuleDestroy() {
    // RedisService manages its own subscription lifecycle.
    this.subscribed = false;

    // Tear down the persistence scheduler. Cancel any pending debounce so it
    // doesn't fire after we've already flushed; cancel the periodic timer;
    // then do a final synchronous flush so a clean shutdown never loses the
    // most recent mutations. A hard crash (SIGKILL, OOM) skips this path —
    // worst case = up to PERSIST_INTERVAL_MS of state lost.
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
    if (this.persistIntervalTimer) {
      clearInterval(this.persistIntervalTimer);
      this.persistIntervalTimer = null;
    }
    await this.flushOrchestratorState();
  }

  /**
   * Public entrypoint for manual / scheduled triggers (e.g. from controllers).
   *
   * Routes through `LiveSmcOrchestrator` which mirrors V6-alt's per-pair
   * backtest logic: a sweep stays in a pending queue across multiple M15
   * bars (so we can take it on bar 14:15, 14:30, 14:45 if 14:00 fails some
   * gate), with post-trade cooldowns. The legacy stateless `SmcLiveEvaluator`
   * is kept as a primitive — used by the orchestrator's internals.
   */
  async evaluatePair(symbol: string): Promise<SmcLiveSignal | null> {
    const [m15, h1, d1, openPositions, allOpenPositions, account] = await Promise.all([
      this.fetchCandles(symbol, Timeframe.M15, M15_BUFFER),
      this.fetchCandles(symbol, Timeframe.H1, H1_BUFFER),
      this.fetchCandles(symbol, Timeframe.D1, D1_BUFFER),
      this.fetchOpenPositions(symbol),
      this.fetchAllOpenPositions(),
      this.fetchAccount(),
    ]);

    const evalTs = m15[m15.length - 1]?.openTime ?? new Date().toISOString();

    // Snapshot pending count BEFORE evaluate() so we can detect new sweeps
    // by comparing pre/post counts. The orchestrator may have added a sweep
    // to the pending queue inside evaluate(), even when no signal fires.
    const pendingBefore = this.orchestrator.getTelemetry()[symbol]?.pendingCount ?? 0;

    const signal = this.orchestrator.evaluate(symbol, m15, h1, d1, {
      accountEquity: account.equity,
      openDirections: new Set(openPositions.map((p) => p.side as 'BUY' | 'SELL')),
      totalOpenPositions: allOpenPositions.length,
      riskPercent: this.liveControl.getRiskPercent(),
      nowIso: evalTs,
      maxOpenPositions: 4,
    });

    const post = this.orchestrator.getTelemetry()[symbol];
    const pendingAfter = post?.pendingCount ?? 0;

    // Emit a sweep-detected event when the pending queue grew this call.
    // Use the most recent pending entry — buildTelemetry guarantees order.
    if (pendingAfter > pendingBefore) {
      const fresh = post!.pending[post!.pending.length - 1];
      this.pushEvent({
        ts: evalTs,
        symbol,
        type: 'sweep-detected',
        direction: fresh.direction,
        mode: fresh.mode,
        entryHint: fresh.entryHint,
      });
    }

    if (!signal) {
      this.logger.debug(`[${symbol}] no signal`);
      this.pushEvent({
        ts: evalTs,
        symbol,
        type: 'eval',
        decision:
          (post?.cooldownBarsRemaining ?? 0) > 0
            ? 'cooldown'
            : pendingAfter > 0
              ? 'pending-only'
              : 'no-sweep',
      });
      // Even no-signal evaluations mutate state (cooldown decrement, sweep
      // dedup, pending expiry). Mark dirty so the snapshot stays fresh.
      this.markPersistDirty();
      return null;
    }

    this.logger.log(`[${symbol}] signal → ${signal.reason}`);
    this.pushEvent({
      ts: evalTs,
      symbol,
      type: 'signal-fired',
      side: signal.side,
      mode: signal.mode,
      entryPrice: signal.entryPrice,
    });

    const placeResult = await this.placeOrder(signal);

    if (placeResult.successfulLegs === 0) {
      // No leg succeeded (broker rejection on all legs, partial-fill rollback,
      // slippage close, DB persist failure, etc.). The orchestrator's pending
      // queue still holds the sweep, so the NEXT M15 close will re-try until
      // the setup's `expiresAtH1Bars` window elapses. We do NOT call
      // recordEntry — that would mark the sweep as actioned and prevent retry.
      // Before PR #31 this path silently consumed the sweep + applied a fake
      // 1-bar cooldown to a trade that didn't actually happen.
      this.logger.warn(
        `[${symbol}] placeOrder produced 0 successful legs — sweep stays in pending for retry`,
      );
      // Persist anyway: evaluate() did mutate non-firing state (lastProcessedH1Time,
      // catchup pending pushes, expiry filter). Keep Redis snapshot fresh.
      this.markPersistDirty();
      return null;
    }

    this.orchestrator.recordEntry(symbol, signal);
    // Signal-fire is the most important state mutation — actionedSweeps,
    // cooldown, RiskManager all updated. Mark dirty (debounced flush within
    // PERSIST_DEBOUNCE_MS). The 4-pair burst at any M15 boundary will
    // collapse to one Redis write.
    this.markPersistDirty();
    // Journal entry — auto-populate entryContext snapshot.
    // Fire-and-forget; failure logged, never thrown.
    const killzone = this.classifyKillzone(symbol, evalTs);
    const h1Last: any = h1.length > 0 ? h1[h1.length - 1] : null;
    const h1Atr = h1Last && typeof h1Last.atr14 === 'number' ? h1Last.atr14 : 0;
    const tele: any = this.orchestrator.getTelemetry()[symbol] ?? {};
    this.journal.createJournalEntriesForSignal(signal, evalTs, {
      d1Adx: tele.d1Adx ?? 0,
      d1Bias: tele.d1Bias ?? 'NEUTRAL',
      killzone,
      h1Atr,
      pendingQueueSize: tele.pendingCount ?? 0,
      spread: 0,
      accountEquity: account.equity,
      openPositionsCount: allOpenPositions.length,
      openDirections: openPositions.map((p) => p.side as 'BUY' | 'SELL'),
      anchorLevel: signal.smcContext?.sweptLevel ?? null,
      anchorType: signal.smcContext?.anchorType ?? null,
    }).catch((err) =>
      this.logger.warn(`JournalEntry create failed: ${(err as Error).message}`),
    );
    // Trade-opened email is intentionally omitted from the legacy single-account
    // path. This path is deprecated in favour of evaluatePairAllAccounts
    // (fan-out), which scopes notifications to account.user.email directly.
    return signal;
  }

  /**
   * Fan-out variant: evaluate this M15 candle against ALL enabled BrokerAccount
   * rows in parallel. Failure on one account does not block others. Used when
   * ENABLE_MULTI_ACCOUNT_FANOUT=true; otherwise the legacy single-account
   * evaluatePair() runs.
   */
  async evaluatePairAllAccounts(symbol: string): Promise<void> {
    const accounts = await this.brokerAccounts.findEnabled();
    if (accounts.length === 0) {
      this.logger.debug(`[${symbol}] no enabled accounts — skipping`);
      return;
    }
    await Promise.all(
      accounts.map((acct: any) =>
        this.evaluatePairForAccount(symbol, acct).catch((err) =>
          this.logger.error(
            `[${acct.name}/${symbol}] evaluate failed: ${(err as Error).message}`,
          ),
        ),
      ),
    );
  }

  /**
   * Public fan-out entry point. Gates evaluation on per-user flags and
   * the preset's pair list before delegating to the internal evaluator.
   */
  async evaluatePairForAccount(
    symbol: string,
    account: BrokerAccountWithUser,
  ): Promise<SmcLiveSignal | null> {
    if (!account.user) {
      this.logger.warn(`account=${account.id} has no user — skipping`);
      return null;
    }
    if (!account.user.botEnabled || !account.user.isActive) {
      return null;
    }
    if (!account.isEnabled) {
      return null;
    }
    const preset = getPreset(account.user.presetKey);
    if (!preset.pairs.includes(symbol)) {
      return null;
    }
    return this.evaluatePairForAccountInternal(symbol, account, preset);
  }

  /**
   * Per-account version of evaluatePair. Same strategy logic; broker
   * calls routed through BrokerHttpClient by accountId; orchestrator
   * state held by LiveSmcOrchestratorRegistry per account.
   */
  private async evaluatePairForAccountInternal(
    symbol: string,
    account: { id: string; name: string; user: { email: string } },
    preset: StrategyPreset,
  ): Promise<SmcLiveSignal | null> {
    const [m15, h1, d1, openPositions, allOpenPositions, accountInfo] = await Promise.all([
      this.fetchCandles(symbol, Timeframe.M15, M15_BUFFER),
      this.fetchCandles(symbol, Timeframe.H1, H1_BUFFER),
      this.fetchCandles(symbol, Timeframe.D1, D1_BUFFER),
      this.brokerHttp.fetchOpenPositions(account.id, symbol),
      this.brokerHttp.fetchOpenPositions(account.id),
      this.brokerHttp.fetchAccount(account.id),
    ]);

    const evalTs = m15[m15.length - 1]?.openTime ?? new Date().toISOString();
    const orchestrator = await this.orchestratorRegistry.getOrCreate(account.id);

    const signal = orchestrator.evaluate(symbol, m15, h1, d1, {
      accountEquity: accountInfo.equity,
      openDirections: new Set(openPositions.map((p: any) => p.side as 'BUY' | 'SELL')),
      totalOpenPositions: allOpenPositions.length,
      riskPercent: preset.riskPercent,
      nowIso: evalTs,
      maxOpenPositions: preset.maxOpenPositions,
    });

    if (!signal) {
      this.logger.debug(`[${account.name}/${symbol}] no signal`);
      return null;
    }

    this.logger.log(`[${account.name}/${symbol}] signal → ${signal.reason}`);

    const placeResult = await this.placeOrderForAccount(signal, account.id);
    if (placeResult.successfulLegs === 0) {
      this.logger.warn(
        `[${account.name}/${symbol}] placeOrder produced 0 successful legs — sweep stays in pending for retry`,
      );
      return null;
    }
    orchestrator.recordEntry(symbol, signal);
    // Fire-and-forget email notification scoped to this account's owner.
    // MailService handles its own errors; catch here just prevents
    // an unhandled rejection from leaking out of evaluatePairForAccount.
    this.notifyTradeOpened(signal, evalTs, account.user.email).catch((err) =>
      this.logger.warn(`Trade-opened notify failed: ${(err as Error).message}`),
    );
    return signal;
  }

  /**
   * Per-account retry wrapper for brokerHttp.placeOrder — mirrors
   * postOrderWithRetry semantics (3 attempts, 4xx fail-fast, linear backoff).
   */
  private async placeOrderForAccountWithRetry(
    accountId: string,
    body: Record<string, unknown>,
  ): Promise<{ mt5Ticket?: number | null; entryPrice?: number; status?: string; orderId?: string }> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.brokerHttp.placeOrder(accountId, body);
      } catch (err) {
        lastErr = err;
        const status = (err as any)?.response?.status as number | undefined;
        if (status && status >= 400 && status < 500) throw err;
        if (attempt < MAX_ATTEMPTS) {
          const delay = attempt * 500;
          this.logger.warn(
            `order placement attempt ${attempt} failed (${(err as Error).message}); retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Per-account variant of placeOrder. Routes broker calls via BrokerHttpClient.
   * Stamps accountId on the created Trade row(s) so downstream queries can scope.
   *
   * Mirrors the legacy placeOrder body exactly with two substitutions:
   *   - postOrderWithRetry → placeOrderForAccountWithRetry(accountId, body)
   *   - Trade.create data gets `accountId` field
   *
   * Compensating closes (slippage, orphan, partial-fill rollback) route through
   * `bestEffortCloseForAccount` so each close hits the correct broker connection
   * via BrokerHttpClient (rather than the env-bound singleton used by the legacy
   * `bestEffortClose`).
   */
  private async placeOrderForAccount(
    signal: SmcLiveSignal,
    accountId: string,
  ): Promise<{ successfulLegs: number }> {
    const slPoints = Math.abs(signal.entryPrice - signal.slPrice);
    const MAX_SLIPPAGE_FRACTION = 0.30;

    const placed: Array<{ mt5Ticket: number; tradeId: string }> = [];

    for (const leg of signal.legs) {
      const clientOrderId = randomUUID();
      const dupe = await this.prisma.trade.findUnique({ where: { clientOrderId } });
      if (dupe) continue;

      let brokerOrder: { mt5Ticket?: number | null; entryPrice?: number } | null = null;
      try {
        brokerOrder = await this.placeOrderForAccountWithRetry(accountId, {
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: signal.entryPrice,
          slPrice: signal.slPrice,
          tpPrice: leg.tpPrice,
          comment: `SMC:${clientOrderId.slice(0, 8)}`,
        });
      } catch (err) {
        this.logger.error(
          `[${signal.symbol}] order failed for leg ${JSON.stringify(leg)}: ${(err as Error).message}`,
        );
        continue;
      }

      const order = brokerOrder!;
      const mt5Ticket = order.mt5Ticket ?? undefined;

      // Broker rejection check. Execution-service returns HTTP 200 with
      // status='REJECTED' and mt5Ticket=null when the broker refuses the
      // order (margin too small, account-state issue, market closed, etc).
      // Without this guard we'd persist a Trade row with mt5Ticket=NULL —
      // a "zombie" that position-monitor's reconciler skips (its filter is
      // `mt5Ticket: { not: null }`), so the row stays OPEN forever. Skip
      // the leg cleanly here so the sweep stays in the pending queue and
      // retries on the next M15 close (same contract as PR #31's intent).
      if (typeof mt5Ticket !== 'number' || mt5Ticket <= 0) {
        this.logger.warn(
          `[${accountId}/${signal.symbol}] broker rejected leg (mt5Ticket=${mt5Ticket}) — skipping, sweep stays pending`,
        );
        continue;
      }

      const fillPrice = typeof order.entryPrice === 'number' && order.entryPrice > 0
        ? order.entryPrice
        : signal.entryPrice;
      const slippage = Math.abs(fillPrice - signal.entryPrice);
      const slippageFrac = slPoints > 0 ? slippage / slPoints : 0;

      if (slippageFrac > MAX_SLIPPAGE_FRACTION) {
        this.logger.warn(
          `[${signal.symbol}] excessive slippage ${(slippageFrac * 100).toFixed(1)}% — closing ticket=${mt5Ticket} + writing audit row`,
        );
        await this.bestEffortCloseForAccount(accountId, mt5Ticket, 'emergency close (slippage)');
        await this.writeAuditTradeRow(signal, leg, clientOrderId, mt5Ticket, fillPrice, 'EXCESSIVE_SLIPPAGE');
        continue;
      }

      let tradeId: string;
      try {
        const candidate = await this.prisma.candidateTrade.create({
          data: {
            symbol: signal.symbol,
            side: signal.side,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            slPoints: Math.abs(signal.entryPrice - signal.slPrice),
            tpPoints: Math.abs(leg.tpPrice - signal.entryPrice),
            setupTags: leg.setupTags,
            h1Bias: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH',
            rsiValue: 0,
            atrValue: 0,
            spreadAtDetection: 0,
            timeframe: 'M15',
            status: 'APPROVED',
          },
        });

        const trailKey: 'TP1' | 'RUNNER' = leg.setupTags.includes('TP1') ? 'TP1' : 'RUNNER';
        const trade = await this.prisma.trade.create({
          data: {
            candidateId: candidate.id,
            clientOrderId,
            mt5Ticket: mt5Ticket ?? null,
            sessionId: this.liveControl.getCurrentSessionId(),
            accountId,
            symbol: signal.symbol,
            side: signal.side,
            lotSize: leg.lotSize,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            status: 'OPEN',
            statusHistory: [
              { status: 'PENDING', timestamp: new Date().toISOString() },
              { status: 'OPEN', timestamp: new Date().toISOString(), ticket: mt5Ticket },
            ],
            managementState: {
              breakevenActivated: false,
              peakFavorablePrice: signal.entryPrice,
              originalSlPrice: signal.slPrice,
              trailKey,
            } as any,
            sweptLevel: signal.smcContext?.sweptLevel ?? null,
            sweptHigh: signal.smcContext?.sweptHigh ?? null,
            sweptLow: signal.smcContext?.sweptLow ?? null,
            sweepCandleTime: signal.smcContext?.sweepCandleTime
              ? new Date(signal.smcContext.sweepCandleTime)
              : null,
            d1Bias: signal.smcContext?.d1Bias ?? null,
            originalSlPrice: signal.slPrice,
            strategyName: 'stop-hunt',
          },
        });
        tradeId = trade.id;

        await this.redis.publish(REDIS_CHANNELS.TRADE_OPENED, {
          candidateId: candidate.id,
          clientOrderId,
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: signal.entryPrice,
          mt5Ticket,
          accountId,
        });

        this.logger.log(
          `[${signal.symbol}] OPENED ${signal.side} ${leg.lotSize} lot @${signal.entryPrice} SL=${signal.slPrice} TP=${leg.tpPrice} ticket=${mt5Ticket} account=${accountId}`,
        );
      } catch (dbErr) {
        this.logger.error(
          `[${signal.symbol}] DB persist failed for ticket=${mt5Ticket}, closing orphan: ${(dbErr as Error).message}`,
        );
        await this.bestEffortCloseForAccount(accountId, mt5Ticket, 'orphan close (DB persist failed)');
        continue;
      }

      if (typeof mt5Ticket === 'number') {
        placed.push({ mt5Ticket, tradeId });
      }
    }

    if (placed.length > 0 && placed.length < signal.legs.length) {
      this.logger.warn(
        `[${signal.symbol}] partial fill (${placed.length}/${signal.legs.length}) — rolling back successful legs`,
      );
      for (const p of placed) {
        await this.bestEffortCloseForAccount(accountId, p.mt5Ticket, 'partial-fill rollback');
        try {
          await this.prisma.trade.update({
            where: { id: p.tradeId },
            data: { status: 'CLOSED', exitReason: 'PARTIAL_FILL_ROLLBACK', closedAt: new Date() },
          });
        } catch (e) {
          this.logger.error(`failed to mark trade ${p.tradeId} as rolled-back: ${(e as Error).message}`);
        }
      }
      return { successfulLegs: 0 };
    }

    return { successfulLegs: placed.length };
  }

  private classifyKillzone(symbol: string, iso: string): 'LONDON' | 'NY' | 'ASIAN' | null {
    const hour = new Date(iso).getUTCHours();
    if (hour >= 6 && hour < 12) return 'LONDON';
    if (hour >= 12 && hour < 18) return 'NY';
    if (hour >= 22 || hour < 6) return 'ASIAN';
    return null;
  }

  /**
   * Send the trade-opened email to the trade owner. Email is scoped to the
   * account owner derived at the call site (BrokerAccountWithUser.user.email),
   * so no DB lookup is needed here.
   */
  private async notifyTradeOpened(
    signal: SmcLiveSignal,
    openedAtIso: string,
    ownerEmail: string,
  ): Promise<void> {
    const dashboardUrl = `${process.env.WEB_URL || 'https://shamarx.com'}/lives`;
    const payload: TradeOpenedPayload = {
      symbol: signal.symbol,
      side: signal.side,
      mode: signal.mode,
      lotSize: signal.totalLot,
      entryPrice: signal.entryPrice,
      slPrice: signal.slPrice,
      tpPrice: signal.tpPrice ?? null,
      riskPercent: this.liveControl.getRiskPercent(),
      reason: signal.reason,
      openedAtIso,
      dashboardUrl,
    };

    await this.mail.sendTradeOpened(ownerEmail, payload);
  }

  /**
   * Synthetic test trade — bypasses the SMC evaluator. Used for verifying
   * end-to-end execution path (broker connection, order placement, DB
   * persistence, position-monitor reconciliation).
   *
   * Places a small lot (default 0.01) at the latest candle close with tight
   * SL/TP derived from M15 ATR. Goes through the SAME placeOrder() code path
   * as a real signal, so a successful test trade implies the entire chain
   * works.
   */
  async fireTestTrade(opts: {
    symbol: string;
    side?: 'BUY' | 'SELL';
    lotSize?: number;
    slAtrMult?: number;
    tpRMult?: number;
  }): Promise<SmcLiveSignal> {
    const symbol = opts.symbol.toUpperCase();
    const side: 'BUY' | 'SELL' = opts.side ?? 'BUY';
    const lotSize = opts.lotSize ?? 0.01;
    const slAtrMult = opts.slAtrMult ?? 1.0;
    const tpRMult = opts.tpRMult ?? 2.0;

    if (!this.liveControl.isRunning()) {
      throw new Error('Engine is not running. Start a session first.');
    }
    if (!this.pairs.includes(symbol)) {
      throw new Error(`Pair ${symbol} not in STRATEGY_PAIRS=${this.pairs.join(',')}`);
    }

    const m15 = await this.fetchCandles(symbol, Timeframe.M15, 50);
    if (m15.length < 20) throw new Error(`Not enough M15 candles for ${symbol} to compute ATR`);

    const last = m15[m15.length - 1];
    const entryPrice = last.close;

    // Crude ATR over last 14 bars
    const atr14 = m15.slice(-14).reduce((sum, c, i, arr) => {
      if (i === 0) return sum;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - arr[i - 1].close),
        Math.abs(c.low - arr[i - 1].close),
      );
      return sum + tr;
    }, 0) / 13;

    const slDistance = atr14 * slAtrMult;
    const slPrice =
      side === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
    const tpPrice =
      side === 'BUY' ? entryPrice + slDistance * tpRMult : entryPrice - slDistance * tpRMult;

    const round = (n: number) => {
      // gold pricePrecision=2, JPY=3, others=5
      const decimals = symbol === 'XAUUSD' ? 2 : symbol.endsWith('JPY') ? 3 : 5;
      const factor = Math.pow(10, decimals);
      return Math.round(n * factor) / factor;
    };

    const signal: SmcLiveSignal = {
      symbol,
      side,
      entryPrice: round(entryPrice),
      slPrice: round(slPrice),
      tpPrice: round(tpPrice),
      totalLot: lotSize,
      legs: [
        {
          lotSize,
          tpPrice: round(tpPrice),
          setupTags: ['TEST', 'MANUAL', side],
        },
      ],
      mode: 'REVERSAL',
      h1SweepTime: new Date().toISOString(),
      reason: `TEST trade: ${side} ${symbol} ${lotSize} lot @ ${round(entryPrice)} SL=${round(slPrice)} TP=${round(tpPrice)} (ATR=${atr14.toFixed(5)} × ${slAtrMult})`,
    };

    this.logger.warn(`[TEST-TRADE] firing → ${signal.reason}`);
    await this.placeOrder(signal);
    return signal;
  }

  private async fetchCandles(
    symbol: string,
    timeframe: string,
    count: number,
  ): Promise<BacktestCandle[]> {
    // D1 SPECIAL CASE: MetaApi's /candles?D1 returns bars aligned to the
    // BROKER session (typically 21:00 UTC start), while the replay engine
    // reads D1 from Postgres where the cron poller's H1→D1 resample (see
    // candle.service.ts:resampleH1ToD1, added in PR #19) writes bars aligned
    // to UTC midnight. Different OHLC per "calendar day" → different D1
    // ADX/EMA50 → different bias → live's `liveD1Adx >= cfg.d1AdxFloor`
    // gate fails on bars where replay's passes. Every sweep is silently
    // skipped before detectSweep is even called. Reading D1 from Postgres
    // here makes live + replay share the same D1 source of truth.
    if (timeframe === Timeframe.D1) {
      const rows = await this.prisma.candle.findMany({
        where: { symbol, timeframe },
        orderBy: { openTime: 'desc' },
        take: count,
      });
      return rows.reverse().map((r) => ({
        symbol: r.symbol,
        timeframe: r.timeframe,
        openTime: r.openTime.toISOString(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }));
    }
    const url = `${SERVICE_URLS.EXECUTION}/candles`;
    const res = await firstValueFrom(
      this.httpService.get<CandleDto[]>(url, { params: { symbol, timeframe, count } }),
    );
    // MetaApi (and our /candles endpoint) returns the currently-OPEN bar as
    // the last element of the response. Without filtering, the orchestrator's
    // H1 catchup loop sees a partial bar as `lastClosedH1`, processes it on
    // `detectSweep` with incomplete OHLC, and (worse) writes
    // `state.lastProcessedH1Time = bar.openTime` — which means once the bar
    // ACTUALLY closes the write-once dedup makes the bar permanently invisible
    // to the orchestrator. Sweep wicks that form in the latter half of an H1
    // bar (the common case) are silently lost in live but caught by replay,
    // because replay reads from Postgres where the cursor only advances when
    // a bar fully closes. Keep only bars whose close time is at-or-before now.
    const tfMs = TIMEFRAME_DURATION_MS[timeframe];
    const now = Date.now();
    const rows = res.data || [];
    return rows
      .filter((c) => !tfMs || new Date(c.openTime).getTime() + tfMs <= now)
      .map((c) => ({
        symbol,
        timeframe,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
  }

  private async fetchOpenPositions(
    symbol: string,
  ): Promise<Array<{ ticket: number; side: string; lotSize: number; entryPrice: number; sl: number; tp: number; pnl: number }>> {
    const url = `${SERVICE_URLS.EXECUTION}/positions`;
    const res = await firstValueFrom(
      this.httpService.get(url, { params: { symbol } }),
    );
    return res.data || [];
  }

  /**
   * All open positions across the account — used by the orchestrator to
   * enforce a portfolio-wide `maxOpenPositions` cap (matches V6-alt's
   * RiskManager.canTrade which we don't yet wire into live).
   */
  private async fetchAllOpenPositions(): Promise<Array<{ ticket: number; symbol: string; side: string }>> {
    const url = `${SERVICE_URLS.EXECUTION}/positions`;
    const res = await firstValueFrom(this.httpService.get(url));
    return res.data || [];
  }

  /**
   * Retry wrapper for broker order placement — MetaAPI occasionally
   * returns transient 5xx or websocket-disconnected errors. We retry up
   * to 2 times with linear backoff before giving up; permanent errors
   * (4xx like insufficient margin) bubble up immediately.
   */
  private async postOrderWithRetry(body: Record<string, unknown>): Promise<{ data: any }> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await firstValueFrom(
          this.httpService.post(`${SERVICE_URLS.EXECUTION}/orders`, body),
        );
      } catch (err) {
        lastErr = err;
        const status = (err as any)?.response?.status as number | undefined;
        // Don't retry permanent failures — bad request, insufficient margin, etc.
        if (status && status >= 400 && status < 500) throw err;
        if (attempt < MAX_ATTEMPTS) {
          const delay = attempt * 500;
          this.logger.warn(`order placement attempt ${attempt} failed (${(err as Error).message}); retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  private async fetchAccount(): Promise<{ balance: number; equity: number }> {
    const url = `${SERVICE_URLS.EXECUTION}/account`;
    const res = await firstValueFrom(this.httpService.get(url));
    return res.data;
  }

  /**
   * Place all legs of a signal as broker orders + persist Trade rows.
   *
   * Returns the count of legs that fully succeeded (broker fill + DB persist).
   * Caller uses this count to decide whether to call orchestrator.recordEntry
   * — if 0, the orchestrator's pending queue stays untouched and the sweep
   * will retry on the next M15 close (until pending expiry).
   *
   * Fault handling:
   *   - Per-leg broker failure → logged, leg skipped, next leg attempted
   *   - Per-leg DB-persist failure → broker position closed (compensating
   *     action) to avoid orphans, leg counted as failed
   *   - Excessive slippage on fill → broker position closed + CANCELLED
   *     Trade row written as audit trail
   *   - Partial fill (some legs succeed, some fail) → ALL successful legs
   *     are rolled back, so we never run with asymmetric exposure (e.g.
   *     TP1-only without runner). Returns successfulLegs=0 in that case.
   */
  private async placeOrder(signal: SmcLiveSignal): Promise<{ successfulLegs: number }> {
    const slPoints = Math.abs(signal.entryPrice - signal.slPrice);
    // Slippage guardrail: live broker fills can drift from the intended
    // entry. If the actual fill price differs from `signal.entryPrice` by
    // more than 30% of the SL distance, the trade's risk-reward is
    // distorted enough that the backtest signal no longer applies — we
    // immediately close that leg. 30% mirrors V6-alt's tolerance for
    // out-of-band executions implicit in its commission model.
    const MAX_SLIPPAGE_FRACTION = 0.30;

    const placed: Array<{ mt5Ticket: number; tradeId: string }> = [];

    for (const leg of signal.legs) {
      const clientOrderId = randomUUID();
      // Idempotency: refuse if a Trade with this clientOrderId already exists.
      // (Belt-and-braces; uuid collision is astronomically unlikely.)
      const dupe = await this.prisma.trade.findUnique({ where: { clientOrderId } });
      if (dupe) continue;

      let brokerOrder: { mt5Ticket?: number; entryPrice?: number } | null = null;
      try {
        const res = await this.postOrderWithRetry({
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: signal.entryPrice,
          slPrice: signal.slPrice,
          tpPrice: leg.tpPrice,
          comment: `SMC:${clientOrderId.slice(0, 8)}`,
        });
        brokerOrder = res.data;
      } catch (err) {
        this.logger.error(`[${signal.symbol}] order failed for leg ${JSON.stringify(leg)}: ${(err as Error).message}`);
        continue;
      }

      const order = brokerOrder!;
      const mt5Ticket = order.mt5Ticket;

      // Broker rejection check — see placeOrderForAccount for full rationale.
      // Prevents "zombie" Trade rows (mt5Ticket=NULL, status=OPEN) that the
      // reconciler can't clean up because its filter requires `mt5Ticket: { not: null }`.
      if (typeof mt5Ticket !== 'number' || mt5Ticket <= 0) {
        this.logger.warn(
          `[${signal.symbol}] broker rejected leg (mt5Ticket=${mt5Ticket}) — skipping, sweep stays pending`,
        );
        continue;
      }

      const fillPrice = typeof order.entryPrice === 'number' && order.entryPrice > 0
        ? order.entryPrice
        : signal.entryPrice;
      const slippage = Math.abs(fillPrice - signal.entryPrice);
      const slippageFrac = slPoints > 0 ? slippage / slPoints : 0;

      if (slippageFrac > MAX_SLIPPAGE_FRACTION) {
        this.logger.warn(
          `[${signal.symbol}] excessive slippage ${(slippageFrac * 100).toFixed(1)}% — closing ticket=${mt5Ticket} + writing audit row`,
        );
        await this.bestEffortClose(mt5Ticket, 'emergency close (slippage)');
        // Fix 4: audit trail so the slippage event is visible in the dashboard.
        await this.writeAuditTradeRow(signal, leg, clientOrderId, mt5Ticket, fillPrice, 'EXCESSIVE_SLIPPAGE');
        continue;
      }

      // Persist CandidateTrade + Trade. Failure here = orphan broker position
      // unless we compensate — close the broker position and skip this leg.
      let tradeId: string;
      try {
        const candidate = await this.prisma.candidateTrade.create({
          data: {
            symbol: signal.symbol,
            side: signal.side,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            slPoints: Math.abs(signal.entryPrice - signal.slPrice),
            tpPoints: Math.abs(leg.tpPrice - signal.entryPrice),
            setupTags: leg.setupTags,
            h1Bias: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH',
            rsiValue: 0,
            atrValue: 0,
            spreadAtDetection: 0,
            timeframe: 'M15',
            status: 'APPROVED',
          },
        });

        const trailKey: 'TP1' | 'RUNNER' = leg.setupTags.includes('TP1') ? 'TP1' : 'RUNNER';
        const trade = await this.prisma.trade.create({
          data: {
            candidateId: candidate.id,
            clientOrderId,
            mt5Ticket: mt5Ticket ?? null,
            sessionId: this.liveControl.getCurrentSessionId(),
            symbol: signal.symbol,
            side: signal.side,
            lotSize: leg.lotSize,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            status: 'OPEN',
            statusHistory: [
              { status: 'PENDING', timestamp: new Date().toISOString() },
              { status: 'OPEN', timestamp: new Date().toISOString(), ticket: mt5Ticket },
            ],
            // Seed trade-management state so LivePositionManagerService has
            // what it needs on the next M15 close (BE flag, original SL,
            // peak price, trail-config selector).
            managementState: {
              breakevenActivated: false,
              peakFavorablePrice: signal.entryPrice,
              originalSlPrice: signal.slPrice,
              trailKey,
            } as any,
            // SMC annotation context for the dashboard chart expander.
            sweptLevel: signal.smcContext?.sweptLevel ?? null,
            sweptHigh: signal.smcContext?.sweptHigh ?? null,
            sweptLow: signal.smcContext?.sweptLow ?? null,
            sweepCandleTime: signal.smcContext?.sweepCandleTime
              ? new Date(signal.smcContext.sweepCandleTime)
              : null,
            d1Bias: signal.smcContext?.d1Bias ?? null,
            // Capture SL at creation. live-position-manager mutates
            // the `slPrice` column above as BE / trail kicks in; this
            // column never changes. The educational chart uses this so
            // users see where SL was *placed*, not where it ended up.
            originalSlPrice: signal.slPrice,
            strategyName: 'stop-hunt',
          },
        });
        tradeId = trade.id;

        await this.redis.publish(REDIS_CHANNELS.TRADE_OPENED, {
          candidateId: candidate.id,
          clientOrderId,
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: signal.entryPrice,
          mt5Ticket,
        });

        this.logger.log(
          `[${signal.symbol}] OPENED ${signal.side} ${leg.lotSize} lot @${signal.entryPrice} SL=${signal.slPrice} TP=${leg.tpPrice} ticket=${mt5Ticket}`,
        );
      } catch (dbErr) {
        // Fix 2: DB persist failed — close the broker position to avoid orphan.
        this.logger.error(
          `[${signal.symbol}] DB persist failed for ticket=${mt5Ticket}, closing orphan: ${(dbErr as Error).message}`,
        );
        await this.bestEffortClose(mt5Ticket, 'orphan close (DB persist failed)');
        continue;
      }

      if (typeof mt5Ticket === 'number') {
        placed.push({ mt5Ticket, tradeId });
      }
    }

    // Fix 3: Partial fill rollback. If we got some legs but not all, the
    // strategy was designed for the full ladder — running asymmetric (e.g.
    // TP1 alone, or runner alone) has a different risk profile than what
    // was sized. Close the partial fills.
    if (placed.length > 0 && placed.length < signal.legs.length) {
      this.logger.warn(
        `[${signal.symbol}] partial fill (${placed.length}/${signal.legs.length}) — rolling back successful legs`,
      );
      for (const p of placed) {
        await this.bestEffortClose(p.mt5Ticket, 'partial-fill rollback');
        try {
          await this.prisma.trade.update({
            where: { id: p.tradeId },
            data: { status: 'CLOSED', exitReason: 'PARTIAL_FILL_ROLLBACK', closedAt: new Date() },
          });
        } catch (e) {
          this.logger.error(`failed to mark trade ${p.tradeId} as rolled-back: ${(e as Error).message}`);
        }
      }
      return { successfulLegs: 0 };
    }

    return { successfulLegs: placed.length };
  }

  /** Best-effort close of a broker position. Logs but never throws. */
  private async bestEffortClose(mt5Ticket: number | undefined, reason: string): Promise<void> {
    if (!mt5Ticket) return;
    try {
      await firstValueFrom(
        this.httpService.post(`${SERVICE_URLS.EXECUTION}/positions/${mt5Ticket}/close`, {}),
      );
    } catch (err) {
      this.logger.error(`${reason} failed for ticket=${mt5Ticket}: ${(err as Error).message}`);
    }
  }

  /**
   * Account-aware variant of bestEffortClose. Routes the close through
   * BrokerHttpClient so it hits the correct broker connection.
   * Used by placeOrderForAccount for partial-fill rollback / slippage closes.
   * Mirrors bestEffortClose's swallow-errors semantics.
   */
  private async bestEffortCloseForAccount(
    accountId: string,
    mt5Ticket: number | undefined,
    reason: string,
  ): Promise<void> {
    if (!mt5Ticket) return;
    try {
      await this.brokerHttp.closePosition(accountId, mt5Ticket);
      this.logger.log(`[${accountId}] best-effort close ticket=${mt5Ticket} (${reason})`);
    } catch (err) {
      this.logger.warn(
        `[${accountId}] best-effort close failed for ticket=${mt5Ticket} (${reason}): ${(err as Error).message}`,
      );
    }
  }

  /** Write a CLOSED Trade row to the DB so error events (slippage, etc.) have
   *  an audit trail visible in the dashboard. Best-effort — logs on failure. */
  private async writeAuditTradeRow(
    signal: SmcLiveSignal,
    leg: SmcLiveSignalLeg,
    clientOrderId: string,
    mt5Ticket: number | undefined,
    fillPrice: number,
    exitReason: string,
  ): Promise<void> {
    try {
      const candidate = await this.prisma.candidateTrade.create({
        data: {
          symbol: signal.symbol,
          side: signal.side,
          entryPrice: signal.entryPrice,
          slPrice: signal.slPrice,
          tpPrice: leg.tpPrice,
          slPoints: Math.abs(signal.entryPrice - signal.slPrice),
          tpPoints: Math.abs(leg.tpPrice - signal.entryPrice),
          setupTags: leg.setupTags,
          h1Bias: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH',
          rsiValue: 0,
          atrValue: 0,
          spreadAtDetection: 0,
          timeframe: 'M15',
          status: 'REJECTED',
        },
      });
      const trailKey: 'TP1' | 'RUNNER' = leg.setupTags.includes('TP1') ? 'TP1' : 'RUNNER';
      await this.prisma.trade.create({
        data: {
          candidateId: candidate.id,
          clientOrderId,
          mt5Ticket: mt5Ticket ?? null,
          sessionId: this.liveControl.getCurrentSessionId(),
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: fillPrice,
          slPrice: signal.slPrice,
          tpPrice: leg.tpPrice,
          closePrice: fillPrice,
          pnl: 0,
          status: 'CLOSED',
          exitReason,
          closedAt: new Date(),
          statusHistory: [
            { status: 'PENDING', timestamp: new Date().toISOString() },
            { status: 'OPEN', timestamp: new Date().toISOString(), ticket: mt5Ticket },
            { status: 'CLOSED', timestamp: new Date().toISOString(), reason: exitReason },
          ],
          managementState: {
            breakevenActivated: false,
            peakFavorablePrice: fillPrice,
            originalSlPrice: signal.slPrice,
            trailKey,
          } as any,
          sweptLevel: signal.smcContext?.sweptLevel ?? null,
          sweptHigh: signal.smcContext?.sweptHigh ?? null,
          sweptLow: signal.smcContext?.sweptLow ?? null,
          sweepCandleTime: signal.smcContext?.sweepCandleTime
            ? new Date(signal.smcContext.sweepCandleTime)
            : null,
          d1Bias: signal.smcContext?.d1Bias ?? null,
          originalSlPrice: signal.slPrice,
          strategyName: 'stop-hunt',
        },
      });
    } catch (e) {
      this.logger.error(`audit trade row write failed: ${(e as Error).message}`);
    }
  }
}
