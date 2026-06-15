import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { RedisService } from '@app/redis';
import { BrokerOAuthService } from './broker-oauth.service';
import { BrokerAccountsService } from '../broker-accounts.service';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    set: jest.fn(async (k: string, v: string, _ttl?: number) => { store.set(k, v); }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => { store.delete(k); }),
    _store: store,
  };
}

describe('BrokerOAuthService', () => {
  let svc: BrokerOAuthService;
  let redis: ReturnType<typeof makeRedis>;
  let accounts: jest.Mocked<Partial<BrokerAccountsService>>;
  let http: { post: jest.Mock; get: jest.Mock };
  let config: { get: jest.Mock; getOrThrow: jest.Mock };

  beforeEach(async () => {
    redis = makeRedis();
    accounts = { create: jest.fn(), updateCreds: jest.fn(), decryptCreds: jest.fn() };
    http = { post: jest.fn(), get: jest.fn() };
    config = {
      get: jest.fn((k: string) => ({
        CTRADER_AUTH_BASE_URL: 'https://connect.spotware.com',
        CTRADER_TOKEN_URL: 'https://openapi.ctrader.com/apps/token',
        CTRADER_ACCOUNTS_URL: 'https://api.spotware.com/connect/tradingaccounts',
      } as Record<string, string>)[k]),
      getOrThrow: jest.fn((k: string) => ({
        CTRADER_CLIENT_ID: 'cid',
        CTRADER_CLIENT_SECRET: 'csec',
        CTRADER_REDIRECT_URI: 'https://shamarx.com/oauth/ctrader/callback',
      } as Record<string, string>)[k]),
    };

    const mod = await Test.createTestingModule({
      providers: [
        BrokerOAuthService,
        { provide: RedisService, useValue: redis },
        { provide: HttpService, useValue: http },
        { provide: ConfigService, useValue: config },
        { provide: BrokerAccountsService, useValue: accounts },
      ],
    }).compile();
    svc = mod.get(BrokerOAuthService);
  });

  describe('startOAuth', () => {
    it('returns a Spotware authUrl with state stored in Redis (TTL 600)', async () => {
      const { authUrl, state } = await svc.startOAuth('user-1');
      expect(authUrl).toContain('connect.spotware.com/apps/auth');
      expect(authUrl).toContain(`state=${state}`);
      expect(authUrl).toContain('client_id=cid');
      expect(authUrl).toContain('scope=trading');
      expect(redis.set).toHaveBeenCalledWith(
        `oauth:ct:state:${state}`,
        expect.stringContaining('"userId":"user-1"'),
        600,
      );
    });
  });

  describe('handleCallback', () => {
    it('rejects unknown state', async () => {
      await expect(svc.handleCallback('code', 'unknown')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('exchanges code, fetches accounts, stores session (TTL 1800), deletes state', async () => {
      await redis.set('oauth:ct:state:S1', JSON.stringify({ userId: 'u1' }), 600);
      // cTrader token exchange + accounts fetch are BOTH GETs, in that order.
      http.get
        .mockReturnValueOnce(of({
          data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 },
        }))
        .mockReturnValueOnce(of({
          data: { data: [
            { ctidTraderAccountId: 1, accountNumber: '111', live: false, brokerName: 'IC' },
            { ctidTraderAccountId: 2, accountNumber: '222', live: true, brokerName: 'IC' },
          ]},
        }));

      const { sessionId, accounts: list } = await svc.handleCallback('CODE', 'S1');

      expect(list).toHaveLength(2);
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(redis.del).toHaveBeenCalledWith('oauth:ct:state:S1');
      const sessionWrite = (redis.set as jest.Mock).mock.calls.find(([k]) => k === `oauth:ct:session:${sessionId}`);
      expect(sessionWrite).toBeDefined();
      expect(sessionWrite![2]).toBe(1800); // TTL arg
      const stored = JSON.parse(sessionWrite![1] as string);
      expect(stored.userId).toBe('u1');
      expect(stored.accessToken).toBe('AT');
      expect(stored.accounts).toHaveLength(2);
    });
  });

  describe('finalize', () => {
    it('rejects expired session', async () => {
      await expect(svc.finalize('u1', 'missing', 1, 'name', false))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects userId mismatch', async () => {
      await redis.set('oauth:ct:session:S', JSON.stringify({
        userId: 'otheruser', accessToken: 'a', refreshToken: 'r', expiresAt: 0, accounts: [],
      }), 1800);
      await expect(svc.finalize('u1', 'S', 1, 'name', false)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects unknown ctidTraderAccountId', async () => {
      await redis.set('oauth:ct:session:S', JSON.stringify({
        userId: 'u1', accessToken: 'a', refreshToken: 'r', expiresAt: 0,
        accounts: [{ ctidTraderAccountId: 1, accountNumber: '1', live: false }],
      }), 1800);
      await expect(svc.finalize('u1', 'S', 999, 'name', false)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates BrokerAccount with full metadata and deletes session', async () => {
      const sess = {
        userId: 'u1', accessToken: 'AT', refreshToken: 'RT', expiresAt: 1700000000,
        accounts: [{ ctidTraderAccountId: 42, accountNumber: '5286', live: false, brokerName: 'IC Markets' }],
      };
      await redis.set('oauth:ct:session:S', JSON.stringify(sess), 1800);
      (accounts.create as jest.Mock).mockResolvedValue({ id: 'new-id' });

      await svc.finalize('u1', 'S', 42, 'My ICM Demo', true);

      const [userId, dto, extra] = (accounts.create as jest.Mock).mock.calls[0];
      expect(userId).toBe('u1');
      expect(dto).toMatchObject({ name: 'My ICM Demo', broker: 'CTRADER', isEnabled: true });
      expect(extra).toMatchObject({
        accountNumber: '5286',
        accountKind: 'DEMO',
        brokerName: 'IC Markets',
      });
      const credsJson = JSON.parse(extra.encryptedCredsJson);
      expect(credsJson.accessToken).toBe('AT');
      expect(credsJson.ctidTraderAccountId).toBe(42);
      expect(redis.del).toHaveBeenCalledWith('oauth:ct:session:S');
    });
  });

  describe('storeRefreshedTokens', () => {
    it('merges fresh tokens into existing creds and calls updateCreds', async () => {
      (accounts.decryptCreds as jest.Mock).mockResolvedValue({
        accessToken: 'OLD', refreshToken: 'OLD_R', ctidTraderAccountId: 42, expiresAt: 1,
        accountKind: 'DEMO',
      });
      await svc.storeRefreshedTokens('acct-1', {
        accessToken: 'NEW', refreshToken: 'NEW_R', expiresAt: 9999999,
      });
      const [accountId, mergedJson, expiresAt] = (accounts.updateCreds as jest.Mock).mock.calls[0];
      expect(accountId).toBe('acct-1');
      const merged = JSON.parse(mergedJson);
      expect(merged.accessToken).toBe('NEW');
      expect(merged.refreshToken).toBe('NEW_R');
      expect(merged.ctidTraderAccountId).toBe(42);  // preserved
      expect(merged.accountKind).toBe('DEMO');       // preserved
      expect(expiresAt).toEqual(new Date(9999999 * 1000));
    });
  });
});
