import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Multi-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.dayNote.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();

    const pw = await bcrypt.hash('alice-pass', 10);
    const alice = await prisma.user.create({
      data: { email: 'alice@test', passwordHash: pw, role: 'USER' },
    });
    const bob = await prisma.user.create({
      data: { email: 'bob@test', passwordHash: pw, role: 'USER' },
    });
    aliceId = alice.id;
    bobId = bob.id;

    // DayNote uses `date` (DateTime @db.Date) per Task 2 schema
    await prisma.dayNote.create({
      data: { userId: aliceId, date: new Date('2026-06-01'), note: 'alice note' },
    });
    await prisma.dayNote.create({
      data: { userId: bobId, date: new Date('2026-06-01'), note: 'bob note' },
    });

    const aliceLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'alice@test', password: 'alice-pass' });
    const rawAlice = aliceLogin.headers['set-cookie'] as string | string[] | undefined;
    const aliceCookies: string[] = Array.isArray(rawAlice) ? rawAlice : rawAlice ? [rawAlice] : [];
    aliceCookie = aliceCookies.find((c) => c.startsWith('auth_token='))!.split(';')[0];

    const bobLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'bob@test', password: 'alice-pass' });
    const rawBob = bobLogin.headers['set-cookie'] as string | string[] | undefined;
    const bobCookies: string[] = Array.isArray(rawBob) ? rawBob : rawBob ? [rawBob] : [];
    bobCookie = bobCookies.find((c) => c.startsWith('auth_token='))!.split(';')[0];
  });

  afterAll(async () => app.close());

  it("alice can only see her own day note for 2026-06-01", async () => {
    // GET /api/journal/day/:yyyymmdd returns { date, dayNote, trades, dayTotals }
    const res = await request(app.getHttpServer())
      .get('/api/journal/day/2026-06-01')
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.dayNote).toBe('alice note');
  });

  it("bob can only see his own day note for 2026-06-01", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/journal/day/2026-06-01')
      .set('Cookie', bobCookie);
    expect(res.status).toBe(200);
    expect(res.body.dayNote).toBe('bob note');
  });

  it('non-SUPERADMIN gets 403 on /api/admin/users', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Cookie', aliceCookie);
    expect(res.status).toBe(403);
  });

  it('unauthenticated request to journal gets 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/journal/day/2026-06-01');
    expect(res.status).toBe(401);
  });
});
