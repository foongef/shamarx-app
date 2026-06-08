import { Test } from '@nestjs/testing';
import { AdminUsersService } from './admin-users.service';
import { PrismaService } from '@app/prisma';
import { RefreshTokenService } from '../../auth/refresh-token.service';

describe('AdminUsersService', () => {
  let svc: AdminUsersService;
  let prisma: PrismaService;
  const refreshMock = { revokeAllForUser: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        PrismaService,
        { provide: RefreshTokenService, useValue: refreshMock },
      ],
    }).compile();
    svc = moduleRef.get(AdminUsersService);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.brokerAccount.deleteMany();
    await prisma.user.deleteMany();
    refreshMock.revokeAllForUser.mockClear();
  });

  afterAll(async () => prisma.$disconnect());

  it('list() returns users with derived counts', async () => {
    await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER' } });
    await prisma.user.create({ data: { email: 'b@x', passwordHash: 'p', role: 'SUPERADMIN' } });
    const list = await svc.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(expect.objectContaining({
      email: expect.any(String),
      role: expect.any(String),
      botEnabled: true,
      isActive: true,
      accountsTotal: 0,
      accountsEnabled: 0,
    }));
  });

  it('setActive(false) revokes all refresh tokens', async () => {
    const u = await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER' } });
    await svc.setActive(u.id, false);
    expect(refreshMock.revokeAllForUser).toHaveBeenCalledWith(u.id);
    const after = await prisma.user.findUnique({ where: { id: u.id } });
    expect(after!.isActive).toBe(false);
  });

  it('setBotEnabled toggles user.botEnabled', async () => {
    const u = await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER' } });
    await svc.setBotEnabled(u.id, false);
    expect((await prisma.user.findUnique({ where: { id: u.id } }))!.botEnabled).toBe(false);
  });
});
