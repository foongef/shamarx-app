import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/prisma';
import { CryptoService } from '../crypto/crypto.service';
import { CreateBrokerAccountDto } from './dto/create-broker-account.dto';
import { UpdateBrokerAccountDto } from './dto/update-broker-account.dto';

const TTL_MS = 30_000;

@Injectable()
export class BrokerAccountsService {
  private readonly logger = new Logger(BrokerAccountsService.name);
  private readonly softCap: number;
  private cache: { value: any[]; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    config: ConfigService,
  ) {
    this.softCap = parseInt(config.get<string>('MULTI_ACCOUNT_SOFT_CAP') || '5', 10);
  }

  async create(userId: string, dto: CreateBrokerAccountDto) {
    if (dto.isEnabled !== false) {
      const enabledCount = await this.prisma.brokerAccount.count({
        where: { userId, isEnabled: true },
      });
      if (enabledCount >= this.softCap) {
        throw new ConflictException(`Soft cap of ${this.softCap} enabled accounts reached`);
      }
    }
    const credsJson = JSON.stringify(dto.creds);
    const { ciphertext, iv, authTag } = this.crypto.encrypt(credsJson);
    const account = await this.prisma.brokerAccount.create({
      data: {
        userId,
        name: dto.name,
        broker: dto.broker,
        mode: dto.mode,
        encryptedCreds: ciphertext,
        credsIv: iv,
        credsAuthTag: authTag,
        isEnabled: dto.isEnabled ?? false,
      } as any,
    });
    this.invalidate();
    return this.toSafe(account);
  }

  async findAllForUser(userId: string) {
    const rows = await this.prisma.brokerAccount.findMany({
      where: { userId },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r: any) => this.toSafe(r));
  }

  async findOneForUser(userId: string, id: string) {
    const acct = await this.prisma.brokerAccount.findUnique({ where: { id } });
    if (!acct || acct.userId !== userId) {
      throw new NotFoundException(`BrokerAccount ${id} not found`);
    }
    return this.toSafe(acct);
  }

  /** Internal — includes the encrypted creds. Use only for execution paths. */
  async findByIdWithCreds(id: string) {
    const acct = await this.prisma.brokerAccount.findUnique({ where: { id } });
    if (!acct) throw new NotFoundException(`BrokerAccount ${id} not found`);
    return acct;
  }

  async findEnabled() {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    const value = await this.prisma.brokerAccount.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    });
    this.cache = { value, expiresAt: Date.now() + TTL_MS };
    return value;
  }

  invalidate() {
    this.cache = null;
  }

  async update(userId: string, id: string, dto: UpdateBrokerAccountDto) {
    const acct = await this.prisma.brokerAccount.findUnique({ where: { id } });
    if (!acct || acct.userId !== userId) {
      throw new NotFoundException(`BrokerAccount ${id} not found`);
    }
    if (dto.isEnabled === true && acct.isEnabled === false) {
      const enabledCount = await this.prisma.brokerAccount.count({
        where: { userId, isEnabled: true },
      });
      if (enabledCount >= this.softCap) {
        throw new ConflictException(`Soft cap of ${this.softCap} enabled accounts reached`);
      }
    }
    const updated = await this.prisma.brokerAccount.update({
      where: { id },
      data: dto as any,
    });
    this.invalidate();
    return this.toSafe(updated);
  }

  async delete(userId: string, id: string, force: boolean) {
    const acct = await this.prisma.brokerAccount.findUnique({ where: { id } });
    if (!acct || acct.userId !== userId) {
      throw new NotFoundException(`BrokerAccount ${id} not found`);
    }
    const openTrades = await this.prisma.trade.count({
      where: { accountId: id, status: 'OPEN' },
    });
    if (openTrades > 0 && !force) {
      throw new ConflictException(
        `Account has ${openTrades} open trade(s). Close them first or pass force=true (soft-disable only).`,
      );
    }
    if (openTrades > 0 && force) {
      await this.prisma.brokerAccount.update({
        where: { id },
        data: { isEnabled: false },
      });
    } else {
      await this.prisma.brokerAccount.delete({ where: { id } });
    }
    this.invalidate();
  }

  private toSafe(row: any) {
    const { encryptedCreds: _e, credsIv: _iv, credsAuthTag: _at, ...rest } = row;
    return rest;
  }
}
