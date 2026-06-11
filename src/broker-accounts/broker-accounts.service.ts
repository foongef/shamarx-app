import { Optional, Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/prisma';
import { Mt5HostService } from '../mt5-hosts/mt5-host.service';
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
    @Optional() private readonly mt5Hosts?: Mt5HostService,
  ) {
    this.softCap = parseInt(config.get<string>('MULTI_ACCOUNT_SOFT_CAP') || '5', 10);
  }

  async create(
    userId: string,
    dto: CreateBrokerAccountDto,
    extra?: {
      encryptedCredsJson: string;
      accountNumber?: string | null;
      accountKind?: 'DEMO' | 'LIVE' | null;
      brokerName?: string | null;
      oauthExpiresAt?: Date | null;
    },
  ) {
    if (dto.isEnabled !== false) {
      const enabledCount = await this.prisma.brokerAccount.count({
        where: { userId, isEnabled: true },
      });
      if (enabledCount >= this.softCap) {
        throw new ConflictException(`Soft cap of ${this.softCap} enabled accounts reached`);
      }
    }

    this.validateCreds(dto);

    let credsJson: string;
    if (dto.broker === 'CTRADER') {
      if (!extra?.encryptedCredsJson) {
        throw new BadRequestException('CTRADER accounts must be created via the OAuth flow');
      }
      credsJson = extra.encryptedCredsJson;
    } else {
      if (!dto.creds) {
        throw new BadRequestException(`${dto.broker} accounts require a creds object`);
      }
      credsJson = JSON.stringify(dto.creds);
    }

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
        accountNumber: extra?.accountNumber ?? null,
        accountKind: extra?.accountKind ?? null,
        brokerName: extra?.brokerName ?? null,
        oauthExpiresAt: extra?.oauthExpiresAt ?? null,
      } as any,
    });
    this.invalidate();

    // MT5_DIRECT: provision the terminal synchronously. Fail-clean — a bad
    // login or full fleet must not leave a zombie BrokerAccount row.
    if (dto.broker === 'MT5_DIRECT' && this.mt5Hosts) {
      try {
        await this.mt5Hosts.provision(account.id, dto.creds as any);
      } catch (err) {
        await this.prisma.brokerAccount.delete({ where: { id: account.id } });
        this.invalidate();
        throw err;
      }
    }
    return this.toSafe(account);
  }

  async updateCreds(accountId: string, credsJson: string, oauthExpiresAt?: Date) {
    const { ciphertext, iv, authTag } = this.crypto.encrypt(credsJson);
    const updated = await this.prisma.brokerAccount.update({
      where: { id: accountId },
      data: {
        encryptedCreds: ciphertext,
        credsIv: iv,
        credsAuthTag: authTag,
        ...(oauthExpiresAt ? { oauthExpiresAt } : {}),
      } as any,
    });
    this.invalidate();
    return this.toSafe(updated);
  }

  async decryptCreds(accountId: string): Promise<Record<string, unknown>> {
    const acct = await this.findByIdWithCreds(accountId);
    const json = this.crypto.decrypt(
      Buffer.from(acct.encryptedCreds),
      Buffer.from(acct.credsIv),
      Buffer.from(acct.credsAuthTag),
    );
    return JSON.parse(json);
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
      include: { user: true },
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
      if (acct.broker === 'MT5_DIRECT' && this.mt5Hosts) {
        await this.mt5Hosts.deprovision(id);
      }
      await this.prisma.brokerAccount.delete({ where: { id } });
    }
    this.invalidate();
  }

  /** Per-broker creds shape check — the DTO can't discriminate the union. */
  private validateCreds(dto: CreateBrokerAccountDto) {
    if (dto.broker === 'CTRADER' || !dto.creds) return;
    const c = dto.creds as unknown as Record<string, unknown>;
    const requireStr = (key: string, max: number) => {
      const v = c[key];
      if (typeof v !== 'string' || v.length === 0 || v.length > max) {
        throw new BadRequestException(`creds.${key} must be a non-empty string (max ${max} chars)`);
      }
    };
    if (dto.broker === 'MT5_DIRECT') {
      requireStr('login', 32);
      requireStr('password', 128);
      requireStr('server', 128);
    } else {
      requireStr('accountId', 128);
      requireStr('accessToken', 1024);
    }
  }

  private toSafe(row: any) {
    const { encryptedCreds: _e, credsIv: _iv, credsAuthTag: _at, ...rest } = row;
    return rest;
  }
}
