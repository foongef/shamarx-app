import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Invite flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminCookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.invite.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();

    const pw = await bcrypt.hash('admin-pass', 10);
    await prisma.user.create({
      data: { email: 'admin@x.test', passwordHash: pw, role: 'SUPERADMIN' },
    });

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@x.test', password: 'admin-pass' });

    const rawLogin = login.headers['set-cookie'] as string | string[] | undefined;
    const loginCookies: string[] = Array.isArray(rawLogin) ? rawLogin : rawLogin ? [rawLogin] : [];
    adminCookie = loginCookies.find((c: string) => c.startsWith('auth_token='))!.split(';')[0];
  });

  afterAll(async () => app.close());

  it('admin creates invite, friend accepts, gets logged in', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/admin/invites')
      .set('Cookie', adminCookie)
      .send({ email: 'alice@example.com' });
    expect(create.status).toBe(201);
    const token = create.body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const preview = await request(app.getHttpServer())
      .get(`/api/invites/${token}/preview`);
    expect(preview.body.valid).toBe(true);
    expect(preview.body.email).toBe('alice@example.com');

    const accept = await request(app.getHttpServer())
      .post(`/api/invites/${token}/accept`)
      .send({ password: 'AliceStrong123!', presetKey: 'BALANCED' });
    expect(accept.status).toBe(200);
    expect(accept.body.user.email).toBe('alice@example.com');

    const rawAccept = accept.headers['set-cookie'] as string | string[] | undefined;
    const acceptCookies: string[] = Array.isArray(rawAccept) ? rawAccept : rawAccept ? [rawAccept] : [];
    const aliceCookie = acceptCookies.find((c: string) => c.startsWith('auth_token='))!.split(';')[0];

    const me = await request(app.getHttpServer())
      .get('/api/me')
      .set('Cookie', aliceCookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('alice@example.com');
    expect(me.body.botEnabled).toBe(true);
    expect(me.body.presetKey).toBe('BALANCED');
  });

  it('reusing the same token fails', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/admin/invites')
      .set('Cookie', adminCookie)
      .send({ email: 'alice@example.com' });
    const token = create.body.token;

    await request(app.getHttpServer())
      .post(`/api/invites/${token}/accept`)
      .send({ password: 'AliceStrong123!', presetKey: 'BALANCED' });

    const second = await request(app.getHttpServer())
      .post(`/api/invites/${token}/accept`)
      .send({ password: 'AliceStrong123!', presetKey: 'BALANCED' });
    expect(second.status).toBe(400);
  });

  it('non-SUPERADMIN cannot create invites', async () => {
    // Create a USER via invite + accept
    const create = await request(app.getHttpServer())
      .post('/api/admin/invites')
      .set('Cookie', adminCookie)
      .send({ email: 'bob@example.com' });
    const token = create.body.token;
    const accept = await request(app.getHttpServer())
      .post(`/api/invites/${token}/accept`)
      .send({ password: 'BobStrong123!', presetKey: 'BALANCED' });

    const rawAccept = accept.headers['set-cookie'] as string | string[] | undefined;
    const acceptCookies: string[] = Array.isArray(rawAccept) ? rawAccept : rawAccept ? [rawAccept] : [];
    const bobCookie = acceptCookies.find((c: string) => c.startsWith('auth_token='))!.split(';')[0];

    const attempt = await request(app.getHttpServer())
      .post('/api/admin/invites')
      .set('Cookie', bobCookie)
      .send({ email: 'eve@example.com' });
    expect(attempt.status).toBe(403);
  });
});
