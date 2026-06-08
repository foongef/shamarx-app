/**
 * Aggregates live trade outcomes for the dashboard.
 *
 * Operates on `Trade` rows with `clientOrderId IS NOT NULL` (those are the
 * ones produced by the live engine — distinguishes from backtest trades which
 * live in `BacktestTrade`).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { Trade } from '@prisma/client';

export interface LiveStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  realizedPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  avgRR: number;
  largestWin: number;
  largestLoss: number;
  exitReasons: Record<string, number>;
  perPair: Record<string, PairStats>;
}

export interface PairStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

@Injectable()
export class LiveAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fetch live trades with filters (for the history table). */
  async listTrades(opts: {
    userId: string;
    status?: 'OPEN' | 'CLOSED' | 'PENDING' | 'ALL';
    symbol?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = {
      clientOrderId: { not: null },
      account: { userId: opts.userId },
    };
    if (opts.status && opts.status !== 'ALL') where.status = opts.status;
    if (opts.symbol) where.symbol = opts.symbol;
    if (opts.from || opts.to) {
      where.createdAt = {
        ...(opts.from ? { gte: opts.from } : {}),
        ...(opts.to ? { lte: opts.to } : {}),
      };
    }
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.trade.count({ where }),
    ]);
    return { trades: rows, total, limit, offset };
  }

  /** Compute aggregate stats over live trades in a time window. */
  async stats(opts: { userId: string; days?: number }): Promise<LiveStats> {
    const days = opts.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const trades = await this.prisma.trade.findMany({
      where: {
        clientOrderId: { not: null },
        createdAt: { gte: since },
        account: { userId: opts.userId },
      },
    });
    return this.compute(trades);
  }

  /** List all live sessions, newest first. Aggregates always recomputed
   *  from Trade rows so post-reconcile stats reflect the latest truth. */
  async listSessions(opts: { userId: string; limit?: number }) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const sessions = await this.prisma.liveSession.findMany({
      where: { account: { userId: opts.userId } },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    const enriched = await Promise.all(
      sessions.map((s) => this.recomputeSessionAggregates(s)),
    );
    return enriched;
  }

  /** Recompute trades count + wins + losses + realizedPnl from Trade rows.
   *  Returns the session with overridden aggregate fields. */
  private async recomputeSessionAggregates<T extends { id: string }>(session: T) {
    const trades = await this.prisma.trade.findMany({
      where: { sessionId: session.id },
      select: { pnl: true, status: true },
    });
    const closed = trades.filter((t) => t.status === 'CLOSED');
    const realized = closed
      .filter((t) => t.pnl !== null)
      .reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    return {
      ...session,
      tradesCount: trades.length,
      winsCount: closed.filter((t) => (t.pnl ?? 0) > 0).length,
      lossesCount: closed.filter((t) => (t.pnl ?? 0) < 0).length,
      realizedPnl: Math.round(realized * 100) / 100,
    };
  }

  /** Trades for a single session. */
  async sessionTrades(userId: string, sessionId: string) {
    return this.prisma.trade.findMany({
      where: { sessionId, account: { userId } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Single session detail with live-recomputed counters from Trade rows. */
  async getSession(userId: string, sessionId: string) {
    const s = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, account: { userId } },
    });
    if (!s) return null;
    return this.recomputeSessionAggregates(s);
  }

  /** Aggregate stats across ALL sessions (or filtered). */
  async sessionStats(userId: string, sessionId: string): Promise<LiveStats> {
    const trades = await this.prisma.trade.findMany({
      where: { sessionId, account: { userId } },
    });
    return this.compute(trades);
  }

  /**
   * Equity curve points. Optional sessionId filters to that session's window;
   * otherwise hours-back from now. Filters by mode so mock-test snapshots
   * don't pollute the metaapi arc (and vice versa).
   */
  async equityHistory(opts: {
    userId: string;
    hours?: number;
    limit?: number;
    sessionId?: string;
    mode?: 'mock' | 'metaapi';
  }) {
    const where: Record<string, unknown> = {
      source: 'live',
      account: { userId: opts.userId },
    };

    if (opts.sessionId) {
      const session = await this.prisma.liveSession.findFirst({
        where: { id: opts.sessionId, account: { userId: opts.userId } },
      });
      if (!session) return [];
      where.takenAt = {
        gte: session.startedAt,
        ...(session.endedAt ? { lte: session.endedAt } : {}),
      };
      // For session-scoped queries, lock mode to that session's mode.
      where.mode = session.mode;
    } else {
      const hours = opts.hours ?? 168;
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      where.takenAt = { gte: since };
      // For account-wide curve, filter by current engine mode if known.
      if (opts.mode) where.mode = opts.mode;
    }

    const rows = await this.prisma.equitySnapshot.findMany({
      where,
      orderBy: { takenAt: 'asc' },
      take: opts.limit ?? 5000,
    });
    return rows.map((r) => ({
      t: r.takenAt.toISOString(),
      balance: r.balance,
      equity: r.equity,
      unrealizedPnl: r.unrealizedPnl,
      openPositions: r.openPositions,
    }));
  }

  private compute(trades: Trade[]): LiveStats {
    const closed = trades.filter((t) => t.status === 'CLOSED' && t.pnl !== null);
    const open = trades.filter((t) => t.status === 'OPEN');

    const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
    const winsTotal = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const lossesTotal = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const exitReasons: Record<string, number> = {};
    for (const t of closed) {
      const r = t.exitReason ?? 'UNKNOWN';
      exitReasons[r] = (exitReasons[r] ?? 0) + 1;
    }

    // Per-pair breakdown
    const perPair: Record<string, PairStats> = {};
    for (const t of closed) {
      const p = (perPair[t.symbol] ??= {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalPnl: 0,
        avgPnl: 0,
      });
      p.trades++;
      if ((t.pnl ?? 0) > 0) p.wins++;
      else if ((t.pnl ?? 0) < 0) p.losses++;
      p.totalPnl += t.pnl ?? 0;
    }
    for (const p of Object.values(perPair)) {
      p.winRate = p.trades > 0 ? (p.wins / p.trades) * 100 : 0;
      p.avgPnl = p.trades > 0 ? p.totalPnl / p.trades : 0;
      p.winRate = Math.round(p.winRate * 10) / 10;
      p.totalPnl = Math.round(p.totalPnl * 100) / 100;
      p.avgPnl = Math.round(p.avgPnl * 100) / 100;
    }

    // Avg R-multiple — pnl / risk-per-trade. Approximate using SL distance × lot.
    const rMultiples = closed
      .map((t) => {
        const slDistance = Math.abs(t.entryPrice - t.slPrice);
        if (slDistance <= 0) return null;
        const lotUnits = t.symbol === 'XAUUSD' ? 100 : 100_000;
        let riskUsd = slDistance * t.lotSize * lotUnits;
        if (t.symbol.endsWith('JPY') && t.entryPrice > 0) riskUsd /= t.entryPrice;
        return riskUsd > 0 ? (t.pnl ?? 0) / riskUsd : null;
      })
      .filter((x): x is number => x !== null);
    const avgRR = rMultiples.length > 0
      ? rMultiples.reduce((s, x) => s + x, 0) / rMultiples.length
      : 0;

    return {
      totalTrades: trades.length,
      openTrades: open.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      totalPnl: Math.round(totalPnl * 100) / 100,
      realizedPnl: Math.round(totalPnl * 100) / 100,
      avgWin: wins.length > 0 ? Math.round((winsTotal / wins.length) * 100) / 100 : 0,
      avgLoss: losses.length > 0 ? Math.round((lossesTotal / losses.length) * 100) / 100 : 0,
      profitFactor: lossesTotal > 0 ? Math.round((winsTotal / lossesTotal) * 100) / 100 : 0,
      avgRR: Math.round(avgRR * 100) / 100,
      largestWin: wins.length > 0
        ? Math.round(Math.max(...wins.map((t) => t.pnl ?? 0)) * 100) / 100
        : 0,
      largestLoss: losses.length > 0
        ? Math.round(Math.min(...losses.map((t) => t.pnl ?? 0)) * 100) / 100
        : 0,
      exitReasons,
      perPair,
    };
  }
}
