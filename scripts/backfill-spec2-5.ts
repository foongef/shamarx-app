import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const me = await prisma.user.findFirstOrThrow({ where: { role: 'SUPERADMIN' } });

  // Raw SQL because Prisma's typed client rejects null filters against
  // final-state nullable columns when prod ran `db push` directly.
  const btCount = await prisma.$executeRawUnsafe(
    `UPDATE "BacktestRun" SET "userId" = $1 WHERE "userId" IS NULL`,
    me.id,
  );
  console.log(`Backfilled ${btCount} BacktestRun rows`);

  const replayCount = await prisma.$executeRawUnsafe(
    `UPDATE "LiveReplaySession" SET "userId" = $1 WHERE "userId" IS NULL`,
    me.id,
  );
  console.log(`Backfilled ${replayCount} LiveReplaySession rows`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
