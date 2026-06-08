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

  // Script runs in the transient state between migration 20260609000001
  // (userId nullable) and 20260609000002 (userId NOT NULL). Prisma's final-
  // state types treat userId as non-nullable, so the null filter needs a
  // narrow cast — at runtime, the column is still nullable.
  const updated = await prisma.dayNote.updateMany({
    where: { userId: null as unknown as string },
    data: { userId: me.id },
  });
  console.log(`Backfilled ${updated.count} DayNote rows with userId=${me.id}`);

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
