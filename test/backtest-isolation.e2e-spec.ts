import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Backtest isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let aliceCookie: string;
  let adminCookie: string;
  let aliceId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.backtestRun.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    const pw = await bcrypt.hash('pass-pass', 10);

    const alice = await prisma.user.create({ data: { email: 'alice@test', passwordHash: pw, role: 'USER' } });
    aliceId = alice.id;
    await prisma.user.create({ data: { email: 'admin@test', passwordHash: pw, role: 'SUPERADMIN' } });

    await prisma.backtestRun.create({
      data: {
        userId: alice.id,
        symbol: 'EURUSD',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-06-30'),
        initialBalance: 10000,
        riskPercent: 1.0,
      },
    });

    const aliceLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'alice@test', password: 'pass-pass' });
    const rawAlice = aliceLogin.headers['set-cookie'] as string | string[] | undefined;
    const aliceCookies: string[] = Array.isArray(rawAlice) ? rawAlice : rawAlice ? [rawAlice] : [];
    aliceCookie = aliceCookies.find((c) => c.startsWith('auth_token='))!.split(';')[0];

    const adminLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@test', password: 'pass-pass' });
    const rawAdmin = adminLogin.headers['set-cookie'] as string | string[] | undefined;
    const adminCookies: string[] = Array.isArray(rawAdmin) ? rawAdmin : rawAdmin ? [rawAdmin] : [];
    adminCookie = adminCookies.find((c) => c.startsWith('auth_token='))!.split(';')[0];
  });

  afterAll(async () => app.close());

  it('alice only sees her own backtest runs', async () => {
    const res = await request(app.getHttpServer()).get('/api/backtest').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userId).toBe(aliceId);
  });

  it('admin sees ALL backtest runs via /api/admin/backtest', async () => {
    const res = await request(app.getHttpServer()).get('/api/admin/backtest').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('alice gets 403 on /api/admin/backtest', async () => {
    const res = await request(app.getHttpServer()).get('/api/admin/backtest').set('Cookie', aliceCookie);
    expect(res.status).toBe(403);
  });

  it('alice creating a backtest sets userId automatically', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/backtest')
      .set('Cookie', aliceCookie)
      .send({ symbol: 'GBPUSD', startDate: '2024-01-01', endDate: '2024-03-31', initialBalance: 10000, riskPercent: 1.0 });
    expect(res.status).toBe(202);
    const run = await prisma.backtestRun.findUnique({ where: { id: res.body.id } });
    expect(run?.userId).toBe(aliceId);
  });
});
