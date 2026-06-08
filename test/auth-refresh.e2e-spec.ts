import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Auth refresh (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    const pw = await bcrypt.hash('pass-pass', 10);
    await prisma.user.create({
      data: { email: 'alice@x.test', passwordHash: pw, role: 'USER' },
    });
  });

  afterAll(async () => app.close());

  it('login → refresh → new token; old token kills chain on reuse', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'alice@x.test', password: 'pass-pass' });
    expect(login.status).toBe(200);

    const rawLogin = login.headers['set-cookie'] as string | string[] | undefined;
    const loginCookies: string[] = Array.isArray(rawLogin) ? rawLogin : rawLogin ? [rawLogin] : [];
    const oldRefresh = loginCookies.find((c: string) => c.startsWith('refresh_token='))!.split(';')[0];

    const refresh = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', oldRefresh);
    expect(refresh.status).toBe(200);

    const rawRefresh = refresh.headers['set-cookie'] as string | string[] | undefined;
    const refreshCookies: string[] = Array.isArray(rawRefresh) ? rawRefresh : rawRefresh ? [rawRefresh] : [];
    const newRefresh = refreshCookies.find((c: string) => c.startsWith('refresh_token='))!.split(';')[0];
    expect(newRefresh).not.toEqual(oldRefresh);

    // Reuse the old token — should be revoked
    const reuse = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', oldRefresh);
    expect(reuse.status).toBe(401);

    // The new refresh should now also be dead (chain revocation)
    const newReuse = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', newRefresh);
    expect(newReuse.status).toBe(401);
  });

  it('refresh with no cookie returns null user', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});
