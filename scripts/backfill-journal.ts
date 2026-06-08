/**
 * Backfills JournalEntry rows for every existing closed Trade.
 *
 * Idempotent — re-running does not duplicate or stomp existing rows. For
 * each Trade without a JournalEntry, synthesises partial entryContext +
 * exitContext from the Trade fields we already have. Marks both as
 * `source: "backfill"` so the UI can render a "backfilled" hint.
 *
 * Run via: pnpm ts-node -P tsconfig.build.json --transpile-only scripts/backfill-journal.ts
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const trades = await prisma.trade.findMany({
      where: { journalEntry: null },
      include: { candidate: true },
    });
    console.log(`Found ${trades.length} trade(s) without JournalEntry — backfilling.`);

    let created = 0;
    for (const t of trades) {
      const mode = (t.candidate?.setupTags ?? []).includes('CONTINUATION') ? 'CONTINUATION' : 'REVERSAL';
      const setupSummary = `${mode} ${t.side} on ${t.symbol} — D1 ${t.d1Bias ?? '—'}, swept ${t.sweptLevel ?? '—'} — backfilled`;

      const entryContext = {
        source: 'backfill',
        evalTime: t.createdAt.toISOString(),
        d1Bias: (t.d1Bias as any) ?? 'NEUTRAL',
        anchorLevel: t.sweptLevel,
        anchorType: null,
      };

      const exitContext = t.closedAt ? {
        source: 'backfill',
        closedAt: t.closedAt.toISOString(),
        exitReason: (t.exitReason as any) ?? 'SL',
        holdMinutes: Math.round((t.closedAt.getTime() - t.createdAt.getTime()) / 60_000),
        exitPrice: t.closePrice ?? 0,
        mfeMaePips: null,
        trailedSlAtClose: t.slPrice,
        originalSlPrice: t.originalSlPrice,
        beActivated: t.originalSlPrice !== null && t.slPrice !== t.originalSlPrice,
      } : null;

      const outcome = t.exitReason === 'FORCED_CLOSE' ? 'FORCED_CLOSE'
        : (t.pnl ?? 0) > 0.5 ? 'WIN'
        : (t.pnl ?? 0) < -0.5 ? 'LOSS'
        : 'BE';

      await prisma.journalEntry.create({
        data: {
          tradeId: t.id,
          setupSummary,
          llmReasoning: '',
          entryContext: entryContext as any,
          exitContext: exitContext as any,
          outcome,
          tags: [],
        },
      });
      created++;
    }
    console.log(`Created ${created} JournalEntry row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
