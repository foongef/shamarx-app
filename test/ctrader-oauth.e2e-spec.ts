import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule, HttpService } from '@nestjs/axios';
import { PrismaService } from '@app/prisma';
import { RedisService } from '@app/redis';
import * as request from 'supertest';
import { of } from 'rxjs';
import { BrokerAccountsService } from '../src/broker-accounts/broker-accounts.service';
import { BrokerOAuthService } from '../src/broker-accounts/oauth/broker-oauth.service';
import { BrokerOAuthController } from '../src/broker-accounts/oauth/broker-oauth.controller';
import { CryptoService } from '../src/crypto/crypto.service';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';

/**
 * Mocked-Spotware end-to-end test for the cTrader OAuth flow.
 *
 * Boots the OAuth controller + service in isolation (no AppModule, no
 * Postgres) so this runs without a live DB. Real e2e against staging is
 * documented in RUNBOOK.md.
 */
describe('cTrader OAuth (e2e)', () => {
  let app: INestApplication;
  let redisStore: Map<string, string>;
  let http: { post: jest.Mock; get: jest.Mock };
  let accountsService: jest.Mocked<Partial<BrokerAccountsService>>;

  beforeAll(async () => {
    redisStore = new Map();
    const fakeRedis = {
      set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); }),
      get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
      del: jest.fn(async (k: string) => { redisStore.delete(k); }),
    };
    http = { post: jest.fn(), get: jest.fn() };
    accountsService = {
      create: jest.fn(),
      updateCreds: jest.fn(),
      decryptCreds: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({
            CTRADER_CLIENT_ID: 'cid',
            CTRADER_CLIENT_SECRET: 'csec',
            CTRADER_REDIRECT_URI: 'https://shamarx.com/oauth/ctrader/callback',
            CTRADER_AUTH_BASE_URL: 'https://connect.spotware.com',
            CTRADER_TOKEN_URL: 'https://openapi.ctrader.com/apps/token',
            CTRADER_ACCOUNTS_URL: 'https://api.spotware.com/connect/tradingaccounts',
          })],
        }),
        HttpModule,
      ],
      controllers: [BrokerOAuthController],
      providers: [
        BrokerOAuthService,
        { provide: RedisService, useValue: fakeRedis },
        { provide: HttpService, useValue: http },
        { provide: BrokerAccountsService, useValue: accountsService },
        { provide: CryptoService, useValue: { encrypt: jest.fn(), decrypt: jest.fn() } },
        { provide: PrismaService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: 'test-user', email: 'test@example.com', role: 'USER' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    // Stand-in for the global JwtAuthGuard in the real AppModule. In this
    // isolated module test we just inject the user directly.
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: 'test-user', email: 'test@example.com', role: 'USER' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    redisStore.clear();
    jest.clearAllMocks();
  });

  it('happy path: start → callback → finalize creates BrokerAccount', async () => {
    // 1. start
    const startRes = await request(app.getHttpServer())
      .get('/api/broker-accounts/ctrader/oauth/start')
      .expect(200);
    expect(startRes.body.authUrl).toContain('connect.spotware.com');
    const state = startRes.body.state;
    expect(state).toBeTruthy();

    // 2. callback — mock Spotware token + accounts
    http.post.mockReturnValueOnce(of({
      data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 },
    }));
    http.get.mockReturnValueOnce(of({
      data: { data: [
        { ctidTraderAccountId: 42, accountNumber: '52867017', live: false, brokerName: 'IC Markets' },
      ]},
    }));

    const cbRes = await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/callback')
      .send({ code: 'AUTHCODE', state })
      .expect(201);
    expect(cbRes.body.sessionId).toBeTruthy();
    expect(cbRes.body.accounts).toHaveLength(1);
    const sessionId = cbRes.body.sessionId;

    // 3. finalize
    (accountsService.create as jest.Mock).mockResolvedValueOnce({
      id: 'new-id', broker: 'CTRADER', accountNumber: '52867017', accountKind: 'DEMO',
    });

    const finRes = await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/finalize')
      .send({ oauthSessionId: sessionId, ctidTraderAccountId: 42, name: 'My ICM Demo', isEnabled: false })
      .expect(201);
    expect(finRes.body.id).toBe('new-id');
    expect(finRes.body.broker).toBe('CTRADER');

    // BrokerAccountsService.create was called with the OAuth metadata
    expect(accountsService.create).toHaveBeenCalledWith(
      'test-user',
      expect.objectContaining({ name: 'My ICM Demo', broker: 'CTRADER', isEnabled: false }),
      expect.objectContaining({
        accountNumber: '52867017',
        accountKind: 'DEMO',
        brokerName: 'IC Markets',
      }),
    );
  });

  it('callback rejects unknown state', async () => {
    await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/callback')
      .send({ code: 'X', state: 'unknown' })
      .expect(400);
  });

  it('finalize rejects expired session', async () => {
    await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/finalize')
      .send({ oauthSessionId: 'missing', ctidTraderAccountId: 1, name: 'X' })
      .expect(400);
  });

  it('finalize rejects ctidTraderAccountId that isn\'t in the session', async () => {
    // Seed a session manually
    redisStore.set('oauth:ct:session:S1', JSON.stringify({
      userId: 'test-user', accessToken: 'AT', refreshToken: 'RT', expiresAt: 1700000000,
      accounts: [{ ctidTraderAccountId: 1, accountNumber: '111', live: false }],
    }));

    await request(app.getHttpServer())
      .post('/api/broker-accounts/ctrader/finalize')
      .send({ oauthSessionId: 'S1', ctidTraderAccountId: 999, name: 'X' })
      .expect(400);
  });
});
