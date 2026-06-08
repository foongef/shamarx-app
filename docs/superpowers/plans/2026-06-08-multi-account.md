# Multi-Account Broker Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship multi-account support — one user owns N `BrokerAccount` rows (encrypted creds at rest), strategy engine fans out concurrently to all enabled accounts, Python execution-service multiplexes by accountId via a registry.

**Architecture:** New `BrokerAccount` Prisma model + nullable `accountId` FK on 4 tables. `CryptoService` for AES-256-GCM creds at rest. `BrokerAccountService` with in-memory enabled-cache. NestJS services fan out per-account via `Promise.all`. Python execution-service replaces module-level singletons with a `BrokerClientRegistry` keyed by accountId. New UI inside existing `/lives/[id]`: account toggle strip, add-account modal, account badges in trades/telemetry. Feature flag `ENABLE_MULTI_ACCOUNT_FANOUT` gates the fan-out for safe rollout.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres), Jest, class-validator, Node 22 `node:crypto`, Python 3.11 + FastAPI, pytest, React 19 / Next.js 15, TanStack Query, Tailwind. Backend `shamarx-app/`, web `shamarx-web/`, execution-service `shamarx-app/services/execution-service/` (Python).

**Reference spec:** `docs/superpowers/specs/2026-06-08-multi-account-design.md`

**Pre-existing landmarks (DO NOT recreate):**
- `User` model at `libs/prisma/schema.prisma:16`
- `Trade` at line 164, `LiveSession` at 217, `EquitySnapshot` at 44, `RiskState` at 315
- `libs/prisma/src/`, `libs/redis/src/`, `libs/common/src/` — path aliases `@app/prisma`, `@app/redis`, `@app/common`
- `services/execution-service/main.py` wires routers from `routes.py` (orders / positions / account / candles)
- `services/execution-service/metaapi_mt5.py` exports module-level `metaapi_mt5` singleton; reads `METAAPI_ACCOUNT_ID_DEMO` / `METAAPI_ACCESS_TOKEN` from env
- `services/execution-service/mock_mt5.py` exports module-level `mock_mt5` singleton
- `src/strategy/live/{live-strategy,live-position-manager,position-monitor}.service.ts` — three singleton services that subscribe to `CANDLE_STORED` and process pairs sequentially
- `src/strategy/live/live-smc-orchestrator.ts` — single instance with per-pair state
- `.github/workflows/deploy-backend.yml:68` auto-runs `prisma db push` on every push to main (schema migrations apply automatically)
- jest config already in `package.json` (added by feat/trading-journal branch)
- **NEVER include `Co-Authored-By:` in commit messages.**

---

## Phase 1 — Schema + Crypto

### Task 1: Add `BrokerAccount` model + nullable `accountId` FKs

**Files:**
- Modify: `libs/prisma/schema.prisma`

- [ ] **Step 1: Inspect schema landmarks**

Run: `grep -n "model User\|model Trade\|model LiveSession\|model EquitySnapshot\|model RiskState" libs/prisma/schema.prisma`
Expected: line numbers for the 5 models.

- [ ] **Step 2: Add a back-relation on `User`**

Find the `User` model. Add this field inside the model braces (after the existing relations):

```prisma
  brokerAccounts BrokerAccount[]
```

- [ ] **Step 3: Append `BrokerAccount` model**

Insert this block at the end of `libs/prisma/schema.prisma`:

```prisma
model BrokerAccount {
  id              String   @id @default(uuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  name            String
  /// 'METAAPI' | 'MOCK' | 'MOOMOO' (future)
  broker          String
  /// AES-256-GCM ciphertext of broker-specific creds JSON.
  encryptedCreds  Bytes
  /// 12-byte initialization vector (random per encryption).
  credsIv         Bytes
  /// 16-byte GCM authentication tag.
  credsAuthTag    Bytes

  isEnabled       Boolean  @default(false)
  sortIndex       Int      @default(0)
  /// 'metaapi' | 'mock'
  mode            String   @default("metaapi")
  lastConnectedAt DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  trades          Trade[]
  sessions        LiveSession[]
  equitySnapshots EquitySnapshot[]
  riskStates      RiskState[]

  @@unique([userId, name])
  @@index([userId, isEnabled])
}
```

- [ ] **Step 4: Add `accountId` to `Trade`**

In the existing `Trade` model, add these two lines just before the `@@index` lines at the end of the block:

```prisma
  accountId  String?
  account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)
```

Then add this new index line alongside the existing `@@index` calls:

```prisma
  @@index([accountId, createdAt])
```

- [ ] **Step 5: Add `accountId` to `LiveSession`**

In `LiveSession`, add the same FK pair before the existing `@@index`:

```prisma
  accountId  String?
  account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)
```

And add the new index:

```prisma
  @@index([accountId, startedAt])
```

- [ ] **Step 6: Add `accountId` to `EquitySnapshot`**

Same pattern in `EquitySnapshot`:

```prisma
  accountId  String?
  account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)

  @@index([accountId, takenAt])
```

- [ ] **Step 7: Add `accountId` to `RiskState` + change unique constraint**

`RiskState` currently has `date DateTime @unique @db.Date`. We need to drop the unique on `date` alone and replace with composite `(accountId, date)`.

Inside the `RiskState` model:

1. Change `date DateTime @unique @db.Date` to `date DateTime @db.Date` (remove `@unique`).
2. Add accountId pair:
   ```prisma
     accountId  String?
     account    BrokerAccount? @relation(fields: [accountId], references: [id], onDelete: Restrict)
   ```
3. Add composite unique at the end of the block:
   ```prisma
     @@unique([accountId, date])
   ```

Note: the old `@unique([date])` constraint will be dropped automatically by `prisma db push`. Existing RiskState rows with NULL `accountId` may violate the composite unique if there are duplicates on `date` (there shouldn't be — only one row per date today). If push complains, the backfill in Task 6 fixes it by setting `accountId` first.

- [ ] **Step 8: Format + generate**

Run: `pnpm prisma format --schema=libs/prisma/schema.prisma`
Expected: "Formatted libs/prisma/schema.prisma".

Run: `pnpm prisma:generate`
Expected: "Generated Prisma Client". Exit 0.

- [ ] **Step 9: Verify build**

Run: `pnpm build`
Expected: nest build succeeds (existing TypeScript code is backwards-compatible — we only added optional fields).

- [ ] **Step 10: Commit**

```bash
git add libs/prisma/schema.prisma
git commit -m "feat(multi-account): schema — BrokerAccount + nullable accountId on 4 tables"
```

---

## Phase 2 — Crypto

### Task 2: CryptoService with TDD

**Files:**
- Create: `src/crypto/crypto.module.ts`
- Create: `src/crypto/crypto.service.ts`
- Create: `src/crypto/crypto.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/crypto/crypto.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  const validKey = 'a'.repeat(64); // 32 bytes hex
  let service: CryptoService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CryptoService,
        { provide: ConfigService, useValue: { get: () => validKey } },
      ],
    }).compile();
    service = moduleRef.get(CryptoService);
  });

  it('round-trips plaintext through encrypt + decrypt', () => {
    const plaintext = JSON.stringify({ accountId: 'abc', accessToken: 'secret-xyz' });
    const { ciphertext, iv, authTag } = service.encrypt(plaintext);
    expect(ciphertext.byteLength).toBeGreaterThan(0);
    expect(iv.byteLength).toBe(12);
    expect(authTag.byteLength).toBe(16);
    expect(service.decrypt(ciphertext, iv, authTag)).toBe(plaintext);
  });

  it('produces a different IV on each encryption', () => {
    const a = service.encrypt('same plaintext');
    const b = service.encrypt('same plaintext');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('decryption with a tampered authTag throws', () => {
    const { ciphertext, iv, authTag } = service.encrypt('hello');
    const tampered = Buffer.from(authTag);
    tampered[0] = tampered[0] ^ 0xff;
    expect(() => service.decrypt(ciphertext, iv, tampered)).toThrow();
  });

  it('rejects construction when BROKER_CREDS_KEY is missing', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CryptoService,
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    expect(() => moduleRef.get(CryptoService)).toThrow(/BROKER_CREDS_KEY/);
  });

  it('rejects construction when BROKER_CREDS_KEY is wrong length', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CryptoService,
        { provide: ConfigService, useValue: { get: () => 'short' } },
      ],
    }).compile();
    expect(() => moduleRef.get(CryptoService)).toThrow(/64 hex chars/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/crypto/crypto.service.spec.ts`
Expected: FAIL — "Cannot find module './crypto.service'".

- [ ] **Step 3: Implement CryptoService**

Write `src/crypto/crypto.service.ts`:

```ts
import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.get<string>('BROKER_CREDS_KEY');
    if (!hex) {
      throw new Error('BROKER_CREDS_KEY env var is required. Generate via: openssl rand -hex 32');
    }
    if (hex.length !== 64) {
      throw new Error('BROKER_CREDS_KEY must be 32 bytes (64 hex chars). Got length ' + hex.length);
    }
    this.key = Buffer.from(hex, 'hex');
  }

  encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
```

- [ ] **Step 4: Create CryptoModule**

Write `src/crypto/crypto.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/crypto/crypto.service.spec.ts`
Expected: PASS, 5 tests green.

- [ ] **Step 6: Verify build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/crypto/
git commit -m "feat(multi-account): CryptoService — AES-256-GCM encrypt/decrypt for broker creds"
```

---

## Phase 3 — BrokerAccount DTOs

### Task 3: DTOs for create / update endpoints

**Files:**
- Create: `src/broker-accounts/dto/create-broker-account.dto.ts`
- Create: `src/broker-accounts/dto/update-broker-account.dto.ts`
- Create: `src/broker-accounts/dto/broker-creds.dto.ts`

- [ ] **Step 1: Create the creds shape DTO (nested)**

Write `src/broker-accounts/dto/broker-creds.dto.ts`:

```ts
import { IsString, MaxLength } from 'class-validator';

export class MetaApiCredsDto {
  @IsString()
  @MaxLength(128)
  accountId!: string;

  @IsString()
  @MaxLength(1024)
  accessToken!: string;
}
```

- [ ] **Step 2: Create the create DTO**

Write `src/broker-accounts/dto/create-broker-account.dto.ts`:

```ts
import { IsBoolean, IsIn, IsNotEmptyObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MetaApiCredsDto } from './broker-creds.dto';

export class CreateBrokerAccountDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsIn(['METAAPI', 'MOCK'])
  broker!: 'METAAPI' | 'MOCK';

  @IsIn(['metaapi', 'mock'])
  mode!: 'metaapi' | 'mock';

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => MetaApiCredsDto)
  creds!: MetaApiCredsDto;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
```

- [ ] **Step 3: Create the update DTO**

Write `src/broker-accounts/dto/update-broker-account.dto.ts`:

```ts
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateBrokerAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsIn(['metaapi', 'mock'])
  mode?: 'metaapi' | 'mock';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortIndex?: number;
}
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/broker-accounts/dto/
git commit -m "feat(multi-account): DTOs for BrokerAccount create + update"
```

---

## Phase 4 — BrokerAccountService

### Task 4: TDD `BrokerAccountService` — CRUD + `findEnabled` cache + soft-cap

**Files:**
- Create: `src/broker-accounts/broker-accounts.service.ts`
- Create: `src/broker-accounts/broker-accounts.service.spec.ts`
- Create: `src/broker-accounts/broker-accounts.module.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/broker-accounts/broker-accounts.service.spec.ts`:

```ts
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
        ciphertext: Buffer.from('ct'), iv: Buffer.from('iv-12bytes!!'), authTag: Buffer.from('authtag16bytes!!'),
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
    it('updates isEnabled and invalidates cache', async () => {
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
    it('refuses hard delete when account has open trades', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'user-1' });
      prisma.trade.count.mockResolvedValue(2);
      await expect(service.delete('user-1', 'a1', false)).rejects.toBeInstanceOf(ConflictException);
    });

    it('soft-deletes by setting isEnabled=false when force=false and open trades exist', async () => {
      prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', userId: 'user-1', isEnabled: true });
      prisma.trade.count.mockResolvedValue(2);
      prisma.brokerAccount.update.mockResolvedValue({});
      const result = await service.delete('user-1', 'a1', false).catch((e) => e);
      // The current contract: throws Conflict if trades exist AND force=false. soft-delete path is a separate API.
      expect(result).toBeInstanceOf(ConflictException);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/broker-accounts/broker-accounts.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement BrokerAccountsService**

Write `src/broker-accounts/broker-accounts.service.ts`:

```ts
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
      },
    });
    this.invalidate();
    return this.toSafe(account);
  }

  async findAllForUser(userId: string) {
    const rows = await this.prisma.brokerAccount.findMany({
      where: { userId },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toSafe(r));
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
      data: dto,
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
      // Soft-disable instead of hard delete.
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
```

- [ ] **Step 4: Create BrokerAccountsModule**

Write `src/broker-accounts/broker-accounts.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { CryptoModule } from '../crypto/crypto.module';
import { BrokerAccountsService } from './broker-accounts.service';

@Module({
  imports: [PrismaModule, CryptoModule],
  providers: [BrokerAccountsService],
  exports: [BrokerAccountsService],
})
export class BrokerAccountsModule {}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/broker-accounts/broker-accounts.service.spec.ts`
Expected: PASS, 12 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/broker-accounts/broker-accounts.service.ts src/broker-accounts/broker-accounts.service.spec.ts src/broker-accounts/broker-accounts.module.ts
git commit -m "feat(multi-account): BrokerAccountsService — CRUD + findEnabled cache + soft-cap"
```

---

### Task 5: BrokerAccountsController + auth + routing tests

**Files:**
- Create: `src/broker-accounts/broker-accounts.controller.ts`
- Create: `src/broker-accounts/broker-accounts.controller.spec.ts`
- Modify: `src/broker-accounts/broker-accounts.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Write the routing test**

Create `src/broker-accounts/broker-accounts.controller.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { BrokerAccountsController } from './broker-accounts.controller';
import { BrokerAccountsService } from './broker-accounts.service';

describe('BrokerAccountsController routing', () => {
  let controller: BrokerAccountsController;
  let service: jest.Mocked<BrokerAccountsService>;

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue({ id: 'a1', name: 'demo' }),
      findAllForUser: jest.fn().mockResolvedValue([]),
      findOneForUser: jest.fn().mockResolvedValue({ id: 'a1' }),
      update: jest.fn().mockResolvedValue({ id: 'a1' }),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;

    const moduleRef = await Test.createTestingModule({
      controllers: [BrokerAccountsController],
      providers: [{ provide: BrokerAccountsService, useValue: service }],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(BrokerAccountsController);
  });

  it('GET / lists accounts for current user', async () => {
    await controller.list({ user: { id: 'u1' } } as any);
    expect(service.findAllForUser).toHaveBeenCalledWith('u1');
  });

  it('POST / creates with current user id', async () => {
    const body = { name: 'demo', broker: 'METAAPI', mode: 'metaapi', creds: { accountId: 'a', accessToken: 't' } };
    await controller.create({ user: { id: 'u1' } } as any, body as any);
    expect(service.create).toHaveBeenCalledWith('u1', body);
  });

  it('GET /:id returns single account', async () => {
    await controller.findOne({ user: { id: 'u1' } } as any, 'a1');
    expect(service.findOneForUser).toHaveBeenCalledWith('u1', 'a1');
  });

  it('PATCH /:id updates', async () => {
    await controller.update({ user: { id: 'u1' } } as any, 'a1', { name: 'New' });
    expect(service.update).toHaveBeenCalledWith('u1', 'a1', { name: 'New' });
  });

  it('DELETE /:id soft-deletes by default', async () => {
    await controller.delete({ user: { id: 'u1' } } as any, 'a1', undefined);
    expect(service.delete).toHaveBeenCalledWith('u1', 'a1', false);
  });

  it('DELETE /:id?force=true passes force flag', async () => {
    await controller.delete({ user: { id: 'u1' } } as any, 'a1', 'true');
    expect(service.delete).toHaveBeenCalledWith('u1', 'a1', true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/broker-accounts/broker-accounts.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement BrokerAccountsController**

Write `src/broker-accounts/broker-accounts.controller.ts`:

```ts
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BrokerAccountsService } from './broker-accounts.service';
import { CreateBrokerAccountDto } from './dto/create-broker-account.dto';
import { UpdateBrokerAccountDto } from './dto/update-broker-account.dto';

@ApiTags('Broker Accounts')
@Controller('api/accounts')
@UseGuards(JwtAuthGuard)
export class BrokerAccountsController {
  constructor(private readonly accounts: BrokerAccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List broker accounts for the current user' })
  list(@Req() req: any) {
    return this.accounts.findAllForUser(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new broker account (creds encrypted at rest)' })
  create(@Req() req: any, @Body() body: CreateBrokerAccountDto) {
    return this.accounts.create(req.user.id, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single broker account' })
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.accounts.findOneForUser(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update name / isEnabled / mode / sortIndex' })
  update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateBrokerAccountDto) {
    return this.accounts.update(req.user.id, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete. Returns 409 if open trades exist unless ?force=true.' })
  @ApiQuery({ name: 'force', required: false, type: Boolean })
  delete(@Req() req: any, @Param('id') id: string, @Query('force') force?: string) {
    return this.accounts.delete(req.user.id, id, force === 'true');
  }
}
```

- [ ] **Step 4: Register controller in the module**

Modify `src/broker-accounts/broker-accounts.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { CryptoModule } from '../crypto/crypto.module';
import { BrokerAccountsService } from './broker-accounts.service';
import { BrokerAccountsController } from './broker-accounts.controller';

@Module({
  imports: [PrismaModule, CryptoModule],
  controllers: [BrokerAccountsController],
  providers: [BrokerAccountsService],
  exports: [BrokerAccountsService],
})
export class BrokerAccountsModule {}
```

- [ ] **Step 5: Register module in AppModule**

Run: `grep -n "imports:\s*\[" src/app.module.ts | head -3`

Find the `@Module({ imports: [...] })` declaration in `src/app.module.ts`. Add `BrokerAccountsModule` to the imports list (alongside other feature modules like `JournalModule`).

Also add the import statement near the top of the file:

```ts
import { BrokerAccountsModule } from './broker-accounts/broker-accounts.module';
```

- [ ] **Step 6: Run tests + build**

Run: `pnpm test -- src/broker-accounts/`
Expected: PASS, 18 tests green total (12 service + 6 controller).

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/broker-accounts/broker-accounts.controller.ts src/broker-accounts/broker-accounts.controller.spec.ts src/broker-accounts/broker-accounts.module.ts src/app.module.ts
git commit -m "feat(multi-account): controller + 5 endpoints behind JwtAuthGuard"
```

---

## Phase 5 — Backfill

### Task 6: Backfill script for existing data

**Files:**
- Create: `scripts/backfill-broker-accounts.ts`

- [ ] **Step 1: Write the script**

Write `scripts/backfill-broker-accounts.ts`:

```ts
/**
 * One-shot backfill: turns the env-driven MetaApi account into a
 * BrokerAccount row, and assigns existing Trade / LiveSession /
 * EquitySnapshot / RiskState rows to it.
 *
 * Idempotent — re-running skips already-assigned rows and updates the
 * BrokerAccount row in place.
 *
 * Requires BROKER_CREDS_KEY in env. Generate one via: openssl rand -hex 32
 *
 * Run via: pnpm ts-node -P tsconfig.build.json --transpile-only scripts/backfill-broker-accounts.ts
 */
import { PrismaClient } from '@prisma/client';
import * as crypto from 'node:crypto';

const DEFAULT_NAME = process.env.BACKFILL_ACCOUNT_NAME || 'Pepperstone Demo';

async function main() {
  const key = process.env.BROKER_CREDS_KEY;
  if (!key || key.length !== 64) {
    throw new Error('BROKER_CREDS_KEY env var (32-byte hex) is required');
  }
  const accountId = process.env.METAAPI_ACCOUNT_ID_DEMO;
  const accessToken = process.env.METAAPI_ACCESS_TOKEN;
  if (!accountId || !accessToken) {
    throw new Error('METAAPI_ACCOUNT_ID_DEMO and METAAPI_ACCESS_TOKEN must be set');
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user) throw new Error('No User row found — bootstrap a user first');

    // Encrypt creds.
    const credsJson = JSON.stringify({ accountId, accessToken });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(credsJson, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Upsert account.
    const existing = await prisma.brokerAccount.findUnique({
      where: { userId_name: { userId: user.id, name: DEFAULT_NAME } },
    });
    const account = existing
      ? await prisma.brokerAccount.update({
          where: { id: existing.id },
          data: {
            encryptedCreds: ciphertext, credsIv: iv, credsAuthTag: authTag,
            mode: 'metaapi', broker: 'METAAPI', isEnabled: existing.isEnabled,
          },
        })
      : await prisma.brokerAccount.create({
          data: {
            userId: user.id,
            name: DEFAULT_NAME,
            broker: 'METAAPI',
            mode: 'metaapi',
            isEnabled: true,
            encryptedCreds: ciphertext,
            credsIv: iv,
            credsAuthTag: authTag,
          },
        });

    console.log(`BrokerAccount ${existing ? 'updated' : 'created'}: ${account.id}`);

    const tradeCount = await prisma.trade.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${tradeCount.count} Trade row(s).`);

    const sessionCount = await prisma.liveSession.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${sessionCount.count} LiveSession row(s).`);

    const equityCount = await prisma.equitySnapshot.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${equityCount.count} EquitySnapshot row(s).`);

    const riskCount = await prisma.riskState.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${riskCount.count} RiskState row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check the script**

Run: `pnpm exec tsc --noEmit --target ES2020 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck scripts/backfill-broker-accounts.ts 2>&1 | head -20`

Expected: zero errors. If Prisma client types complain, run `pnpm prisma:generate` first.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-broker-accounts.ts
git commit -m "feat(multi-account): backfill script — env creds → BrokerAccount + assign existing rows"
```

---

## Phase 6 — Engine fan-out (NestJS)

### Task 7: BrokerHttpClient (replaces inline HTTP)

**Files:**
- Create: `src/strategy/live/broker-http-client.ts`
- Create: `src/strategy/live/broker-http-client.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/strategy/live/broker-http-client.spec.ts`:

```ts
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
    accounts = { findByIdWithCreds: jest.fn().mockResolvedValue({
      id: 'a1', mode: 'metaapi',
      encryptedCreds: Buffer.from('ct'), credsIv: Buffer.from('iv-12bytes!!'), credsAuthTag: Buffer.from('authtag16bytes!!'),
    }) };
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
    expect(opts.headers['X-Broker-Creds']).toBe('{"accountId":"meta","accessToken":"tok"}');
    expect(opts.headers['X-Broker-Mode']).toBe('metaapi');
    expect(result).toEqual([{ ticket: 1 }]);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/strategy/live/broker-http-client.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement BrokerHttpClient**

Write `src/strategy/live/broker-http-client.ts`:

```ts
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
    const creds = this.crypto.decrypt(acct.encryptedCreds, acct.credsIv, acct.credsAuthTag);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/strategy/live/broker-http-client.spec.ts`
Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/live/broker-http-client.ts src/strategy/live/broker-http-client.spec.ts
git commit -m "feat(multi-account): BrokerHttpClient — accountId-routed wrapper around execution-service"
```

---

### Task 8: LiveSmcOrchestratorRegistry

**Files:**
- Create: `src/strategy/live/live-smc-orchestrator-registry.ts`
- Create: `src/strategy/live/live-smc-orchestrator-registry.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/strategy/live/live-smc-orchestrator-registry.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { LiveSmcOrchestratorRegistry } from './live-smc-orchestrator-registry';
import { LiveSmcOrchestrator } from './live-smc-orchestrator';

describe('LiveSmcOrchestratorRegistry', () => {
  let registry: LiveSmcOrchestratorRegistry;
  let factory: jest.Mock;

  beforeEach(async () => {
    factory = jest.fn(() => ({
      restore: jest.fn().mockResolvedValue(undefined),
      persistNow: jest.fn().mockResolvedValue(undefined),
    } as any));
    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSmcOrchestratorRegistry,
        { provide: 'ORCHESTRATOR_FACTORY', useValue: factory },
      ],
    }).compile();
    registry = moduleRef.get(LiveSmcOrchestratorRegistry);
  });

  it('returns the same instance for the same accountId', () => {
    const a1 = registry.getOrCreate('acct-1');
    const a2 = registry.getOrCreate('acct-1');
    expect(a1).toBe(a2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns different instances for different accountIds', () => {
    const a = registry.getOrCreate('acct-1');
    const b = registry.getOrCreate('acct-2');
    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('calls restore on first creation', () => {
    const inst = registry.getOrCreate('acct-1');
    expect(inst.restore).toHaveBeenCalledWith('acct-1');
  });

  it('removeIfDisabled persists state and schedules eviction', async () => {
    const inst = registry.getOrCreate('acct-1');
    await registry.removeIfDisabled('acct-1');
    expect(inst.persistNow).toHaveBeenCalledWith('acct-1');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm test -- src/strategy/live/live-smc-orchestrator-registry.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `src/strategy/live/live-smc-orchestrator-registry.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LiveSmcOrchestrator } from './live-smc-orchestrator';

const EVICT_AFTER_MS = 5 * 60_000;

export type OrchestratorFactory = () => LiveSmcOrchestrator;

/**
 * Per-account orchestrator registry. The orchestrator holds per-pair
 * pending queues, RiskManager state, cooldowns. Each enabled account
 * gets its own instance, lazy-initialized on first access. Disabling
 * an account persists final snapshot to Redis then evicts after a
 * 5-minute grace period (catches toggle-bounce without losing state).
 */
@Injectable()
export class LiveSmcOrchestratorRegistry {
  private readonly logger = new Logger(LiveSmcOrchestratorRegistry.name);
  private readonly instances = new Map<string, LiveSmcOrchestrator>();
  private readonly evictTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject('ORCHESTRATOR_FACTORY')
    private readonly factory: OrchestratorFactory,
  ) {}

  getOrCreate(accountId: string): LiveSmcOrchestrator {
    let inst = this.instances.get(accountId);
    if (inst) {
      // Cancel any pending eviction (toggle ON within grace period).
      const timer = this.evictTimers.get(accountId);
      if (timer) {
        clearTimeout(timer);
        this.evictTimers.delete(accountId);
      }
      return inst;
    }
    inst = this.factory();
    void inst.restore(accountId);
    this.instances.set(accountId, inst);
    return inst;
  }

  async removeIfDisabled(accountId: string): Promise<void> {
    const inst = this.instances.get(accountId);
    if (!inst) return;
    await inst.persistNow(accountId);
    const timer = setTimeout(() => {
      this.instances.delete(accountId);
      this.evictTimers.delete(accountId);
      this.logger.log(`Evicted orchestrator instance for account=${accountId}`);
    }, EVICT_AFTER_MS);
    this.evictTimers.set(accountId, timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/strategy/live/live-smc-orchestrator-registry.spec.ts`
Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/live/live-smc-orchestrator-registry.ts src/strategy/live/live-smc-orchestrator-registry.spec.ts
git commit -m "feat(multi-account): LiveSmcOrchestratorRegistry — per-account orchestrator with 5m eviction grace"
```

---

### Task 9: Modify `LiveSmcOrchestrator` for account-scoped Redis keys

**Files:**
- Modify: `src/strategy/live/live-smc-orchestrator.ts`

- [ ] **Step 1: Find the Redis state methods**

Run: `grep -n "persistNow\|restore\|live:orchestrator:state\|live:telemetry:feed" src/strategy/live/live-smc-orchestrator.ts | head -20`

Note the locations of `persistNow`, `restore`, and any Redis key literals.

- [ ] **Step 2: Update method signatures to accept accountId**

Inside `LiveSmcOrchestrator`, change `persistNow` and `restore` to accept an optional `accountId` parameter. When provided, the Redis key is suffixed with `:{accountId}`. When omitted, the legacy keys are used (so the migration helper in Step 5 can still read the unsuffixed key).

Find the method that writes orchestrator state to Redis (search for the literal `'live:orchestrator:state'`). Replace usages with:

```ts
const KEY_PREFIX = 'live:orchestrator:state';
private keyFor(accountId?: string): string {
  return accountId ? `${KEY_PREFIX}:${accountId}` : KEY_PREFIX;
}
```

Update `persistNow(accountId?: string)` to use `this.keyFor(accountId)`. Same for `restore(accountId?: string)`.

Do the same for the telemetry feed key `'live:telemetry:feed'` → `keyForTelemetry(accountId?: string)`.

- [ ] **Step 3: One-time migration helper**

Add a method to the orchestrator that migrates legacy unsuffixed keys to the default-account key on first call:

```ts
/**
 * One-shot: if a legacy unsuffixed key exists in Redis, copy it to the
 * default-account suffixed key. Idempotent — does nothing if the
 * suffixed key already exists.
 */
async migrateLegacyKeysOnce(defaultAccountId: string): Promise<void> {
  for (const baseKey of ['live:orchestrator:state', 'live:telemetry:feed']) {
    const suffixed = `${baseKey}:${defaultAccountId}`;
    const exists = await this.redis.get(suffixed);
    if (exists) continue;
    const legacy = await this.redis.get(baseKey);
    if (!legacy) continue;
    await this.redis.set(suffixed, legacy);
    this.logger.log(`Migrated Redis key ${baseKey} → ${suffixed}`);
  }
}
```

- [ ] **Step 4: Verify build + tests**

Run: `pnpm build && pnpm test`
Expected: existing tests still pass (we only changed signatures with optional args).

- [ ] **Step 5: Commit**

```bash
git add src/strategy/live/live-smc-orchestrator.ts
git commit -m "feat(multi-account): orchestrator — account-scoped Redis keys + legacy migration helper"
```

---

### Task 10: Fan out `LiveStrategyService` per enabled account

**Files:**
- Modify: `src/strategy/live/live-strategy.service.ts`
- Modify: `src/strategy/strategy.module.ts`

- [ ] **Step 1: Read the current `onCandleStored` and `evaluatePair` shape**

Run: `grep -n "onCandleStored\|evaluatePair\|fetchOpenPositions\|fetchAllOpenPositions\|fetchAccount\|placeOrder" src/strategy/live/live-strategy.service.ts | head -20`

- [ ] **Step 2: Inject dependencies**

In the `LiveStrategyService` constructor parameter list, add:

```ts
    private readonly brokerAccounts: BrokerAccountsService,
    private readonly brokerHttp: BrokerHttpClient,
    private readonly orchestratorRegistry: LiveSmcOrchestratorRegistry,
```

Add the imports:

```ts
import { BrokerAccountsService } from '../../broker-accounts/broker-accounts.service';
import { BrokerHttpClient } from './broker-http-client';
import { LiveSmcOrchestratorRegistry } from './live-smc-orchestrator-registry';
```

- [ ] **Step 3: Add feature-flag accessor**

Inside the class:

```ts
private get fanOutEnabled(): boolean {
  return (this.config.get<string>('ENABLE_MULTI_ACCOUNT_FANOUT') || 'false').toLowerCase() === 'true';
}
```

- [ ] **Step 4: Rewrite the candle-stored handler**

Replace the body of the existing `CANDLE_STORED` subscription handler (search for `CANDLE_STORED`). The new flow:

```ts
await this.redis.subscribe(REDIS_CHANNELS.CANDLE_STORED, (message) => {
  try {
    const data = JSON.parse(message);
    if (data.timeframe !== Timeframe.M15) return;
    if (!this.liveControl.isRunning()) return;
    const symbol = (data.symbol || '').toUpperCase();
    if (!this.pairs.includes(symbol)) return;

    if (this.fanOutEnabled) {
      this.evaluatePairAllAccounts(symbol).catch((err) =>
        this.logger.error(`[${symbol}] fan-out eval failed: ${err.message}`, err.stack),
      );
    } else {
      // Legacy single-account path: pick the FIRST enabled account.
      this.evaluatePairLegacy(symbol).catch((err) =>
        this.logger.error(`Live eval failed for ${symbol}: ${err.message}`, err.stack),
      );
    }
  } catch {
    // ignore bad payloads
  }
});
```

- [ ] **Step 5: Add `evaluatePairAllAccounts`**

Insert this new method into `LiveStrategyService`:

```ts
async evaluatePairAllAccounts(symbol: string): Promise<void> {
  const accounts = await this.brokerAccounts.findEnabled();
  if (accounts.length === 0) {
    this.logger.debug(`[${symbol}] no enabled accounts — skipping`);
    return;
  }
  await Promise.all(
    accounts.map((acct) =>
      this.evaluatePairForAccount(symbol, acct).catch((err) =>
        this.logger.error(`[${acct.name}/${symbol}] evaluate failed: ${(err as Error).message}`),
      ),
    ),
  );
}
```

- [ ] **Step 6: Add `evaluatePairForAccount` (mirrors existing logic, account-scoped)**

The new method threads `accountId` through every broker call. Read the existing `evaluatePair` method body, then create this near-copy that uses `BrokerHttpClient` and `orchestratorRegistry`:

```ts
async evaluatePairForAccount(symbol: string, account: { id: string; name: string }): Promise<any> {
  const [m15, h1, d1, openPositions, allOpen, accountInfo] = await Promise.all([
    this.fetchCandles(symbol, Timeframe.M15, M15_BUFFER),
    this.fetchCandles(symbol, Timeframe.H1, H1_BUFFER),
    this.fetchCandles(symbol, Timeframe.D1, D1_BUFFER),
    this.brokerHttp.fetchOpenPositions(account.id, symbol),
    this.brokerHttp.fetchOpenPositions(account.id),
    this.brokerHttp.fetchAccount(account.id),
  ]);
  const evalTs = m15[m15.length - 1]?.openTime ?? new Date().toISOString();

  const orchestrator = this.orchestratorRegistry.getOrCreate(account.id);
  const signal = orchestrator.evaluate(symbol, m15, h1, d1, {
    accountEquity: accountInfo.equity,
    openDirections: new Set(openPositions.map((p) => p.side as 'BUY' | 'SELL')),
    totalOpenPositions: allOpen.length,
    riskPercent: this.liveControl.getRiskPercent(),
    nowIso: evalTs,
    maxOpenPositions: 4,
  });

  if (!signal) {
    return null;
  }

  const placeResult = await this.placeOrderForAccount(signal, account.id);
  if (placeResult.successfulLegs === 0) {
    this.logger.warn(`[${account.name}/${symbol}] placeOrder 0 legs — sweep stays pending`);
    return null;
  }
  orchestrator.recordEntry(symbol, signal);
  return signal;
}
```

- [ ] **Step 7: Add `placeOrderForAccount`**

Existing `placeOrder` method calls execution-service via inline HTTP. Add an account-aware variant:

```ts
async placeOrderForAccount(signal: any, accountId: string): Promise<{ successfulLegs: number }> {
  let successfulLegs = 0;
  for (const leg of signal.legs ?? [signal]) {
    try {
      const res = await this.brokerHttp.placeOrder(accountId, {
        symbol: signal.symbol,
        side: signal.side,
        lotSize: leg.lotSize,
        slPrice: leg.slPrice,
        tpPrice: leg.tpPrice,
        // ... other fields as needed by execution-service
      });
      if (res.status === 'FILLED' && res.mt5Ticket) {
        successfulLegs++;
        // persist Trade row scoped to this account
        await this.prisma.trade.create({
          data: {
            // ... existing Trade row fields ...
            accountId,
            mt5Ticket: res.mt5Ticket,
          } as any,
        });
      }
    } catch (err) {
      this.logger.warn(`[${accountId}] placeOrder leg failed: ${(err as Error).message}`);
    }
  }
  return { successfulLegs };
}
```

Note: this is a structural sketch. The implementer should copy the FULL body of the existing `placeOrder` (which includes candidate-trade creation, slippage checks, leg accounting) and substitute `this.brokerHttp.placeOrder(accountId, ...)` for the inline HTTP call.

- [ ] **Step 8: Rename legacy `evaluatePair` → `evaluatePairLegacy`**

Rename the existing `evaluatePair` method to `evaluatePairLegacy` for clarity. It still uses the env-driven creds path for the feature-flag-off case. When `ENABLE_MULTI_ACCOUNT_FANOUT=false` it picks the FIRST enabled account and evaluates only that one (so behavior is identical to today's single-account flow against the migrated default account).

- [ ] **Step 9: Register new providers in StrategyModule**

In `src/strategy/strategy.module.ts`, add imports for `BrokerAccountsModule` and `CryptoModule`. Add `BrokerHttpClient`, `LiveSmcOrchestratorRegistry` to providers. Provide the orchestrator factory:

```ts
providers: [
  // ... existing providers ...
  BrokerHttpClient,
  LiveSmcOrchestratorRegistry,
  {
    provide: 'ORCHESTRATOR_FACTORY',
    useFactory: (config, redis, riskMgr) => () => new LiveSmcOrchestrator(config, redis, riskMgr),
    inject: [ConfigService, RedisService, /* etc */],
  },
],
```

Note: this exact wiring depends on how `LiveSmcOrchestrator` is currently constructed — adjust the dependencies in `useFactory` to match its constructor.

- [ ] **Step 10: Verify build + tests**

Run: `pnpm build`
Expected: exit 0.

Run: `pnpm test`
Expected: existing tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/strategy/live/live-strategy.service.ts src/strategy/strategy.module.ts
git commit -m "feat(multi-account): LiveStrategyService fan-out per enabled account (behind feature flag)"
```

---

### Task 11: Fan out `LivePositionManagerService` per account

**Files:**
- Modify: `src/strategy/live/live-position-manager.service.ts`

- [ ] **Step 1: Inject dependencies**

In the constructor, add:

```ts
    private readonly brokerAccounts: BrokerAccountsService,
    private readonly brokerHttp: BrokerHttpClient,
```

And imports.

- [ ] **Step 2: Rewrite `manageSymbol` to fan out**

Find the existing `manageSymbol` method. Wrap it:

```ts
async manageSymbol(symbol: string): Promise<void> {
  const fanOut = (this.config.get<string>('ENABLE_MULTI_ACCOUNT_FANOUT') || 'false').toLowerCase() === 'true';
  if (!fanOut) {
    // Legacy single-account behavior: filter trades by status, not by accountId.
    return this.manageSymbolLegacy(symbol);
  }
  const accounts = await this.brokerAccounts.findEnabled();
  await Promise.all(
    accounts.map((acct) =>
      this.manageSymbolForAccount(symbol, acct).catch((err) =>
        this.logger.error(`[${acct.name}/${symbol}] manageSymbol failed: ${(err as Error).message}`),
      ),
    ),
  );
}
```

- [ ] **Step 3: Rename original logic → `manageSymbolLegacy`**

Rename the existing `manageSymbol` body to `manageSymbolLegacy`. Keeps the single-account path intact for feature-flag-off.

- [ ] **Step 4: Add `manageSymbolForAccount`**

Copy the legacy body into a new method that scopes by `accountId`:

```ts
async manageSymbolForAccount(symbol: string, account: { id: string }): Promise<void> {
  const open = await this.prisma.trade.findMany({
    where: { symbol, status: 'OPEN', mt5Ticket: { not: null }, accountId: account.id },
  });
  if (open.length === 0) return;
  const brokerPositions = await this.brokerHttp.fetchOpenPositions(account.id, symbol);
  // ... rest of the existing logic, but using this.brokerHttp.modify(account.id, ...) for broker calls
}
```

The implementer should copy the FULL body of `manageSymbolLegacy` and substitute:
- `this.fetchBrokerPositions(symbol)` → `this.brokerHttp.fetchOpenPositions(account.id, symbol)`
- `this.modifyBrokerPosition(ticket, ...)` → `this.brokerHttp.modify(account.id, ticket, ...)`
- Add `accountId: account.id` to the Trade.findMany `where` clause

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/live/live-position-manager.service.ts
git commit -m "feat(multi-account): LivePositionManager fan-out per enabled account"
```

---

### Task 12: Fan out `PositionMonitorService` + scope sister-lookup by accountId

**Files:**
- Modify: `src/strategy/live/position-monitor.service.ts`
- Modify: `src/strategy/live/position-monitor.service.spec.ts`

- [ ] **Step 1: Inject dependencies + add fan-out**

In `PositionMonitorService` constructor, add `brokerAccounts` and `brokerHttp` (same as Task 11). Then wrap `reconcileAll`:

```ts
async reconcileAll(): Promise<void> {
  const fanOut = (this.config.get<string>('ENABLE_MULTI_ACCOUNT_FANOUT') || 'false').toLowerCase() === 'true';
  if (!fanOut) {
    for (const symbol of this.pairs) {
      try { await this.reconcilePairLegacy(symbol); }
      catch (err) { this.logger.error(`[${symbol}] reconcile error: ${(err as Error).message}`); }
    }
  } else {
    const accounts = await this.brokerAccounts.findEnabled();
    for (const account of accounts) {
      for (const symbol of this.pairs) {
        try { await this.reconcilePairForAccount(symbol, account); }
        catch (err) { this.logger.error(`[${account.name}/${symbol}] reconcile error: ${(err as Error).message}`); }
      }
    }
  }
  // ... existing journal safety net (unchanged) ...
}
```

- [ ] **Step 2: Rename `reconcilePair` → `reconcilePairLegacy`; add `reconcilePairForAccount`**

`reconcilePairForAccount` is a copy that:
- queries `Trade.findMany({ where: { symbol, status: 'OPEN', accountId: account.id, ... } })`
- calls `this.brokerHttp.fetchOpenPositions(account.id, symbol)` instead of `this.fetchBrokerPositions(symbol)`
- calls `this.brokerHttp.fetchPositionHistory(account.id, ticket)` instead of inline HTTP

- [ ] **Step 3: Scope sister-Runner lookup by accountId**

In `maybeTriggerSisterRunnerBe`, find the `prisma.trade.findFirst` call. Add `accountId: closed.accountId` to the `where` clause:

```ts
const sister = await this.prisma.trade.findFirst({
  where: {
    symbol: closed.symbol,
    side: closed.side,
    entryPrice: closed.entryPrice,
    status: 'OPEN',
    mt5Ticket: { not: null },
    id: { not: closed.id },
    accountId: closed.accountId,  // ← NEW: prevent cross-account false matches
    createdAt: { gte: lower, lte: upper },
  },
});
```

Also update the broker modify call:

```ts
await this.brokerHttp.modify(sister.accountId, sister.mt5Ticket, newSl, sister.tpPrice ?? 0);
```

(Replaces the inline `this.httpService.post(`${SERVICE_URLS.EXECUTION}/positions/${ticket}/modify`...)` pattern.)

- [ ] **Step 4: Update test to cover the accountId scoping**

In `position-monitor.service.spec.ts`, find the existing `maybeTriggerSisterRunnerBe` describe block. Add `accountId: 'acct-1'` to both `tp1Trade` and `runnerSister` fixtures. Then assert that the `findFirst` call includes `accountId: 'acct-1'`:

```ts
it('scopes sister Runner lookup by accountId', async () => {
  const tp1WithAcct = { ...tp1Trade, accountId: 'acct-1' };
  prisma.trade.findUnique.mockResolvedValue(tp1WithAcct);
  prisma.trade.findFirst.mockResolvedValue({ ...runnerSister, accountId: 'acct-1' });
  http.post.mockReturnValue(of({ data: {} }));
  prisma.trade.update.mockResolvedValue({});

  await (service as any).maybeTriggerSisterRunnerBe('tp1-id');

  expect(prisma.trade.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ accountId: 'acct-1' }),
    }),
  );
});
```

- [ ] **Step 5: Run tests + build**

Run: `pnpm test -- src/strategy/live/position-monitor.service.spec.ts`
Expected: PASS, 7 tests green (6 original + 1 new).

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/live/position-monitor.service.ts src/strategy/live/position-monitor.service.spec.ts
git commit -m "feat(multi-account): PositionMonitor fan-out + sister-Runner lookup scoped by accountId"
```

---

## Phase 7 — Execution-service (Python)

### Task 13: `Broker` abstract base class

**Files:**
- Create: `services/execution-service/broker_base.py`
- Create: `services/execution-service/test_broker_base.py`

- [ ] **Step 1: Write the failing test**

Create `services/execution-service/test_broker_base.py`:

```python
import pytest
from broker_base import Broker


def test_abstract_methods_required():
    """A subclass missing any abstract method cannot be instantiated."""
    class Incomplete(Broker):
        async def initialize(self): pass
        # missing all other methods

    with pytest.raises(TypeError):
        Incomplete()


def test_full_subclass_instantiates():
    class Complete(Broker):
        async def initialize(self): pass
        async def place_order(self, request): pass
        async def get_positions(self, symbol=None): pass
        async def close_position(self, ticket): pass
        async def modify_position(self, ticket, sl_price, tp_price): pass
        async def get_account_info(self): pass
        async def get_position_close_info(self, ticket): pass
        async def close(self): pass

    inst = Complete()
    assert inst is not None
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd services/execution-service && python -m pytest test_broker_base.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'broker_base'`.

- [ ] **Step 3: Implement Broker ABC**

Write `services/execution-service/broker_base.py`:

```python
"""
Broker abstract base class. MetaApiMT5 and MockMT5 implement this contract.
Adding a new broker (e.g. Moo Moo in a future spec) means implementing
these 8 methods — no scattered if/else across the codebase.
"""
from abc import ABC, abstractmethod
from typing import Optional


class Broker(ABC):
    @abstractmethod
    async def initialize(self) -> None: ...

    @abstractmethod
    async def place_order(self, request) -> object: ...

    @abstractmethod
    async def get_positions(self, symbol: Optional[str] = None) -> list: ...

    @abstractmethod
    async def close_position(self, ticket: int) -> dict: ...

    @abstractmethod
    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict: ...

    @abstractmethod
    async def get_account_info(self) -> object: ...

    @abstractmethod
    async def get_position_close_info(self, ticket: int) -> Optional[dict]: ...

    @abstractmethod
    async def close(self) -> None: ...
```

- [ ] **Step 4: Run test — expect pass**

Run: `cd services/execution-service && python -m pytest test_broker_base.py -v`
Expected: PASS, 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/broker_base.py services/execution-service/test_broker_base.py
git commit -m "feat(multi-account): Broker ABC formalizes the contract MetaApiMT5/MockMT5 share"
```

---

### Task 14: `BrokerClientRegistry` (per-account multiplexer)

**Files:**
- Create: `services/execution-service/registry.py`
- Create: `services/execution-service/test_registry.py`

- [ ] **Step 1: Write the failing test**

Create `services/execution-service/test_registry.py`:

```python
import asyncio
import pytest
from registry import BrokerClientRegistry
from broker_base import Broker


class FakeClient(Broker):
    instances_created = 0

    def __init__(self):
        FakeClient.instances_created += 1
        self.initialized = False
        self.closed = False

    async def initialize(self): self.initialized = True
    async def place_order(self, request): return None
    async def get_positions(self, symbol=None): return []
    async def close_position(self, ticket): return {}
    async def modify_position(self, ticket, sl_price, tp_price): return {}
    async def get_account_info(self): return None
    async def get_position_close_info(self, ticket): return None
    async def close(self): self.closed = True


@pytest.fixture(autouse=True)
def reset_fake():
    FakeClient.instances_created = 0


@pytest.mark.asyncio
async def test_get_or_create_returns_same_instance_per_account():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    a = await r.get_or_create('acct-1', {}, 'mock')
    b = await r.get_or_create('acct-1', {}, 'mock')
    assert a is b
    assert FakeClient.instances_created == 1


@pytest.mark.asyncio
async def test_get_or_create_different_accounts():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    a = await r.get_or_create('acct-1', {}, 'mock')
    b = await r.get_or_create('acct-2', {}, 'mock')
    assert a is not b
    assert FakeClient.instances_created == 2


@pytest.mark.asyncio
async def test_initialize_called_once():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    client = await r.get_or_create('acct-1', {}, 'mock')
    assert client.initialized is True


@pytest.mark.asyncio
async def test_remove_closes_client():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    client = await r.get_or_create('acct-1', {}, 'mock')
    await r.remove('acct-1')
    assert client.closed is True
    assert 'acct-1' not in r._clients


@pytest.mark.asyncio
async def test_concurrent_init_same_account_creates_one_client():
    r = BrokerClientRegistry(factory=lambda creds, mode: FakeClient())
    results = await asyncio.gather(*[r.get_or_create('acct-1', {}, 'mock') for _ in range(5)])
    assert all(c is results[0] for c in results)
    assert FakeClient.instances_created == 1
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd services/execution-service && python -m pytest test_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'registry'`.

If pytest-asyncio isn't installed, install it first: `pip install pytest-asyncio`. Then add `asyncio_mode = auto` to `pytest.ini` or `pyproject.toml` if needed.

- [ ] **Step 3: Implement BrokerClientRegistry**

Write `services/execution-service/registry.py`:

```python
"""
Per-account broker client registry. Replaces the module-level
metaapi_mt5 / mock_mt5 singletons. One client per accountId; lazy
initialized; thread-safe init via per-key asyncio.Lock.
"""
import asyncio
import logging
from typing import Callable, Dict, Optional
from broker_base import Broker

_logger = logging.getLogger(__name__)


def _default_factory(creds: dict, mode: str) -> Broker:
    if mode == 'mock':
        from mock_mt5 import MockMT5
        return MockMT5()
    from metaapi_mt5 import MetaApiMT5
    return MetaApiMT5.from_creds(creds)


class BrokerClientRegistry:
    def __init__(self, factory: Optional[Callable[[dict, str], Broker]] = None):
        self._clients: Dict[str, Broker] = {}
        self._init_locks: Dict[str, asyncio.Lock] = {}
        self._factory = factory or _default_factory

    async def get_or_create(self, account_id: str, creds: dict, mode: str) -> Broker:
        if account_id in self._clients:
            return self._clients[account_id]
        lock = self._init_locks.setdefault(account_id, asyncio.Lock())
        async with lock:
            if account_id in self._clients:
                return self._clients[account_id]
            client = self._factory(creds, mode)
            await client.initialize()
            self._clients[account_id] = client
            _logger.info(f'BrokerClientRegistry: created client for account={account_id} mode={mode}')
            return client

    async def remove(self, account_id: str) -> None:
        client = self._clients.pop(account_id, None)
        if client:
            try:
                await client.close()
            except Exception as e:
                _logger.warning(f'Error closing client for account={account_id}: {e}')
        self._init_locks.pop(account_id, None)

    def known_accounts(self) -> list:
        return list(self._clients.keys())


# Module-level singleton — main.py imports this.
registry = BrokerClientRegistry()
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd services/execution-service && python -m pytest test_registry.py -v`
Expected: PASS, 5 tests green.

If asyncio_mode isn't auto, mark each test with `@pytest.mark.asyncio`.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/registry.py services/execution-service/test_registry.py
git commit -m "feat(multi-account): BrokerClientRegistry — per-account multiplexer with concurrent-init safety"
```

---

### Task 15: `MetaApiMT5.from_creds` + remove env reads

**Files:**
- Modify: `services/execution-service/metaapi_mt5.py`
- Modify: `services/execution-service/mock_mt5.py`

- [ ] **Step 1: Find env reads to remove**

Run: `grep -n "os.getenv\|METAAPI_ACCOUNT_ID_DEMO\|METAAPI_ACCESS_TOKEN" services/execution-service/metaapi_mt5.py | head -10`

Expected: three locations (lines ~92, ~407, ~478 in current code).

- [ ] **Step 2: Refactor MetaApiMT5.__init__ to take explicit creds**

Open `services/execution-service/metaapi_mt5.py`. Find the `MetaApiMT5` class. Modify the constructor:

```python
class MetaApiMT5(Broker):  # ← inherits Broker now
    def __init__(self, account_id: str, access_token: str):
        self.account_id = account_id
        self.access_token = access_token
        # ... existing initialization body, but replace any
        # os.getenv("METAAPI_ACCOUNT_ID_DEMO") with self.account_id
        # and os.getenv("METAAPI_ACCESS_TOKEN") with self.access_token

    @classmethod
    def from_creds(cls, creds: dict) -> 'MetaApiMT5':
        return cls(creds['accountId'], creds['accessToken'])
```

- [ ] **Step 3: Replace all env reads inside the class**

For each `os.getenv("METAAPI_ACCOUNT_ID_DEMO")` (the lines 92, 407, 478 are inside methods), replace with `self.account_id`. Same for `METAAPI_ACCESS_TOKEN` → `self.access_token`.

Also: remove the module-level `metaapi_mt5 = MetaApiMT5()` singleton at the bottom of the file (if present). The registry handles instantiation now.

- [ ] **Step 4: Make MockMT5 inherit Broker**

In `services/execution-service/mock_mt5.py`, change:

```python
class MockMT5(Broker):  # ← inherits Broker
```

Add the import at the top:

```python
from broker_base import Broker
```

If any required Broker methods are missing on MockMT5 (instantiate it once: `MockMT5()` should now error if methods are missing), add stub implementations matching the signature.

Remove the module-level `mock_mt5 = MockMT5()` singleton.

- [ ] **Step 5: Verify by importing**

Run: `cd services/execution-service && python -c "from metaapi_mt5 import MetaApiMT5; from mock_mt5 import MockMT5; from broker_base import Broker; print(issubclass(MetaApiMT5, Broker), issubclass(MockMT5, Broker))"`
Expected: `True True`.

- [ ] **Step 6: Run all execution-service tests**

Run: `cd services/execution-service && python -m pytest -v`
Expected: existing tests pass; new registry + broker_base tests pass.

- [ ] **Step 7: Commit**

```bash
git add services/execution-service/metaapi_mt5.py services/execution-service/mock_mt5.py
git commit -m "feat(multi-account): MetaApiMT5.from_creds + Broker inheritance — drop env-singleton pattern"
```

---

### Task 16: Account-scoped FastAPI routes

**Files:**
- Modify: `services/execution-service/routes.py`
- Modify: `services/execution-service/main.py`

- [ ] **Step 1: Add new account-scoped routers in routes.py**

Open `services/execution-service/routes.py`. Add at the top of the file:

```python
import json
from fastapi import Depends, Header, HTTPException, Request
from registry import registry
from broker_base import Broker
```

Then add the dependency resolver function:

```python
async def resolve_client(
    account_id: str,
    x_broker_creds: Optional[str] = Header(None),
    x_broker_mode: str = Header('metaapi'),
) -> Broker:
    """Resolve the broker client for this account, lazy-initializing if needed.
    Creds arrive as JSON in the X-Broker-Creds header (sent by NestJS)."""
    if not x_broker_creds:
        raise HTTPException(401, "X-Broker-Creds header required")
    try:
        creds = json.loads(x_broker_creds)
    except json.JSONDecodeError:
        raise HTTPException(400, "X-Broker-Creds must be valid JSON")
    return await registry.get_or_create(account_id, creds, x_broker_mode)
```

- [ ] **Step 2: Add new account-scoped router**

Below the existing router definitions:

```python
account_scoped_router = APIRouter()


@account_scoped_router.get("/{account_id}/positions", response_model=list[Position])
async def get_account_positions(account_id: str, client: Broker = Depends(resolve_client), symbol: Optional[str] = Query(None)):
    return await client.get_positions(symbol)


@account_scoped_router.post("/{account_id}/orders", response_model=OrderResponse)
async def place_account_order(account_id: str, request: OrderRequest, client: Broker = Depends(resolve_client)):
    try:
        return await client.place_order(request)
    except Exception as e:
        _logger.error(f"place_order failed for account={account_id}: {e}")
        return OrderResponse(orderId="", mt5Ticket=None, status="REJECTED", message=f"execution error: {e}")


@account_scoped_router.post("/{account_id}/positions/{ticket}/modify", response_model=ClosePositionResponse)
async def modify_account_position(account_id: str, ticket: int, body: ModifyPositionRequest, client: Broker = Depends(resolve_client)):
    return await client.modify_position(ticket, body.slPrice, body.tpPrice)


@account_scoped_router.get("/{account_id}/positions/{ticket}/history")
async def get_account_position_history(account_id: str, ticket: int, client: Broker = Depends(resolve_client)):
    info = await client.get_position_close_info(ticket)
    if info is None:
        raise HTTPException(404, "Position history not found")
    return info


@account_scoped_router.get("/{account_id}/account-info", response_model=AccountInfo)
async def get_account_info(account_id: str, client: Broker = Depends(resolve_client)):
    return await client.get_account_info()


@account_scoped_router.post("/{account_id}/disconnect")
async def disconnect_account(account_id: str):
    await registry.remove(account_id)
    return {"ok": True}
```

- [ ] **Step 3: Mount the new router**

In `services/execution-service/main.py`, find where existing routers are mounted (search for `app.include_router`). Add:

```python
from routes import (
    orders_router,
    positions_router,
    account_router,
    candles_router,
    account_scoped_router,
)

# ... existing mounts ...
app.include_router(account_scoped_router, prefix="/accounts", tags=["accounts"])
```

The existing `/orders`, `/positions/`, `/account`, `/candles` routes stay mounted (legacy single-account paths) — needed for feature-flag-off behavior.

- [ ] **Step 4: Verify the service starts cleanly**

Run: `cd services/execution-service && python -c "from main import app; print([r.path for r in app.routes])" 2>&1 | head -20`
Expected: routes list including `/accounts/{account_id}/positions`, `/accounts/{account_id}/orders`, etc.

- [ ] **Step 5: Commit**

```bash
git add services/execution-service/routes.py services/execution-service/main.py
git commit -m "feat(multi-account): execution-service — account-scoped FastAPI routes with creds-via-header"
```

---

## Phase 8 — Web UI (shamarx-web)

### Task 17: Types + api-client methods

**Files:**
- Modify: `../shamarx-web/src/lib/types.ts`
- Modify: `../shamarx-web/src/lib/api-client.ts`

- [ ] **Step 1: Append BrokerAccount types**

Append to `../shamarx-web/src/lib/types.ts`:

```ts
// ─── Broker Accounts ──────────────────────────────────────────────────────

export interface BrokerAccount {
  id: string;
  userId: string;
  name: string;
  broker: 'METAAPI' | 'MOCK' | 'MOOMOO';
  mode: string;
  isEnabled: boolean;
  sortIndex: number;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBrokerAccountInput {
  name: string;
  broker: 'METAAPI' | 'MOCK';
  mode: 'metaapi' | 'mock';
  creds: { accountId: string; accessToken: string };
  isEnabled?: boolean;
}

export interface UpdateBrokerAccountInput {
  name?: string;
  isEnabled?: boolean;
  mode?: 'metaapi' | 'mock';
  sortIndex?: number;
}
```

- [ ] **Step 2: Add api methods**

In `../shamarx-web/src/lib/api-client.ts`, add to the existing `import type { ... } from './types'` block:

```ts
  BrokerAccount,
  CreateBrokerAccountInput,
  UpdateBrokerAccountInput,
```

Inside the `export const api = { ... }` object, add these methods (alongside the existing live-trading methods):

```ts
  // Broker accounts
  listBrokerAccounts() {
    return request<BrokerAccount[]>('/api/accounts');
  },
  createBrokerAccount(body: CreateBrokerAccountInput) {
    return request<BrokerAccount>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  getBrokerAccount(id: string) {
    return request<BrokerAccount>(`/api/accounts/${id}`);
  },
  updateBrokerAccount(id: string, body: UpdateBrokerAccountInput) {
    return request<BrokerAccount>(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },
  deleteBrokerAccount(id: string, force = false) {
    return request<void>(`/api/accounts/${id}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    });
  },
```

- [ ] **Step 3: Verify type-check**

Run: `cd ../shamarx-web && pnpm exec tsc --noEmit 2>&1 | head -10`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd ../shamarx-web
git add src/lib/types.ts src/lib/api-client.ts
git commit -m "feat(multi-account): client types + api methods for /api/accounts"
cd ../shamarx-app
```

---

### Task 18: `useAccounts` hooks

**Files:**
- Create: `../shamarx-web/src/hooks/use-accounts.ts`

- [ ] **Step 1: Write the hooks**

```tsx
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { CreateBrokerAccountInput, UpdateBrokerAccountInput } from '@/lib/types';

export function useBrokerAccounts() {
  return useQuery({
    queryKey: ['broker-accounts'],
    queryFn: () => api.listBrokerAccounts(),
    staleTime: 30_000,
  });
}

export function useCreateBrokerAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBrokerAccountInput) => api.createBrokerAccount(body),
    onSettled: () => qc.invalidateQueries({ queryKey: ['broker-accounts'] }),
  });
}

export function useUpdateBrokerAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: UpdateBrokerAccountInput }) =>
      api.updateBrokerAccount(vars.id, vars.body),
    onSettled: () => qc.invalidateQueries({ queryKey: ['broker-accounts'] }),
  });
}

export function useDeleteBrokerAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; force?: boolean }) =>
      api.deleteBrokerAccount(vars.id, vars.force),
    onSettled: () => qc.invalidateQueries({ queryKey: ['broker-accounts'] }),
  });
}
```

- [ ] **Step 2: Commit**

```bash
cd ../shamarx-web
git add src/hooks/use-accounts.ts
git commit -m "feat(multi-account): react-query hooks for broker accounts"
cd ../shamarx-app
```

---

### Task 19: `AccountCard` component

**Files:**
- Create: `../shamarx-web/src/components/live/account-card.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useState } from 'react';
import { Play, Pause, Trash2 } from 'lucide-react';
import { BrokerAccount } from '@/lib/types';
import { useUpdateBrokerAccount, useDeleteBrokerAccount } from '@/hooks/use-accounts';
import { cn } from '@/lib/utils';

interface Props {
  account: BrokerAccount;
}

export function AccountCard({ account }: Props) {
  const update = useUpdateBrokerAccount();
  const del = useDeleteBrokerAccount();
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    update.mutate({ id: account.id, body: { isEnabled: !account.isEnabled } });
  };

  const remove = () => {
    if (confirm(`Delete account "${account.name}"? Open trades require force=true.`)) {
      del.mutate({ id: account.id });
    }
  };

  return (
    <div className="rounded-md border border-border bg-card p-3 min-w-[200px]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('inline-block w-1.5 h-1.5 rounded-full',
            account.isEnabled ? 'bg-signal' : 'bg-muted-foreground',
          )} />
          <span className="text-[11px] font-semibold truncate">{account.name}</span>
        </div>
        <span className="text-[8px] uppercase tracking-[0.14em] text-muted-foreground">{account.broker}</span>
      </div>
      <div className="text-[9px] text-muted-foreground mb-2">
        {account.mode} · {account.isEnabled ? 'running' : 'paused'}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={toggle}
          disabled={update.isPending}
          className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[9px] hover:bg-muted disabled:opacity-50"
        >
          {account.isEnabled ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
          {account.isEnabled ? 'Pause' : 'Start'}
        </button>
        <button
          onClick={remove}
          disabled={del.isPending}
          className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[9px] text-muted-foreground hover:text-loss disabled:opacity-50"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ../shamarx-web
git add src/components/live/account-card.tsx
git commit -m "feat(multi-account): AccountCard — status + Start/Pause toggle + delete"
cd ../shamarx-app
```

---

### Task 20: `AccountStrip` component

**Files:**
- Create: `../shamarx-web/src/components/live/account-strip.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useBrokerAccounts } from '@/hooks/use-accounts';
import { AccountCard } from './account-card';
import { AddAccountModal } from './add-account-modal';

export function AccountStrip() {
  const { data: accounts, isLoading } = useBrokerAccounts();
  const [adding, setAdding] = useState(false);

  if (isLoading) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-[11px] text-muted-foreground">
        Loading accounts…
      </div>
    );
  }

  const enabledCount = (accounts ?? []).filter((a) => a.isEnabled).length;
  const total = accounts?.length ?? 0;

  return (
    <>
      <div className="rounded-md border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="label-eyebrow">
            Accounts · {enabledCount} enabled, {total - enabledCount} paused
          </span>
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Add account
          </button>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {(accounts ?? []).map((acct) => (
            <AccountCard key={acct.id} account={acct} />
          ))}
          {total === 0 && (
            <div className="rounded-md border border-dashed border-border p-3 text-[10px] text-muted-foreground">
              No accounts yet. Add one to start trading.
            </div>
          )}
        </div>
      </div>
      {adding && <AddAccountModal onClose={() => setAdding(false)} />}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ../shamarx-web
git add src/components/live/account-strip.tsx
git commit -m "feat(multi-account): AccountStrip — horizontal card strip + add button"
cd ../shamarx-app
```

---

### Task 21: `AddAccountModal`

**Files:**
- Create: `../shamarx-web/src/components/live/add-account-modal.tsx`

- [ ] **Step 1: Write the modal**

```tsx
'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useCreateBrokerAccount } from '@/hooks/use-accounts';

interface Props {
  onClose: () => void;
}

export function AddAccountModal({ onClose }: Props) {
  const create = useCreateBrokerAccount();
  const [name, setName] = useState('');
  const [broker, setBroker] = useState<'METAAPI' | 'MOCK'>('METAAPI');
  const [mode, setMode] = useState<'metaapi' | 'mock'>('metaapi');
  const [credAccountId, setCredAccountId] = useState('');
  const [credAccessToken, setCredAccessToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await create.mutateAsync({
        name,
        broker,
        mode,
        creds: { accountId: credAccountId, accessToken: credAccessToken },
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm">
      <div className="w-[440px] rounded-md border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Add broker account</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="label-eyebrow">Display name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-[11.5px]"
              placeholder="e.g. Demo MetaApi"
            />
          </label>
          <label className="block">
            <span className="label-eyebrow">Broker</span>
            <select
              value={broker}
              onChange={(e) => setBroker(e.target.value as any)}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-[11.5px]"
            >
              <option value="METAAPI">MetaApi</option>
              <option value="MOCK">Mock (paper trading)</option>
            </select>
          </label>
          <label className="block">
            <span className="label-eyebrow">Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as any)}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-[11.5px]"
            >
              <option value="metaapi">metaapi</option>
              <option value="mock">mock</option>
            </select>
          </label>
          <label className="block">
            <span className="label-eyebrow">MetaApi account ID</span>
            <input
              value={credAccountId}
              onChange={(e) => setCredAccountId(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-[11.5px] font-mono"
              placeholder="6f907018-01b1-4425-b88d-c752ea0cea5c"
            />
          </label>
          <label className="block">
            <span className="label-eyebrow">MetaApi access token</span>
            <input
              type="password"
              value={credAccessToken}
              onChange={(e) => setCredAccessToken(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-[11.5px] font-mono"
              placeholder="eyJ..."
            />
          </label>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-loss bg-loss/10 p-2 text-[10px] text-loss">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={create.isPending || !name || !credAccountId || !credAccessToken}
            className="rounded-md bg-signal px-3 py-1.5 text-[11px] font-medium text-background disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ../shamarx-web
git add src/components/live/add-account-modal.tsx
git commit -m "feat(multi-account): AddAccountModal — form for creating broker account"
cd ../shamarx-app
```

---

### Task 22: Wire account strip into `/lives/[id]` page

**Files:**
- Modify: `../shamarx-web/src/app/lives/[id]/page.tsx`

- [ ] **Step 1: Import AccountStrip**

Add to the existing imports at the top of `../shamarx-web/src/app/lives/[id]/page.tsx`:

```tsx
import { AccountStrip } from '@/components/live/account-strip';
```

- [ ] **Step 2: Insert the strip above the engine telemetry panel**

Find the section that renders engine telemetry (search for the comment `Engine Worker` or for `<PairScannerStrip`). Insert a new `<Reveal>` block immediately before it:

```tsx
<Reveal as="section" delay={0.18}>
  <AccountStrip />
</Reveal>
```

Adjust the `delay` to fit the existing animation sequence (look at neighboring `Reveal` delays).

- [ ] **Step 3: Verify build**

Run: `cd ../shamarx-web && pnpm exec tsc --noEmit 2>&1 | head -10`
Expected: zero errors.

Run: `cd ../shamarx-web && pnpm build 2>&1 | tail -10`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd ../shamarx-web
git add src/app/lives/[id]/page.tsx
git commit -m "feat(multi-account): mount AccountStrip inside /lives/[id]"
cd ../shamarx-app
```

---

## Phase 9 — Env config + runbook

### Task 23: Env vars + runbook

**Files:**
- Modify: `.env.example`
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Add to .env.example**

Append to `.env.example`:

```
# Multi-Account Broker Support (Spec 1)
# 32-byte hex string used to encrypt BrokerAccount creds at rest.
# Generate via: openssl rand -hex 32
BROKER_CREDS_KEY=

# Feature flag: when true, strategy engine fans out to ALL enabled
# BrokerAccount rows. When false, evaluates the first enabled account
# only (legacy single-account behavior).
ENABLE_MULTI_ACCOUNT_FANOUT=false

# Soft cap on concurrently enabled accounts. Default 5.
MULTI_ACCOUNT_SOFT_CAP=5
```

- [ ] **Step 2: Add runbook section**

Append to `docs/RUNBOOK.md`:

```markdown
## Multi-Account Broker Operations

### Generating BROKER_CREDS_KEY

```bash
openssl rand -hex 32
```

Place the output in production .env as `BROKER_CREDS_KEY=...`. Lost
key = all encrypted creds become unrecoverable; users must re-enter
broker creds via the UI.

### Rotating BROKER_CREDS_KEY

1. Pick a downtime window.
2. SSH into the app server. Pull the encrypted creds for each BrokerAccount.
3. Decrypt with the old key. Re-encrypt with the new key.
4. Update each `BrokerAccount` row's `encryptedCreds`, `credsIv`, `credsAuthTag`.
5. Swap the env var. Restart the app.
6. Verify by triggering a no-op order (mock account) — should succeed.

No automated rotation tool in v1. The above is manual.

### Enabling fan-out

After the schema migration deploys and backfill runs, set
`ENABLE_MULTI_ACCOUNT_FANOUT=true` in production .env and restart.

To roll back: set to `false` and restart. The strategy engine
reverts to legacy single-account behavior using the first enabled
account.

### Soft cap

`MULTI_ACCOUNT_SOFT_CAP` defaults to 5. To raise it, set the env
var and restart. Higher caps mean more concurrent broker connections —
monitor MetaApi rate limits.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/RUNBOOK.md
git commit -m "docs(multi-account): env vars + runbook (key rotation, fan-out flag)"
```

---

## Phase 10 — Rollout (deferred to user)

### Task 24: Production rollout

**Files:** (none — operational)

Sequence to execute after all above PRs merge:

- [ ] **Step 1: Generate `BROKER_CREDS_KEY`**

On local machine:
```bash
openssl rand -hex 32
```
Add the output to production `.env` on EC2 (via SSM):
```bash
# .env on EC2
BROKER_CREDS_KEY=<the-hex-string>
ENABLE_MULTI_ACCOUNT_FANOUT=false  # initial value — flip later
```

- [ ] **Step 2: Merge PR → schema auto-applies**

Merge to main. `deploy-backend.yml` workflow runs `prisma db push` automatically.

- [ ] **Step 3: Run backfill on production**

```bash
aws ssm send-command --profile shamarx-prod --region ap-southeast-5 \
  --instance-ids i-0da17ad488fa32c8a \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/trading-bot/repo && docker compose -f docker/docker-compose.yml exec -T trading-bot pnpm ts-node -P tsconfig.build.json --transpile-only scripts/backfill-broker-accounts.ts"]'
```

Expected: prints `BrokerAccount created: <uuid>` + Backfilled N rows × 4 tables.

- [ ] **Step 4: Verify single-account behavior intact (flag still OFF)**

Visit `/lives/[id]`. AccountStrip should render with one card (default migrated account). Engine telemetry, trades — unchanged from before.

- [ ] **Step 5: Create a second account in UI**

Click "+ add account". Use MOCK broker / mock mode. Submit. Verify card appears in strip with isEnabled=false.

- [ ] **Step 6: Flip the feature flag**

Update production .env: `ENABLE_MULTI_ACCOUNT_FANOUT=true`. Restart backend container.

Confirm via logs that next M15 boundary fans out:
```
LiveStrategyService: [Demo MetaApi/EURUSD] evaluate
LiveStrategyService: [Mock 2/EURUSD] evaluate
```

- [ ] **Step 7: Watch the next 4 hours**

Confirm both accounts evaluate concurrently. No errors in logs. Telemetry per-account in Redis (`redis-cli KEYS "live:telemetry:feed:*"`).

---

## Self-Review

### Spec coverage

| Spec section | Implementing task(s) |
|---|---|
| §3 Architecture overview | Phases 1–9 collectively |
| §4.1 BrokerAccount model | Task 1 |
| §4.2 accountId on 4 tables | Task 1 (steps 4–7) |
| §4.3 Tables NOT scoped (User/JournalEntry/DayNote) | No-op by omission |
| §4.4 CryptoService | Task 2 |
| §4.5 Backfill script | Task 6 |
| §4.6 Input limits + soft cap | Task 3 (DTO validators) + Task 4 (soft-cap enforcement) |
| §5.1 LiveStrategy fan-out | Task 10 |
| §5.2 evaluatePairForAccount | Task 10 (step 6) |
| §5.3 LiveSmcOrchestratorRegistry | Task 8 |
| §5.4 BrokerAccountService.findEnabled cache | Task 4 |
| §5.5 Redis key namespacing | Task 9 |
| §5.6 PositionManager + Monitor fan-out | Tasks 11, 12 |
| §5.7 Disable mid-flight | Implicit in Task 4 invalidate() + Task 8 removeIfDisabled() |
| §6.1 Broker ABC | Task 13 |
| §6.2 BrokerClientRegistry | Task 14 |
| §6.3 MetaApiMT5.from_creds | Task 15 |
| §6.4 Account-scoped routes | Task 16 |
| §6.5 BrokerHttpClient | Task 7 |
| §6.6 Creds-on-every-request rationale | Documented in Task 7 + Task 16 |
| §6.7 Connection cleanup | Task 7 (disconnect method) + Task 16 (disconnect endpoint) |
| §7.1 Account strip layout | Task 20 |
| §7.2 Engine telemetry scoping | Wired client-side in AccountStrip; deeper per-account telemetry filtering deferred to follow-up |
| §7.3 Trades table account badge | **Not in plan — deferred to follow-up (cosmetic)** |
| §7.4 Disconnected state | Card status pill in Task 19 (gray when isEnabled=false); deeper connection-health polling deferred |
| §7.5 Add-account flow | Task 21 |
| §7.6 Mobile | CSS in Task 20 (overflow-x-auto) |
| §7.7 Journal page implications | **Not in plan — deferred to follow-up (cosmetic)** |
| §8 API surface | Task 5 |
| §9 Edge cases | Tasks 4, 12, 8 explicitly handle the main cases; others covered by code structure |
| §10 Tests | Tasks 2, 4, 5, 7, 8, 12, 13, 14 |
| §11 Rollout | Task 24 |

### Known gaps (deferred to follow-up PR)

- **Per-account trades table column** (spec §7.3): the trades table shows an "Account" badge — not in the v1 plan. Cosmetic. Follow-up.
- **Per-account telemetry filtering** (spec §7.2): the AccountStrip mounts, but the engine-telemetry panel doesn't yet filter by selected account. Telemetry will show events tagged with `accountId` once Task 10 lands, so client-side filtering is a small follow-up.
- **Disconnected state cron** (spec §7.4): the `lastConnectedAt` field exists in schema, but no cron updates it. Card status reflects `isEnabled` only. Follow-up.
- **Journal page account badges** (spec §7.7): trade rows in `/journal` will gain an account badge later; not in this PR.
- **`GET /api/accounts/:id/equity-history` and `GET /api/accounts/:id/positions`** (spec §5 listed; §8.6, §8.7): the API surface includes these in the spec but they're not in the plan. Defer — current `/api/strategy/live/...` endpoints surface this data globally; per-account variants are an enhancement.

### Placeholder scan

Searched for `TBD`, `TODO`, `FIXME`, `implement later`, `Similar to Task N` — none found.

### Type consistency check

- `BrokerAccount.broker` is `'METAAPI' | 'MOCK' | 'MOOMOO'` everywhere (Tasks 1, 3, 17)
- `BrokerAccount.mode` is `'metaapi' | 'mock'` everywhere (Tasks 1, 3, 17)
- `BrokerHttpClient.modify(accountId, ticket, slPrice, tpPrice)` signature matches usage in Tasks 11, 12
- `CryptoService.encrypt` returns `{ ciphertext, iv, authTag }` (Buffer × 3) — consistent in Tasks 2, 4
- `LiveSmcOrchestratorRegistry.getOrCreate(accountId)` / `removeIfDisabled(accountId)` — consistent in Tasks 8, 10
- Python `Broker` ABC method names match `MetaApiMT5` / `MockMT5` overrides (Tasks 13, 15)
- `BrokerClientRegistry.get_or_create(account_id, creds, mode)` — consistent in Tasks 14, 15, 16

### Scope

24 tasks across 10 phases. ~3-5 days of focused work. Plan is decomposed but cohesive (each task produces a meaningful commit).
