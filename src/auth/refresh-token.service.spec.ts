import { Test } from '@nestjs/testing';
import { RefreshTokenService } from './refresh-token.service';
import { PrismaService } from '@app/prisma';

describe('RefreshTokenService', () => {
  let svc: RefreshTokenService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [RefreshTokenService, PrismaService],
    }).compile();
    svc = moduleRef.get(RefreshTokenService);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeUser() {
    return prisma.user.create({
      data: { email: `u${Date.now()}@x.test`, passwordHash: 'x', role: 'USER' },
    });
  }

  it('issue() returns raw token and stores hash', async () => {
    const user = await makeUser();
    const { token } = await svc.issue(user.id, 'agent');
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(token);
  });

  it('rotate() revokes old and returns new', async () => {
    const user = await makeUser();
    const a = await svc.issue(user.id, 'agent');
    const b = await svc.rotate(a.token, 'agent');
    const oldRow = await prisma.refreshToken.findFirst({ where: { id: a.id } });
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(oldRow?.replacedById).toBe(b.id);
    expect(b.token).not.toBe(a.token);
  });

  it('rotate() detects reuse and kills the whole family', async () => {
    const user = await makeUser();
    const a = await svc.issue(user.id, 'agent');
    const b = await svc.rotate(a.token, 'agent');
    await expect(svc.rotate(a.token, 'agent')).rejects.toThrow(/Invalid or expired/i);
    const bRow = await prisma.refreshToken.findFirst({ where: { id: b.id } });
    expect(bRow?.revokedAt).not.toBeNull();
  });

  it('rotate() fails for expired token', async () => {
    const user = await makeUser();
    const { token, id } = await svc.issue(user.id, 'agent');
    await prisma.refreshToken.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(svc.rotate(token, 'agent')).rejects.toThrow(/Invalid or expired/i);
  });

  it('revokeAllForUser() marks every active row as revoked', async () => {
    const user = await makeUser();
    await svc.issue(user.id, 'a');
    await svc.issue(user.id, 'b');
    await svc.revokeAllForUser(user.id);
    const active = await prisma.refreshToken.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toHaveLength(0);
  });
});
