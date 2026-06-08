import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
