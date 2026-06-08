import { Test } from '@nestjs/testing';
import { MeController } from './me.controller';
import { PrismaService } from '@app/prisma';

describe('MeController', () => {
  let controller: MeController;
  let prisma: PrismaService;
  let user: { id: string; email: string; role: 'USER' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [PrismaService],
    }).compile();
    controller = moduleRef.get(MeController);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
    const created = await prisma.user.create({
      data: { email: 'a@b.test', passwordHash: 'x', role: 'USER' },
    });
    user = { id: created.id, email: created.email, role: 'USER' };
  });

  afterAll(async () => prisma.$disconnect());

  it('GET /me returns the current user with botEnabled + presetKey', async () => {
    const result = await controller.getMe(user as any);
    expect(result).toEqual(expect.objectContaining({
      id: user.id, email: 'a@b.test', botEnabled: true, presetKey: 'BALANCED',
    }));
  });

  it('PATCH /me updates botEnabled', async () => {
    const result = await controller.updateMe(user as any, { botEnabled: false });
    expect(result.botEnabled).toBe(false);
    const dbRow = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbRow!.botEnabled).toBe(false);
  });

  it('PATCH /me updates presetKey', async () => {
    const result = await controller.updateMe(user as any, { presetKey: 'CONSERVATIVE' });
    expect(result.presetKey).toBe('CONSERVATIVE');
  });
});
