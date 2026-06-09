import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { CryptoService } from '../../crypto/crypto.service';
import { BrokerAccountsService } from '../../broker-accounts/broker-accounts.service';
import { BrokerHttpClient } from './broker-http-client';

describe('BrokerHttpClient', () => {
  let client: BrokerHttpClient;
  let http: { get: jest.Mock; post: jest.Mock };
  let accounts: { findByIdWithCreds: jest.Mock };
  let crypto: { decrypt: jest.Mock };

  beforeEach(async () => {
    http = { get: jest.fn(), post: jest.fn() };
    accounts = {
      findByIdWithCreds: jest.fn().mockResolvedValue({
        id: 'a1',
        broker: 'METAAPI',
        mode: 'metaapi',
        encryptedCreds: Buffer.from('ct'),
        credsIv: Buffer.from('iv-12bytes!!'),
        credsAuthTag: Buffer.from('authtag16bytes!!'),
      }),
    };
    crypto = { decrypt: jest.fn().mockReturnValue('{"accountId":"meta","accessToken":"tok"}') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BrokerHttpClient,
        { provide: HttpService, useValue: http },
        { provide: BrokerAccountsService, useValue: accounts },
        { provide: CryptoService, useValue: crypto },
      ],
    }).compile();
    client = moduleRef.get(BrokerHttpClient);
  });

  it('fetchOpenPositions includes accountId in URL and X-Broker-Creds header', async () => {
    http.get.mockReturnValue(of({ data: [{ ticket: 1 }] }));
    const result = await client.fetchOpenPositions('a1', 'EURUSD');
    const [url, opts] = http.get.mock.calls[0];
    expect(url).toMatch(/\/accounts\/a1\/positions\?symbol=EURUSD$/);
    expect(opts.headers['X-Broker']).toBe('METAAPI');
    expect(opts.headers['X-Broker-Creds']).toBe('{"accountId":"meta","accessToken":"tok"}');
    expect(opts.headers['X-Broker-Mode']).toBe('metaapi');
    expect(result).toEqual([{ ticket: 1 }]);
  });

  it('forwards X-Broker=CTRADER for cTrader accounts', async () => {
    accounts.findByIdWithCreds.mockResolvedValue({
      id: 'a2', broker: 'CTRADER', mode: 'metaapi',
      encryptedCreds: Buffer.from('ct'), credsIv: Buffer.from('iv'), credsAuthTag: Buffer.from('at'),
    });
    crypto.decrypt.mockReturnValue('{"accessToken":"AT","refreshToken":"RT","ctidTraderAccountId":42}');
    http.get.mockReturnValue(of({ data: [] }));
    await client.fetchOpenPositions('a2');
    const [, opts] = http.get.mock.calls[0];
    expect(opts.headers['X-Broker']).toBe('CTRADER');
  });

  it('placeOrder POSTs to /accounts/:id/orders', async () => {
    http.post.mockReturnValue(of({ data: { orderId: 'o1' } }));
    const signal: any = { symbol: 'EURUSD', side: 'SELL', totalLot: 0.01 };
    await client.placeOrder('a1', signal);
    const [url, body, opts] = http.post.mock.calls[0];
    expect(url).toMatch(/\/accounts\/a1\/orders$/);
    expect(body).toEqual(signal);
    expect(opts.headers['X-Broker-Creds']).toBeTruthy();
  });

  it('modify POSTs to /accounts/:id/positions/:ticket/modify with SL+TP', async () => {
    http.post.mockReturnValue(of({ data: {} }));
    await client.modify('a1', 12345, 1.1234, 1.5678);
    const [url, body] = http.post.mock.calls[0];
    expect(url).toMatch(/\/accounts\/a1\/positions\/12345\/modify$/);
    expect(body).toEqual({ slPrice: 1.1234, tpPrice: 1.5678 });
  });

  it('disconnect POSTs to /accounts/:id/disconnect without creds header', async () => {
    http.post.mockReturnValue(of({ data: { ok: true } }));
    await client.disconnect('a1');
    const [url, body, opts] = http.post.mock.calls[0];
    expect(url).toMatch(/\/accounts\/a1\/disconnect$/);
    expect(body).toEqual({});
    expect(opts?.headers?.['X-Broker-Creds']).toBeUndefined();
  });

  it('closePosition POSTs to /accounts/:id/positions/:ticket/close with creds header', async () => {
    http.post.mockReturnValue(of({ data: { ok: true } }));
    await client.closePosition('a1', 12345);
    const [url, body, opts] = http.post.mock.calls[0];
    expect(url).toMatch(/\/accounts\/a1\/positions\/12345\/close$/);
    expect(body).toEqual({});
    expect(opts.headers['X-Broker-Creds']).toBeTruthy();
  });
});
