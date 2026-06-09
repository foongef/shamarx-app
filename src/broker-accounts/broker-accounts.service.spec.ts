import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../crypto/crypto.service';
import { BrokerAccountsService } from './broker-accounts.service';

describe('BrokerAccountsService', () => {
  let service: BrokerAccountsService;
  let prisma: any;
  let crypto: { encrypt: jest.Mock; decrypt: jest.Mock };

  beforeEach(async () => {
    prisma = {
      brokerAccount: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      trade: { count: jest.fn() },
    };
    crypto = {
      encrypt: jest.fn().mockReturnValue({
        ciphertext: Buffer.from('ct'),
        iv: Buffer.from('iv-12bytes!!'),
        authTag: Buffer.from('authtag16bytes!!'),
      }),
      decrypt: jest.fn().mockReturnValue('{"accountId":"a","accessToken":"t"}'),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BrokerAccountsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: crypto },
        { provide: ConfigService, useValue: { get: () => '5' } },
      ],
    }).compile();
    service = moduleRef.get(BrokerAccountsService);
  });

  describe('create', () => {
    it('encrypts creds and persists', async () => {
      prisma.brokerAccount.count.mockResolvedValue(0);
      prisma.brokerAccount.create.mockResolvedValue({ id: 'a1', name: 'Demo' });
      const result = await service.create('user-1', {
        name: 'Demo', broker: 'METAAPI', mode: 'metaapi',
        creds: { accountId: 'meta-acct', accessToken: 'tok' },
      } as any);
      expect(crypto.encrypt).toHaveBeenCalledWith(
        JSON.stringify({ accountId: 'meta-acct', accessToken: 'tok' }),
      );
      expect(prisma.brokerAccount.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1', name: 'Demo', broker: 'METAAPI', mode: 'metaapi',
          encryptedCreds: expect.any(Buffer), credsIv: expect.any(Buffer), credsAuthTag: expect.any(Buffer),
        }),
      }));
      expect(result.id).toBe('a1');
    });

    it('rejects when enabled count is at the soft cap', async () => {
      prisma.brokerAccount.count.mockResolvedValue(5);
      await expect(service.create('user-1', {
        name: 'Sixth', broker: 'METAAPI', mode: 'metaapi', isEnabled: true,
        creds: { accountId: 'a', accessToken: 't' },
      } as any)).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows create with isEnabled=false even when cap is reached', async () => {
      prisma.brokerAccount.count.mockResolvedValue(5);
      prisma.brokerAccount.create.mockResolvedValue({ id: 'a1' });
      await service.create('user-1', {
        name: 'Spare', broker: 'METAAPI', mode: 'metaapi', isEnabled: false,
        creds: { accountId: 'a', accessToken: 't' },
      } as any);
      expect(prisma.brokerAccount.create).toHaveBeenCalled();
    });

    it('rejects CTRADER without pre-serialized creds (must go through OAuth)', async () => {
      prisma.brokerAccount.count.mockResolvedValue(0);
      await expect(
        service.create('user-1', { name: 'X', broker: 'CTRADER', mode: 'metaapi' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists CTRADER with full metadata + encrypted creds from OAuth extra', async () => {
      prisma.brokerAccount.count.mockResolvedValue(0);
      prisma.brokerAccount.create.mockImplementation(async ({ data }: any) => ({ id: 'new-id', ...data }));
      const credsJson = JSON.stringify({
        accessToken: 'a', refreshToken: 'r', ctidTraderAccountId: 42, expiresAt: 1,
      });
      const expiresAt = new Date('2026-07-01T00:00:00Z');
      await service.create(
        'user-1',
        { name: 'ICM Demo', broker: 'CTRADER', mode: 'metaapi', isEnabled: true } as any,
        {
          encryptedCredsJson: credsJson,
          accountNumber: '5286',
          accountKind: 'DEMO',
          brokerName: 'IC Markets',
          oauthExpiresAt: expiresAt,
        },
      );
      expect(crypto.encrypt).toHaveBeenCalledWith(credsJson);
      const createArg = (prisma.brokerAccount.create as jest.Mock).mock.calls[0][0].data;
      expect(createArg.broker).toBe('CTRADER');
      expect(createArg.accountNumber).toBe('5286');
      expect(createArg.accountKind).toBe('DEMO');
      expect(createArg.brokerName).toBe('IC Markets');
      expect(createArg.oauthExpiresAt).toEqual(expiresAt);
    });

    it('rejects METAAPI without a creds object', async () => {
      prisma.brokerAccount.count.mockResolvedValue(0);
      await expect(
        service.create('user-1', { name: 'X', broker: 'METAAPI', mode: 'metaapi' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateCreds', () => {
    it('re-encrypts and persists, optionally updating oauthExpiresAt', async () => {
      prisma.brokerAccount.update.mockImplementation(async ({ data }: any) => ({ id: 'acct-1', ...data }));
      const newCreds = JSON.stringify({ accessToken: 'NEW', refreshToken: 'r2', ctidTraderAccountId: 42, expiresAt: 9 });
      const expiresAt = new Date('2026-07-02T00:00:00Z');
      await service.updateCreds('acct-1', newCreds, expiresAt);
      expect(crypto.encrypt).toHaveBeenCalledWith(newCreds);
      expect(prisma.brokerAccount.update).toHaveBeenCalledWith({
        where: { id: 'acct-1' },
        data: expect.objectContaining({
          encryptedCreds: expect.any(Buffer),
          oauthExpiresAt: expiresAt,
        }),
      });
    });

    it('omits oauthExpiresAt when not provided', async () => {
      prisma.brokerAccount.update.mockImplementation(async ({ data }: any) => ({ id: 'acct-1', ...data }));
      await service.updateCreds('acct-1', '{"a":1}');
      const dataArg = (prisma.brokerAccount.update as jest.Mock).mock.calls[0][0].data;
      expect(dataArg.oauthExpiresAt).toBeUndefined();
    });
  });

  describe('decryptCreds', () => {
    it('returns the decrypted creds as a parsed object', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({
        id: 'acct-1',
        encryptedCreds: Buffer.from('ct'),
        credsIv: Buffer.from('iv'),
        credsAuthTag: Buffer.from('at'),
      });
      crypto.decrypt = jest.fn().mockReturnValue('{"accessToken":"abc","ctidTraderAccountId":42}');
      const result = await service.decryptCreds('acct-1');
      expect(result).toEqual({ accessToken: 'abc', ctidTraderAccountId: 42 });
    });
  });

  describe('findEnabled cache', () => {
    it('caches results within TTL', async () => {
      prisma.brokerAccount.findMany.mockResolvedValue([{ id: 'a1', isEnabled: true }]);
      await service.findEnabled();
      await service.findEnabled();
      expect(prisma.brokerAccount.findMany).toHaveBeenCalledTimes(1);
    });

    it('refetches after invalidate()', async () => {
      prisma.brokerAccount.findMany.mockResolvedValue([{ id: 'a1' }]);
      await service.findEnabled();
      service.invalidate();
      await service.findEnabled();
      expect(prisma.brokerAccount.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('update', () => {
    it('updates and invalidates cache', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'user-1', isEnabled: false });
      prisma.brokerAccount.count.mockResolvedValue(0);
      prisma.brokerAccount.update.mockResolvedValue({ id: 'a1', isEnabled: true });
      prisma.brokerAccount.findMany.mockResolvedValue([{ id: 'a1' }]);
      await service.findEnabled(); // populate cache
      await service.update('user-1', 'a1', { isEnabled: true });
      prisma.brokerAccount.findMany.mockClear();
      await service.findEnabled();
      expect(prisma.brokerAccount.findMany).toHaveBeenCalledTimes(1);
    });

    it('throws 404 when account not found', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue(null);
      await expect(service.update('user-1', 'missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 404 when account belongs to a different user', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'OTHER' });
      await expect(service.update('user-1', 'a1', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects enabling beyond cap', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'user-1', isEnabled: false });
      prisma.brokerAccount.count.mockResolvedValue(5);
      await expect(service.update('user-1', 'a1', { isEnabled: true })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('delete', () => {
    it('refuses delete when account has open trades and force=false', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'user-1' });
      prisma.trade.count.mockResolvedValue(2);
      await expect(service.delete('user-1', 'a1', false)).rejects.toBeInstanceOf(ConflictException);
    });

    it('soft-disables when force=true and open trades exist', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'user-1', isEnabled: true });
      prisma.trade.count.mockResolvedValue(2);
      prisma.brokerAccount.update.mockResolvedValue({});
      await service.delete('user-1', 'a1', true);
      expect(prisma.brokerAccount.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { isEnabled: false },
      });
      expect(prisma.brokerAccount.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes when zero open trades', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'user-1' });
      prisma.trade.count.mockResolvedValue(0);
      prisma.brokerAccount.delete.mockResolvedValue({});
      await service.delete('user-1', 'a1', false);
      expect(prisma.brokerAccount.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    });
  });
});
