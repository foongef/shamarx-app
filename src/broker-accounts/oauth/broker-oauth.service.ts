import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@app/redis';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { BrokerAccountsService } from '../broker-accounts.service';

export interface SpotwareAccount {
  ctidTraderAccountId: number;
  accountNumber: string | number;
  live: boolean;
  brokerTitle?: string;
  brokerName?: string;
}

interface SpotwareSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accounts: SpotwareAccount[];
}

const STATE_TTL_S = 600;     // 10 min — user has to finish Spotware consent in this window
const SESSION_TTL_S = 1800;  // 30 min — user has to pick an account + confirm in this window

@Injectable()
export class BrokerOAuthService {
  private readonly logger = new Logger(BrokerOAuthService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly accounts: BrokerAccountsService,
  ) {}

  async startOAuth(userId: string): Promise<{ authUrl: string; state: string }> {
    const state = randomBytes(32).toString('base64url');
    await this.redis.set(
      `oauth:ct:state:${state}`,
      JSON.stringify({ userId, createdAt: Date.now() }),
      STATE_TTL_S,
    );
    const authBase = this.config.get<string>('CTRADER_AUTH_BASE_URL') ?? 'https://connect.spotware.com';
    const u = new URL(`${authBase}/apps/auth`);
    u.searchParams.set('client_id', this.config.getOrThrow<string>('CTRADER_CLIENT_ID'));
    u.searchParams.set('redirect_uri', this.config.getOrThrow<string>('CTRADER_REDIRECT_URI'));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'trading');
    u.searchParams.set('state', state);
    return { authUrl: u.toString(), state };
  }

  async handleCallback(code: string, state: string): Promise<{ sessionId: string; accounts: SpotwareAccount[] }> {
    const raw = await this.redis.get(`oauth:ct:state:${state}`);
    if (!raw) throw new BadRequestException('OAuth state expired or invalid');
    const { userId } = JSON.parse(raw);
    await this.redis.del(`oauth:ct:state:${state}`);

    const tokens = await this.exchangeCodeForTokens(code);
    const accounts = await this.fetchTradingAccounts(tokens.accessToken);

    const sessionId = randomBytes(16).toString('base64url');
    const session: SpotwareSession = {
      userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      accounts,
    };
    await this.redis.set(`oauth:ct:session:${sessionId}`, JSON.stringify(session), SESSION_TTL_S);
    return { sessionId, accounts };
  }

  async finalize(
    userId: string,
    oauthSessionId: string,
    ctidTraderAccountId: number,
    name: string,
    isEnabled: boolean,
  ) {
    const raw = await this.redis.get(`oauth:ct:session:${oauthSessionId}`);
    if (!raw) throw new BadRequestException('OAuth session expired or invalid');
    const session = JSON.parse(raw) as SpotwareSession;
    if (session.userId !== userId) throw new ForbiddenException();

    const account = session.accounts.find((a) => a.ctidTraderAccountId === ctidTraderAccountId);
    if (!account) throw new BadRequestException('ctidTraderAccountId not in OAuth session');

    const credsJson = JSON.stringify({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      ctidTraderAccountId,
      expiresAt: session.expiresAt,
      accountKind: account.live ? 'LIVE' : 'DEMO',
    });

    const created = await this.accounts.create(
      userId,
      {
        name,
        broker: 'CTRADER',
        mode: 'metaapi',  // vestigial — anything non-'mock' triggers the live (non-mock) dispatch path
        isEnabled,
      } as any,
      {
        encryptedCredsJson: credsJson,
        accountNumber: String(account.accountNumber),
        accountKind: account.live ? 'LIVE' : 'DEMO',
        brokerName: account.brokerName ?? account.brokerTitle ?? null,
        oauthExpiresAt: new Date(session.expiresAt * 1000),
      },
    );

    await this.redis.del(`oauth:ct:session:${oauthSessionId}`);
    return created;
  }

  async storeRefreshedTokens(
    accountId: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: number },
  ): Promise<void> {
    const existing = await this.accounts.decryptCreds(accountId);
    const merged = JSON.stringify({
      ...existing,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    await this.accounts.updateCreds(accountId, merged, new Date(tokens.expiresAt * 1000));
  }

  private async exchangeCodeForTokens(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    const tokenUrl = this.config.get<string>('CTRADER_TOKEN_URL') ?? 'https://openapi.ctrader.com/apps/token';
    const res = await firstValueFrom(
      this.http.post<{ accessToken: string; refreshToken: string; expiresIn: number }>(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.getOrThrow<string>('CTRADER_REDIRECT_URI'),
          client_id: this.config.getOrThrow<string>('CTRADER_CLIENT_ID'),
          client_secret: this.config.getOrThrow<string>('CTRADER_CLIENT_SECRET'),
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      ),
    );
    return {
      accessToken: res.data.accessToken,
      refreshToken: res.data.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + Number(res.data.expiresIn),
    };
  }

  private async fetchTradingAccounts(accessToken: string): Promise<SpotwareAccount[]> {
    const accountsUrl = this.config.get<string>('CTRADER_ACCOUNTS_URL') ?? 'https://api.spotware.com/connect/tradingaccounts';
    const res = await firstValueFrom(
      this.http.get<{ data: SpotwareAccount[] }>(accountsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return res.data.data ?? [];
  }
}
