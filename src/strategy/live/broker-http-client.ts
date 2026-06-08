import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SERVICE_URLS } from '@app/common';
import { BrokerAccountsService } from '../../broker-accounts/broker-accounts.service';
import { CryptoService } from '../../crypto/crypto.service';

interface BrokerPosition {
  ticket: number; symbol: string; side: string; lotSize: number;
  entryPrice: number; currentPrice: number; sl: number; tp: number; pnl: number; openTime: string;
}

interface AccountInfo { balance: number; equity: number; margin: number; freeMargin: number; }

interface OrderResponse { orderId: string; mt5Ticket: number | null; status: string; message?: string; }

@Injectable()
export class BrokerHttpClient {
  private readonly logger = new Logger(BrokerHttpClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly accounts: BrokerAccountsService,
    private readonly crypto: CryptoService,
  ) {}

  private async credsOpts(accountId: string): Promise<{ headers: Record<string, string> }> {
    const acct = await this.accounts.findByIdWithCreds(accountId);
    const creds = this.crypto.decrypt(
      Buffer.from(acct.encryptedCreds),
      Buffer.from(acct.credsIv),
      Buffer.from(acct.credsAuthTag),
    );
    return {
      headers: {
        'X-Broker-Creds': creds,
        'X-Broker-Mode': acct.mode,
      },
    };
  }

  async fetchOpenPositions(accountId: string, symbol?: string): Promise<BrokerPosition[]> {
    const opts = await this.credsOpts(accountId);
    const q = symbol ? `?symbol=${symbol}` : '';
    const res = await firstValueFrom(
      this.http.get<BrokerPosition[]>(`${SERVICE_URLS.EXECUTION}/accounts/${accountId}/positions${q}`, opts),
    );
    return res.data ?? [];
  }

  async placeOrder(accountId: string, signal: any): Promise<OrderResponse> {
    const opts = await this.credsOpts(accountId);
    const res = await firstValueFrom(
      this.http.post<OrderResponse>(`${SERVICE_URLS.EXECUTION}/accounts/${accountId}/orders`, signal, opts),
    );
    return res.data;
  }

  async modify(accountId: string, ticket: number, slPrice: number, tpPrice: number): Promise<void> {
    const opts = await this.credsOpts(accountId);
    await firstValueFrom(
      this.http.post(`${SERVICE_URLS.EXECUTION}/accounts/${accountId}/positions/${ticket}/modify`, { slPrice, tpPrice }, opts),
    );
  }

  async closePosition(accountId: string, ticket: number): Promise<any> {
    const opts = await this.credsOpts(accountId);
    const res = await firstValueFrom(
      this.http.post(`${SERVICE_URLS.EXECUTION}/accounts/${accountId}/positions/${ticket}/close`, {}, opts),
    );
    return res.data;
  }

  async fetchAccount(accountId: string): Promise<AccountInfo> {
    const opts = await this.credsOpts(accountId);
    const res = await firstValueFrom(
      this.http.get<AccountInfo>(`${SERVICE_URLS.EXECUTION}/accounts/${accountId}/account-info`, opts),
    );
    return res.data;
  }

  async fetchPositionHistory(accountId: string, ticket: number): Promise<any> {
    const opts = await this.credsOpts(accountId);
    const res = await firstValueFrom(
      this.http.get(`${SERVICE_URLS.EXECUTION}/accounts/${accountId}/positions/${ticket}/history`, opts),
    );
    return res.data;
  }

  async disconnect(accountId: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${SERVICE_URLS.EXECUTION}/accounts/${accountId}/disconnect`, {}, {}),
    );
  }
}
