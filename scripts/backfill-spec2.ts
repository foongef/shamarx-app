import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const me =
    (await prisma.user.findFirst({
      where: { role: 'SUPERADMIN' },
    })) ?? (await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } }));

  if (me.role !== 'SUPERADMIN') {
    await prisma.user.update({ where: { id: me.id }, data: { role: 'SUPERADMIN' } });
    console.log(`Promoted ${me.email} to SUPERADMIN`);
  }

  // Raw SQL so the script works in BOTH deploy states:
  //   (a) two-phase migration — userId temporarily nullable between
  //       20260609000001 and 20260609000002; rows with NULL get backfilled.
  //   (b) `prisma db push` — schema applied directly to NOT NULL; this UPDATE
  //       matches 0 rows and is a safe no-op.
  // Prisma's typed client rejects `where: { userId: null }` against the
  // final-state schema at validation time, so raw SQL is the only portable shape.
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "DayNote" SET "userId" = $1 WHERE "userId" IS NULL`,
    me.id,
  );
  console.log(`Backfilled ${updated} DayNote rows with userId=${me.id}`);

  await prisma.user.update({
    where: { id: me.id },
    data: { presetKey: 'BALANCED', botEnabled: true },
  });
  console.log(`Ensured ${me.email} has presetKey=BALANCED, botEnabled=true`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
