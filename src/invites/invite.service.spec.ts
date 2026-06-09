import { Test } from '@nestjs/testing';
import { InviteService } from './invite.service';
import { PrismaService } from '@app/prisma';
import { MailService } from '../mail/mail.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';

describe('InviteService', () => {
  let svc: InviteService;
  let prisma: PrismaService;

  const mailMock = { sendInvite: jest.fn().mockResolvedValue(undefined) };
  const authMock = { signAccessToken: jest.fn(() => 'jwt-fake') };
  const refreshMock = {
    issue: jest.fn().mockResolvedValue({ id: 'r1', token: 'raw-token' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InviteService,
        PrismaService,
        UsersService,
        { provide: MailService, useValue: mailMock },
        { provide: AuthService, useValue: authMock },
        { provide: RefreshTokenService, useValue: refreshMock },
      ],
    }).compile();
    svc = moduleRef.get(InviteService);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.invite.deleteMany();
    await prisma.user.deleteMany();
    mailMock.sendInvite.mockClear();
  });

  afterAll(async () => prisma.$disconnect());

  async function makeAdmin() {
    return prisma.user.create({
      data: { email: 'admin@x.test', passwordHash: 'x', role: 'SUPERADMIN' },
    });
  }

  it('create() generates an invite, stores hash, sends email', async () => {
    const admin = await makeAdmin();
    const { invite, token } = await svc.create('alice@example.com', admin.id, 7);
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(invite.email).toBe('alice@example.com');
    expect(invite.acceptedAt).toBeNull();
    expect(mailMock.sendInvite).toHaveBeenCalledWith('alice@example.com', expect.stringContaining(token));
  });

  it('create() refuses if email already belongs to a user', async () => {
    const admin = await makeAdmin();
    await prisma.user.create({
      data: { email: 'taken@example.com', passwordHash: 'x', role: 'USER' },
    });
    await expect(svc.create('taken@example.com', admin.id, 7)).rejects.toThrow(/already exists/);
    expect(mailMock.sendInvite).not.toHaveBeenCalled();
  });

  it('create() normalises email casing and refuses case-mismatched duplicates', async () => {
    const admin = await makeAdmin();
    await prisma.user.create({
      data: { email: 'mixed@example.com', passwordHash: 'x', role: 'USER' },
    });
    await expect(svc.create('Mixed@Example.COM', admin.id, 7)).rejects.toThrow(/already exists/);
  });

  it('preview() returns null when a user was created with the email AFTER the invite was issued', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('bob@example.com', admin.id, 7);
    // Simulate the user being created via some other path while the invite sits idle
    await prisma.user.create({
      data: { email: 'bob@example.com', passwordHash: 'x', role: 'USER' },
    });
    const preview = await svc.preview(token);
    expect(preview).toBeNull();
  });

  it('preview() returns invite when valid', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('alice@example.com', admin.id, 7);
    const preview = await svc.preview(token);
    expect(preview).toEqual({ email: 'alice@example.com', expiresAt: expect.any(Date) });
  });

  it('preview() returns null when expired', async () => {
    const admin = await makeAdmin();
    const { token, invite } = await svc.create('alice@example.com', admin.id, 7);
    await prisma.invite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await svc.preview(token)).toBeNull();
  });

  it('preview() returns null when already accepted', async () => {
    const admin = await makeAdmin();
    const { token, invite } = await svc.create('alice@example.com', admin.id, 7);
    await prisma.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });
    expect(await svc.preview(token)).toBeNull();
  });

  it('accept() creates user and marks invite used', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('alice@example.com', admin.id, 7);
    const result = await svc.accept(token, 'StrongPass123!', 'BALANCED', 'agent');
    expect(result.user.email).toBe('alice@example.com');
    expect(result.user.role).toBe('USER');
    expect(result.accessToken).toBe('jwt-fake');
    expect(result.refreshToken).toBe('raw-token');
    const after = await prisma.invite.findFirst({ where: { email: 'alice@example.com' } });
    expect(after?.acceptedAt).not.toBeNull();
  });

  it('accept() fails on reused token', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('alice@example.com', admin.id, 7);
    await svc.accept(token, 'StrongPass123!', 'BALANCED');
    await expect(svc.accept(token, 'StrongPass123!', 'BALANCED')).rejects.toThrow();
  });

  it('accept() fails if email already a user', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('admin@x.test', admin.id, 7);
    await expect(svc.accept(token, 'StrongPass123!', 'BALANCED')).rejects.toThrow(/exists/i);
  });

  it('list() returns invites with creator email', async () => {
    const admin = await makeAdmin();
    await svc.create('a@x', admin.id, 7);
    await svc.create('b@x', admin.id, 7);
    const list = await svc.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(expect.objectContaining({ email: expect.any(String), status: 'pending' }));
  });

  it('revoke() sets expiresAt to now', async () => {
    const admin = await makeAdmin();
    const { invite } = await svc.create('alice@example.com', admin.id, 7);
    await svc.revoke(invite.id);
    const after = await prisma.invite.findUnique({ where: { id: invite.id } });
    expect(after!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
