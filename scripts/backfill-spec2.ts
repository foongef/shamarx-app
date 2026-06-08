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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await (prisma.dayNote as any).updateMany({
    where: { userId: null },
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
