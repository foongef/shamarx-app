import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { JournalEntryContext, JournalExitContext, JournalOutcome } from './dto/journal-context.types';

@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertDayNote(yyyymmdd: string, note: string): Promise<{ date: string; note: string | null }> {
    const date = new Date(yyyymmdd);
    if (Number.isNaN(date.getTime())) {
      throw new UnprocessableEntityException(`Invalid date: ${yyyymmdd}`);
    }
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    if (date.getTime() > todayUtc.getTime()) {
      throw new UnprocessableEntityException('Cannot journal future dates');
    }

    if (note === '') {
      try {
        await this.prisma.dayNote.delete({ where: { date } });
      } catch (err: any) {
        if (err?.code !== 'P2025') throw err;
      }
      return { date: yyyymmdd, note: null };
    }

    await this.prisma.dayNote.upsert({
      where: { date },
      create: { date, note },
      update: { note },
    });
    return { date: yyyymmdd, note };
  }

  async updateTradeJournal(
    tradeId: string,
    body: { tags?: string[]; reflectionNote?: string | null },
  ): Promise<{ tags: string[]; reflectionNote: string | null; entryContext: any; exitContext: any; setupSummary: string }> {
    const trade = await this.prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade) throw new NotFoundException(`Trade not found: ${tradeId}`);

    const update: Record<string, any> = {};
    if (body.tags !== undefined) update.tags = body.tags;
    if (body.reflectionNote !== undefined) update.reflectionNote = body.reflectionNote;

    const create: Record<string, any> = {
      tradeId,
      setupSummary: '',
      llmReasoning: '',
      tags: body.tags ?? [],
      reflectionNote: body.reflectionNote ?? null,
    };

    const updated = await this.prisma.journalEntry.upsert({
      where: { tradeId },
      create: create as any,
      update,
    });

    return {
      tags: updated.tags,
      reflectionNote: updated.reflectionNote,
      entryContext: updated.entryContext as any,
      exitContext: updated.exitContext as any,
      setupSummary: updated.setupSummary,
    };
  }

  async getDay(yyyymmdd: string): Promise<{
    date: string;
    dayNote: string | null;
    trades: any[];
    dayTotals: { tradesCount: number; realizedPnl: number; winsCount: number; lossesCount: number };
  }> {
    const dayStart = new Date(`${yyyymmdd}T00:00:00.000Z`);
    if (Number.isNaN(dayStart.getTime())) {
      throw new UnprocessableEntityException(`Invalid date: ${yyyymmdd}`);
    }
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const [trades, dayNote] = await Promise.all([
      this.prisma.trade.findMany({
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
        include: { journalEntry: true, candidate: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.dayNote.findUnique({ where: { date: dayStart } }),
    ]);

    const tradeRows = trades.map((t: any) => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      mode: (t.candidate?.setupTags ?? []).includes('CONTINUATION') ? 'CONTINUATION' : 'REVERSAL',
      lotSize: t.lotSize,
      entryPrice: t.entryPrice,
      closePrice: t.closePrice,
      slPrice: t.slPrice,
      originalSlPrice: t.originalSlPrice,
      tpPrice: t.tpPrice,
      pnl: t.pnl,
      exitReason: t.exitReason,
      status: t.status,
      openedAt: t.createdAt.toISOString(),
      closedAt: t.closedAt ? t.closedAt.toISOString() : null,
      sweptLevel: t.sweptLevel,
      sweepCandleTime: t.sweepCandleTime ? t.sweepCandleTime.toISOString() : null,
      d1Bias: t.d1Bias,
      journal: {
        tags: t.journalEntry?.tags ?? [],
        reflectionNote: t.journalEntry?.reflectionNote ?? null,
        entryContext: (t.journalEntry?.entryContext as any) ?? null,
        exitContext: (t.journalEntry?.exitContext as any) ?? null,
        setupSummary: t.journalEntry?.setupSummary ?? '',
        outcome: (t.journalEntry?.outcome as JournalOutcome | null) ?? null,
      },
    }));

    const realized = tradeRows.reduce((s, t) => s + (t.pnl ?? 0), 0);
    // FORCED_CLOSE trades are a third bucket — counted toward tradesCount +
    // realizedPnl but NOT toward wins/losses. Keeps Win Rate honest.
    const wins = tradeRows.filter((t) => (t.pnl ?? 0) > 0.5 && t.exitReason !== 'FORCED_CLOSE').length;
    const losses = tradeRows.filter((t) => (t.pnl ?? 0) < -0.5 && t.exitReason !== 'FORCED_CLOSE').length;

    return {
      date: yyyymmdd,
      dayNote: dayNote?.note ?? null,
      trades: tradeRows,
      dayTotals: {
        tradesCount: tradeRows.length,
        realizedPnl: Math.round(realized * 100) / 100,
        winsCount: wins,
        lossesCount: losses,
      },
    };
  }

  async getMonthAggregate(yyyymm: string): Promise<{
    month: string;
    days: Array<{ date: string; tradesCount: number; realizedPnl: number; winsCount: number; lossesCount: number; hasDayNote: boolean; hasReflections: boolean; hasOpenTrades: boolean }>;
    monthTotals: { tradesCount: number; realizedPnl: number; winsCount: number; lossesCount: number; winRatePct: number };
    weeklyTotals: Array<{ weekStart: string; tradesCount: number; realizedPnl: number; partial: boolean }>;
  }> {
    const match = /^(\d{4})-(\d{2})$/.exec(yyyymm);
    if (!match) throw new UnprocessableEntityException(`Invalid month: ${yyyymm}`);
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const [trades, dayNotes] = await Promise.all([
      this.prisma.trade.findMany({
        where: { createdAt: { gte: monthStart, lt: monthEnd } },
        include: { journalEntry: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.dayNote.findMany({
        where: { date: { gte: monthStart, lt: monthEnd } },
        select: { date: true },
      }),
    ]);

    const noteDates = new Set(dayNotes.map((n: any) => n.date.toISOString().slice(0, 10)));

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(Date.UTC(year, month - 1, i + 1));
      const key = d.toISOString().slice(0, 10);
      return {
        date: key,
        tradesCount: 0,
        realizedPnl: 0,
        winsCount: 0,
        lossesCount: 0,
        hasDayNote: noteDates.has(key),
        hasReflections: false,
        hasOpenTrades: false,
      };
    });
    const byDate = new Map(days.map((d) => [d.date, d]));

    for (const t of trades as any[]) {
      const key = t.createdAt.toISOString().slice(0, 10);
      const d = byDate.get(key);
      if (!d) continue;
      d.tradesCount++;
      const p = t.pnl ?? 0;
      d.realizedPnl += p;
      if (t.status !== 'CLOSED') d.hasOpenTrades = true;
      // Exclude FORCED_CLOSE from W/L — counted in tradesCount + realizedPnl
      // but not in the displayed Win Rate (third bucket).
      if (t.exitReason !== 'FORCED_CLOSE') {
        if (p > 0.5) d.winsCount++;
        else if (p < -0.5) d.lossesCount++;
      }
      const j = t.journalEntry;
      if (j && ((j.tags?.length ?? 0) > 0 || j.reflectionNote)) {
        d.hasReflections = true;
      }
    }

    for (const d of days) d.realizedPnl = Math.round(d.realizedPnl * 100) / 100;

    const totalTrades = days.reduce((s, d) => s + d.tradesCount, 0);
    const totalPnl = Math.round(days.reduce((s, d) => s + d.realizedPnl, 0) * 100) / 100;
    const totalWins = days.reduce((s, d) => s + d.winsCount, 0);
    const totalLosses = days.reduce((s, d) => s + d.lossesCount, 0);
    const winRatePct = totalWins + totalLosses > 0
      ? Math.round((totalWins / (totalWins + totalLosses)) * 100)
      : 0;

    const weekMap = new Map<string, { weekStart: string; tradesCount: number; realizedPnl: number; partial: boolean }>();
    for (const d of days) {
      if (d.tradesCount === 0 && d.realizedPnl === 0) continue;
      const date = new Date(`${d.date}T00:00:00.000Z`);
      const dow = date.getUTCDay();
      const daysSinceMonday = (dow + 6) % 7;
      const weekStartDt = new Date(date);
      weekStartDt.setUTCDate(weekStartDt.getUTCDate() - daysSinceMonday);
      const wsKey = weekStartDt.toISOString().slice(0, 10);
      const weekEndDt = new Date(weekStartDt);
      weekEndDt.setUTCDate(weekEndDt.getUTCDate() + 7);
      const partial = weekStartDt < monthStart || weekEndDt > monthEnd;
      const w = weekMap.get(wsKey) ?? { weekStart: wsKey, tradesCount: 0, realizedPnl: 0, partial };
      w.tradesCount += d.tradesCount;
      w.realizedPnl = Math.round((w.realizedPnl + d.realizedPnl) * 100) / 100;
      weekMap.set(wsKey, w);
    }

    return {
      month: yyyymm,
      days,
      monthTotals: {
        tradesCount: totalTrades,
        realizedPnl: totalPnl,
        winsCount: totalWins,
        lossesCount: totalLosses,
        winRatePct,
      },
      weeklyTotals: Array.from(weekMap.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    };
  }

  async getAvailableMonths(): Promise<{ months: string[]; earliestTradeDate: string | null; latestTradeDate: string | null }> {
    const bounds = await this.prisma.trade.aggregate({
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    const min = bounds._min?.createdAt as Date | null;
    const max = bounds._max?.createdAt as Date | null;
    if (!min || !max) return { months: [], earliestTradeDate: null, latestTradeDate: null };

    const months: string[] = [];
    const cursor = new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1));
    const end = new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth(), 1));
    while (cursor.getTime() <= end.getTime()) {
      const ym = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
      months.push(ym);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return {
      months: months.reverse(),
      earliestTradeDate: min.toISOString().slice(0, 10),
      latestTradeDate: max.toISOString().slice(0, 10),
    };
  }

  deriveOutcome(
    pnl: number | null,
    exitReason: string | null,
  ): JournalOutcome {
    if (exitReason === 'FORCED_CLOSE') return 'FORCED_CLOSE';
    const p = pnl ?? 0;
    if (p > 0.5) return 'WIN';
    if (p < -0.5) return 'LOSS';
    return 'BE';
  }

  async createJournalEntriesForSignal(
    signal: any,
    evalTimeIso: string,
    ctx: {
      d1Adx: number;
      d1Bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
      killzone: 'LONDON' | 'NY' | 'ASIAN' | null;
      h1Atr: number;
      pendingQueueSize: number;
      spread: number;
      accountEquity: number;
      openPositionsCount: number;
      openDirections: Array<'BUY' | 'SELL'>;
      anchorLevel: number | null;
      anchorType: JournalEntryContext['anchorType'] | null;
    },
  ): Promise<void> {
    // Pull the trades that were just created for this signal.
    const trades = await this.prisma.trade.findMany({
      where: {
        symbol: signal.symbol,
        side: signal.side,
        sweepCandleTime: signal.smcContext?.sweepCandleTime
          ? new Date(signal.smcContext.sweepCandleTime)
          : undefined,
        status: { not: 'CLOSED' },
      },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    if (trades.length === 0) return;

    const entryContext: JournalEntryContext = {
      evalTime: evalTimeIso,
      d1Adx: ctx.d1Adx,
      d1Bias: ctx.d1Bias,
      h1Atr: ctx.h1Atr,
      killzone: ctx.killzone,
      pendingQueueSize: ctx.pendingQueueSize,
      spread: ctx.spread,
      accountEquity: ctx.accountEquity,
      openPositionsCount: ctx.openPositionsCount,
      openDirectionsForSymbol: ctx.openDirections,
      anchorLevel: ctx.anchorLevel,
      anchorType: ctx.anchorType,
    };

    const baseSummary = `${signal.mode} ${signal.side} on ${signal.symbol} — D1 ${ctx.d1Bias}, swept ${ctx.anchorType ?? 'level'} at ${ctx.anchorLevel ?? '—'}, ${ctx.killzone ?? '—'} session`;

    await this.prisma.journalEntry.createMany({
      data: trades.map((t: any, idx: number) => ({
        tradeId: t.id,
        setupSummary: `${baseSummary} — ${idx === 0 ? 'TP1 leg' : 'Runner leg'}`,
        llmReasoning: '',
        entryContext: entryContext as any,
        tags: [],
      })),
      skipDuplicates: true,
    });
  }

  async enrichJournalOnExit(tradeId: string): Promise<void> {
    const trade = await this.prisma.trade.findUnique({
      where: { id: tradeId },
    });
    if (!trade || !trade.closedAt) return;

    const holdMinutes = Math.round(
      (trade.closedAt.getTime() - trade.createdAt.getTime()) / 60_000,
    );

    let mfeMaePips: { mfe: number; mae: number } | null = null;
    try {
      const candles = await this.prisma.candle.findMany({
        where: {
          symbol: trade.symbol,
          timeframe: 'M15',
          openTime: { gte: trade.createdAt, lte: trade.closedAt },
        },
        select: { high: true, low: true },
      });
      if (candles.length > 0) {
        const pipSize = trade.symbol === 'XAUUSD' ? 0.1
          : trade.symbol.endsWith('JPY') ? 0.01
          : 0.0001;
        const isBuy = trade.side === 'BUY';
        let mfeRaw = 0, maeRaw = 0;
        for (const c of candles) {
          const favorable = isBuy ? c.high - trade.entryPrice : trade.entryPrice - c.low;
          const adverse  = isBuy ? c.low - trade.entryPrice : trade.entryPrice - c.high;
          if (favorable > mfeRaw) mfeRaw = favorable;
          if (adverse  < maeRaw)  maeRaw  = adverse;
        }
        mfeMaePips = {
          mfe: Math.round((mfeRaw / pipSize) * 10) / 10,
          mae: Math.round((maeRaw / pipSize) * 10) / 10,
        };
      }
    } catch (err) {
      this.logger.warn(`MFE/MAE calc failed for ${tradeId}: ${(err as Error).message}`);
      mfeMaePips = null;
    }

    const exitContext: JournalExitContext = {
      closedAt: trade.closedAt.toISOString(),
      exitReason: (trade.exitReason as JournalExitContext['exitReason']) ?? 'SL',
      holdMinutes,
      exitPrice: trade.closePrice ?? 0,
      mfeMaePips,
      trailedSlAtClose: trade.slPrice,
      originalSlPrice: trade.originalSlPrice,
      beActivated: trade.originalSlPrice !== null && trade.slPrice !== trade.originalSlPrice,
    };

    const outcome = this.deriveOutcome(trade.pnl, trade.exitReason);

    await this.prisma.journalEntry.upsert({
      where: { tradeId },
      create: {
        tradeId,
        setupSummary: '',
        llmReasoning: '',
        exitContext: exitContext as any,
        outcome,
        tags: [],
      } as any,
      update: {
        exitContext: exitContext as any,
        outcome,
      },
    });
  }
}
