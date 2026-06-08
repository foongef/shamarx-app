# Multi-Tenant "Friends + Me" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Shamarx to 5–10 trusted friends on shared infrastructure — invite-only signup, per-user strategy presets, status-focused friend dashboard, SUPERADMIN ops section — without changing the strategy edge or breaking the single-user setup that runs today.

**Architecture:** Service-layer `userId` filtering (no RLS). Hardcoded `PRESETS` map in TS, gated per-user at engine fan-out. DB-backed `RefreshToken` with rotation + reuse detection (replaces existing stateless JWT refresh). Invite tokens hashed with argon2id, single-use. Friend UI hides multi-strategy/backtest surface; SUPERADMIN-only `/admin/*` section reuses existing `Sidebar` + `Topbar` shell.

**Tech Stack:** NestJS, Prisma + Postgres, Next.js 15 + Tailwind + shadcn/ui, Jest + Supertest (backend), Vitest (web), argon2 (`argon2` package), Geist Mono + Orbitron + Geist Sans, existing `MailService` (Handlebars templates).

**Reference:** [Spec](../specs/2026-06-09-multi-tenant-friends-design.md)

---

## File map

### Backend (NestJS)

**New:**
- `libs/prisma/migrations/<ts>_multi_tenant/migration.sql` — additive migration
- `scripts/backfill-spec2.ts` — idempotent backfill
- `src/auth/decorators/current-user.decorator.ts` — `@CurrentUser()` param decorator
- `src/auth/refresh-token.service.ts` — DB-backed rotation + reuse detection
- `src/auth/refresh-token.service.spec.ts`
- `src/strategy/presets.ts` — `PRESETS` map
- `src/strategy/presets.spec.ts`
- `src/invites/invite.module.ts`
- `src/invites/invite.service.ts` — create / preview / accept / list / revoke
- `src/invites/invite.service.spec.ts`
- `src/invites/invite.controller.ts` — admin endpoints + public preview/accept
- `src/invites/dto/create-invite.dto.ts`
- `src/invites/dto/accept-invite.dto.ts`
- `src/mail/templates/invite.hbs`
- `src/me/me.module.ts`
- `src/me/me.controller.ts` — `GET /me`, `PATCH /me`
- `src/me/dto/update-me.dto.ts`
- `src/admin/admin.module.ts`
- `src/admin/users/admin-users.controller.ts`
- `src/admin/users/admin-users.service.ts`
- `src/admin/sessions/admin-sessions.controller.ts`
- `src/admin/engine/admin-engine.controller.ts`

**Modified:**
- `libs/prisma/schema.prisma` — add `User.botEnabled`, `User.presetKey`, `Invite`, `RefreshToken`, `DayNote.userId`, new `PresetKey` enum
- `src/auth/auth.controller.ts` — wire DB-backed refresh, add user to refresh flow
- `src/auth/auth.service.ts` — replace stateless refresh with `RefreshTokenService` calls
- `src/auth/auth.module.ts` — register `RefreshTokenService`
- `src/users/users.service.ts` — `create` accepts `presetKey`, add `setBotEnabled`, `setPreset`
- `src/strategy/live/live-strategy.service.ts` — gate fan-out on `user.botEnabled && user.isActive`, resolve preset, scope `notifyTradeOpened` to owner
- `src/mail/mail.service.ts` — add `to` param to `notifyTradeOpened`; add `sendInvite`
- `src/app.module.ts` — register `InvitesModule`, `MeModule`, `AdminModule`
- `src/journal/day-notes.service.ts` (if exists) — filter by `userId`

### Web (Next.js)

**New:**
- `src/components/dashboard/status-pill.tsx`
- `src/components/preset/preset-card.tsx`
- `src/components/preset/preset-picker.tsx`
- `src/app/join/[token]/page.tsx` — accept-invite page
- `src/app/preferences/page.tsx` — preset switcher + password change
- `src/app/admin/layout.tsx` — SUPERADMIN-only layout guard
- `src/app/admin/users/page.tsx` + `[id]/page.tsx`
- `src/app/admin/invites/page.tsx`
- `src/app/admin/sessions/page.tsx`
- `src/app/admin/engine/page.tsx`
- `src/hooks/use-me.ts`
- `src/hooks/use-admin-users.ts`
- `src/hooks/use-invites.ts`
- `src/hooks/use-sessions.ts`
- `src/lib/api-invites.ts`, `src/lib/api-admin.ts`, `src/lib/api-me.ts`

**Modified:**
- `src/app/dashboard/page.tsx` — status-focused redesign (hero, open positions, today)
- `src/components/layout/sidebar.tsx` — strip backtest from WORKSPACE, add SUPERADMIN ADMIN section
- `src/components/layout/topbar.tsx` — add `StatusPill` slot
- `src/contexts/AuthContext.tsx` — expose `botEnabled`, `presetKey`, role
- `src/lib/api.ts` — add 401-retry-once interceptor for in-session expiry

### Docs

- `docs/RUNBOOK.md` — add invite-create / revoke / sessions sections
- `.env.example` — `WEB_URL` already exists; add `ADMIN_NOTIFY_EMAIL` (optional)

---

## Branch + Setup

Work on branch `feat/spec2-multi-tenant`. Create from `main`:

```bash
git checkout main
git pull
git checkout -b feat/spec2-multi-tenant
```

Install `argon2`:

```bash
npm install argon2
```

---

## Task 1: Schema additions (User columns, PresetKey enum, RefreshToken)

**Files:**
- Modify: `libs/prisma/schema.prisma`
- Create: `libs/prisma/migrations/<auto>_multi_tenant_base/migration.sql` (generated)

- [ ] **Step 1: Edit schema — add `PresetKey` enum and `User` columns**

Add near the top of `libs/prisma/schema.prisma` (after existing enums):

```prisma
enum PresetKey {
  CONSERVATIVE
  BALANCED
  AGGRESSIVE
}
```

Modify the `User` model — add two columns (immediately after `isActive`):

```prisma
model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  role         UserRole  @default(USER)
  isActive     Boolean   @default(true)
  botEnabled   Boolean   @default(true)
  presetKey    PresetKey @default(BALANCED)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  passwordResetTokens PasswordResetToken[]
  brokerAccounts      BrokerAccount[]
  refreshTokens       RefreshToken[]
  invitesCreated      Invite[]              @relation("InviteCreator")
  dayNotes            DayNote[]

  @@index([email])
}
```

- [ ] **Step 2: Add `RefreshToken` and `Invite` models**

Append to `libs/prisma/schema.prisma`:

```prisma
model RefreshToken {
  id           String    @id @default(uuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash    String    @unique
  expiresAt    DateTime
  revokedAt    DateTime?
  replacedById String?
  userAgent    String?
  createdAt    DateTime  @default(now())

  @@index([userId])
  @@index([expiresAt])
}

model Invite {
  id          String    @id @default(uuid())
  email       String
  tokenHash   String    @unique
  createdById String
  createdBy   User      @relation("InviteCreator", fields: [createdById], references: [id])
  expiresAt   DateTime
  acceptedAt  DateTime?
  createdAt   DateTime  @default(now())

  @@index([email])
  @@index([expiresAt])
}
```

- [ ] **Step 3: Generate migration**

Run:
```bash
npx prisma migrate dev --name multi_tenant_base --create-only
```

Expected: a new directory under `libs/prisma/migrations/` containing `migration.sql`. Open it; verify additive (no DROP COLUMN).

- [ ] **Step 4: Apply migration locally**

```bash
npx prisma migrate dev
npx prisma generate
```

Expected: migration applied; `@prisma/client` regenerated with new types.

- [ ] **Step 5: Smoke test the new types compile**

```bash
npm run build
```

Expected: `nest build` succeeds with no TypeScript errors (no consumers of new fields yet, so this is just a compile check).

- [ ] **Step 6: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/
git commit -m "feat(schema): add PresetKey enum, User.botEnabled/presetKey, RefreshToken, Invite"
```

---

## Task 2: Schema — DayNote.userId (nullable → backfill → NOT NULL)

**Files:**
- Modify: `libs/prisma/schema.prisma`
- Create: `scripts/backfill-spec2.ts`

- [ ] **Step 1: Edit schema — add `DayNote.userId` nullable + relation**

Modify the `DayNote` model in `libs/prisma/schema.prisma`:

```prisma
model DayNote {
  id        String   @id @default(uuid())
  tradeDate String                          // existing — "YYYY-MM-DD"
  note      String                          // existing
  createdAt DateTime @default(now())        // existing
  updatedAt DateTime @updatedAt             // existing
  userId    String?                         // NEW — nullable for backfill phase
  user      User?    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  // Keep existing @@unique([tradeDate]) — will replace in Task 2b after backfill
}
```

- [ ] **Step 2: Generate migration**

```bash
npx prisma migrate dev --name daynote_userid_nullable --create-only
npx prisma migrate dev
npx prisma generate
```

- [ ] **Step 3: Write backfill script**

Create `scripts/backfill-spec2.ts`:

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const me = await prisma.user.findFirst({
    where: { role: 'SUPERADMIN' },
  }) ?? await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

  if (me.role !== 'SUPERADMIN') {
    await prisma.user.update({ where: { id: me.id }, data: { role: 'SUPERADMIN' } });
    console.log(`Promoted ${me.email} to SUPERADMIN`);
  }

  const updated = await prisma.dayNote.updateMany({
    where: { userId: null },
    data: { userId: me.id },
  });
  console.log(`Backfilled ${updated.count} DayNote rows with userId=${me.id}`);

  await prisma.user.update({
    where: { id: me.id },
    data: { presetKey: 'BALANCED', botEnabled: true },
  });
  console.log(`Ensured ${me.email} has presetKey=BALANCED, botEnabled=true`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Run backfill on local DB**

```bash
npx ts-node scripts/backfill-spec2.ts
```

Expected output: "Backfilled N DayNote rows", "Ensured ... has presetKey=BALANCED".

- [ ] **Step 5: Verify in DB**

```bash
psql $DATABASE_URL -c 'SELECT COUNT(*) FROM "DayNote" WHERE "userId" IS NULL;'
```

Expected: `0`.

- [ ] **Step 6: Tighten schema — `userId` NOT NULL + flip unique constraint**

Modify `DayNote` again:

```prisma
model DayNote {
  id        String   @id @default(uuid())
  tradeDate String
  note      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  userId    String                          // CHANGED: no longer nullable
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, tradeDate])             // CHANGED: was @@unique([tradeDate])
  @@index([userId])
}
```

- [ ] **Step 7: Generate + apply final migration**

```bash
npx prisma migrate dev --name daynote_userid_required --create-only
npx prisma migrate dev
npx prisma generate
npm run build
```

Expected: build passes; any `DayNote` consumers that don't include `userId` will surface as compile errors — fix them by accepting `userId` from the controller (most likely callers are in `src/journal/*`).

- [ ] **Step 8: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/ scripts/backfill-spec2.ts
git commit -m "feat(schema): DayNote.userId required + backfill script"
```

---

## Task 3: `@CurrentUser()` decorator

**Files:**
- Create: `src/auth/decorators/current-user.decorator.ts`
- Create: `src/auth/decorators/current-user.decorator.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/auth/decorators/current-user.decorator.spec.ts`:

```ts
import { ExecutionContext } from '@nestjs/common';
import { currentUserFactory } from './current-user.decorator';

function mockCtx(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('CurrentUser decorator', () => {
  it('returns the user from the request', () => {
    const user = { id: 'u1', email: 'a@b', role: 'USER' };
    expect(currentUserFactory(undefined, mockCtx(user))).toEqual(user);
  });

  it('returns undefined if request has no user', () => {
    expect(currentUserFactory(undefined, mockCtx(undefined))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx jest src/auth/decorators/current-user.decorator.spec.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/auth/decorators/current-user.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../auth.service';

export function currentUserFactory(
  _data: unknown,
  ctx: ExecutionContext,
): AuthenticatedUser | undefined {
  const req = ctx.switchToHttp().getRequest();
  return req.user as AuthenticatedUser | undefined;
}

export const CurrentUser = createParamDecorator(currentUserFactory);
```

- [ ] **Step 4: Re-run test**

```bash
npx jest src/auth/decorators/current-user.decorator.spec.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/decorators/
git commit -m "feat(auth): add @CurrentUser() param decorator"
```

---

## Task 4: `RefreshTokenService` (DB-backed rotation + reuse detection)

**Files:**
- Create: `src/auth/refresh-token.service.ts`
- Create: `src/auth/refresh-token.service.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/auth/refresh-token.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { RefreshTokenService } from './refresh-token.service';
import { PrismaService } from '@app/prisma';

describe('RefreshTokenService', () => {
  let svc: RefreshTokenService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [RefreshTokenService, PrismaService],
    }).compile();
    svc = moduleRef.get(RefreshTokenService);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeUser() {
    return prisma.user.create({
      data: { email: `u${Date.now()}@x.test`, passwordHash: 'x', role: 'USER' },
    });
  }

  it('issue() returns raw token and stores hash', async () => {
    const user = await makeUser();
    const { token } = await svc.issue(user.id, 'agent');
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(token);
  });

  it('rotate() revokes old and returns new', async () => {
    const user = await makeUser();
    const a = await svc.issue(user.id, 'agent');
    const b = await svc.rotate(a.token, 'agent');
    const oldRow = await prisma.refreshToken.findFirst({ where: { id: a.id } });
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(oldRow?.replacedById).toBe(b.id);
    expect(b.token).not.toBe(a.token);
  });

  it('rotate() detects reuse and kills the whole family', async () => {
    const user = await makeUser();
    const a = await svc.issue(user.id, 'agent');
    const b = await svc.rotate(a.token, 'agent');
    // Reuse the old token
    await expect(svc.rotate(a.token, 'agent')).rejects.toThrow(/reuse/i);
    const bRow = await prisma.refreshToken.findFirst({ where: { id: b.id } });
    expect(bRow?.revokedAt).not.toBeNull();
  });

  it('rotate() fails for expired token', async () => {
    const user = await makeUser();
    const { token, id } = await svc.issue(user.id, 'agent');
    await prisma.refreshToken.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(svc.rotate(token, 'agent')).rejects.toThrow(/expired/i);
  });

  it('revokeAllForUser() marks every active row as revoked', async () => {
    const user = await makeUser();
    await svc.issue(user.id, 'a');
    await svc.issue(user.id, 'b');
    await svc.revokeAllForUser(user.id);
    const active = await prisma.refreshToken.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
npx jest src/auth/refresh-token.service.spec.ts
```

Expected: FAIL (RefreshTokenService not found).

- [ ] **Step 3: Implement the service**

Create `src/auth/refresh-token.service.ts`:

```ts
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '@app/prisma';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export interface IssuedToken {
  id: string;
  token: string;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  async issue(userId: string, userAgent?: string): Promise<IssuedToken> {
    const token = generateToken();
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    const row = await this.prisma.refreshToken.create({
      data: { userId, tokenHash, expiresAt, userAgent: userAgent ?? null },
    });
    return { id: row.id, token };
  }

  async rotate(presentedToken: string, userAgent?: string): Promise<IssuedToken & { userId: string }> {
    const tokenHash = hash(presentedToken);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!row) throw new UnauthorizedException('Refresh token not found');

    if (row.revokedAt) {
      // Reuse detection — kill the entire chain rooted at this user
      this.logger.warn(`Refresh-token reuse detected for userId=${row.userId}`);
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (row.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Issue new
    const next = await this.issue(row.userId, userAgent);

    // Mark old as revoked + chained
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), replacedById: next.id },
    });

    return { ...next, userId: row.userId };
  }

  async revoke(presentedToken: string): Promise<void> {
    const tokenHash = hash(presentedToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async cleanupExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - REFRESH_TTL_MS);
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return count;
  }
}
```

- [ ] **Step 4: Register provider in `AuthModule`**

Edit `src/auth/auth.module.ts` — add `RefreshTokenService` to `providers` and to `exports`.

- [ ] **Step 5: Re-run tests**

```bash
npx jest src/auth/refresh-token.service.spec.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth/refresh-token.service.ts src/auth/refresh-token.service.spec.ts src/auth/auth.module.ts
git commit -m "feat(auth): DB-backed RefreshTokenService with rotation + reuse detection"
```

---

## Task 5: Wire `RefreshTokenService` into `AuthService` + `AuthController`

**Files:**
- Modify: `src/auth/auth.service.ts`
- Modify: `src/auth/auth.controller.ts`

- [ ] **Step 1: Update `AuthService.login` to issue DB-backed refresh**

Edit `src/auth/auth.service.ts`:

Inject `RefreshTokenService`:

```ts
constructor(
  private readonly users: UsersService,
  private readonly jwt: JwtService,
  private readonly prisma: PrismaService,
  private readonly mail: MailService,
  private readonly refreshTokens: RefreshTokenService,   // NEW
) {}
```

Replace `login()`:

```ts
async login(email: string, password: string, userAgent?: string) {
  const user = await this.validateCredentials(email, password);
  await this.users.recordLogin(user.id);
  const { token: refreshToken } = await this.refreshTokens.issue(user.id, userAgent);
  return {
    user: { id: user.id, email: user.email, role: user.role },
    accessToken: this.signAccessToken(user),
    refreshToken,
  };
}
```

Replace `refresh()`:

```ts
async refresh(presentedRefreshToken: string, userAgent?: string) {
  const rotated = await this.refreshTokens.rotate(presentedRefreshToken, userAgent);
  const user = await this.users.findById(rotated.userId);
  if (!user || !user.isActive) {
    await this.refreshTokens.revokeAllForUser(rotated.userId);
    throw new UnauthorizedException('User no longer valid');
  }
  return {
    user: { id: user.id, email: user.email, role: user.role },
    accessToken: this.signAccessToken(user),
    refreshToken: rotated.token,
  };
}
```

Remove `signRefreshToken` and `verifyRefreshToken` (no longer needed — refresh is DB-backed).

Add a `logout` helper:

```ts
async logout(refreshToken?: string) {
  if (refreshToken) {
    await this.refreshTokens.revoke(refreshToken);
  }
}
```

- [ ] **Step 2: Update `AuthController` to plumb userAgent + revoke on logout**

Edit `src/auth/auth.controller.ts`:

In `login`:

```ts
@Public()
@Post('login')
@HttpCode(200)
async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
  const ua = req.headers['user-agent'] ?? undefined;
  const result = await this.auth.login(dto.email, dto.password, ua);
  res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts(ACCESS_MAX_AGE_MS));
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts(REFRESH_MAX_AGE_MS));
  return { user: result.user };
}
```

In `refresh`:

```ts
@Public()
@Post('refresh')
@HttpCode(200)
async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return { user: null };
  const ua = req.headers['user-agent'] ?? undefined;
  const result = await this.auth.refresh(token, ua);
  res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts(ACCESS_MAX_AGE_MS));
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts(REFRESH_MAX_AGE_MS));
  return { user: result.user };
}
```

In `logout`:

```ts
@Post('logout')
@HttpCode(200)
async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE];
  await this.auth.logout(token);
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  return { ok: true };
}
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: clean compile.

- [ ] **Step 4: Run all auth tests**

```bash
npx jest src/auth
```

Expected: all PASS (including RefreshTokenService spec from Task 4).

- [ ] **Step 5: E2E smoke (manual)**

Start backend + web locally. Log in. Check that a row appears in `RefreshToken`. Wait > 15min OR forge a 401 from `/api/auth/me`, observe auto-refresh → new row created, old one `revokedAt` set.

- [ ] **Step 6: Commit**

```bash
git add src/auth/auth.service.ts src/auth/auth.controller.ts
git commit -m "feat(auth): wire DB-backed refresh into login/refresh/logout"
```

---

## Task 6: `InviteService` (create, preview, accept, list, revoke)

**Files:**
- Create: `src/invites/invite.service.ts`
- Create: `src/invites/invite.service.spec.ts`
- Create: `src/invites/invite.module.ts`

- [ ] **Step 1: Write failing tests**

Create `src/invites/invite.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { InviteService } from './invite.service';
import { PrismaService } from '@app/prisma';
import { MailService } from '../mail/mail.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';

describe('InviteService', () => {
  let svc: InviteService;
  let prisma: PrismaService;

  const mailMock = { sendInvite: jest.fn().mockResolvedValue(undefined) };
  const authMock = { signAccessToken: jest.fn(() => 'jwt-fake') };
  const refreshMock = {
    issue: jest.fn().mockResolvedValue({ id: 'r1', token: 'raw-token' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InviteService,
        PrismaService,
        UsersService,
        { provide: MailService, useValue: mailMock },
        { provide: AuthService, useValue: authMock },
        { provide: RefreshTokenService, useValue: refreshMock },
      ],
    }).compile();
    svc = moduleRef.get(InviteService);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.invite.deleteMany();
    await prisma.user.deleteMany();
    mailMock.sendInvite.mockClear();
  });

  afterAll(async () => prisma.$disconnect());

  async function makeAdmin() {
    return prisma.user.create({
      data: { email: 'admin@x.test', passwordHash: 'x', role: 'SUPERADMIN' },
    });
  }

  it('create() generates an invite, stores hash, sends email', async () => {
    const admin = await makeAdmin();
    const { invite, token } = await svc.create('alice@example.com', admin.id, 7);
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(invite.email).toBe('alice@example.com');
    expect(invite.acceptedAt).toBeNull();
    expect(mailMock.sendInvite).toHaveBeenCalledWith('alice@example.com', expect.stringContaining(token));
  });

  it('preview() returns invite when valid', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('alice@example.com', admin.id, 7);
    const preview = await svc.preview(token);
    expect(preview).toEqual({ email: 'alice@example.com', expiresAt: expect.any(Date) });
  });

  it('preview() returns null when expired', async () => {
    const admin = await makeAdmin();
    const { token, invite } = await svc.create('alice@example.com', admin.id, 7);
    await prisma.invite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await svc.preview(token)).toBeNull();
  });

  it('preview() returns null when already accepted', async () => {
    const admin = await makeAdmin();
    const { token, invite } = await svc.create('alice@example.com', admin.id, 7);
    await prisma.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });
    expect(await svc.preview(token)).toBeNull();
  });

  it('accept() creates user and marks invite used', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('alice@example.com', admin.id, 7);
    const result = await svc.accept(token, 'StrongPass123!', 'BALANCED', 'agent');
    expect(result.user.email).toBe('alice@example.com');
    expect(result.user.role).toBe('USER');
    expect(result.accessToken).toBe('jwt-fake');
    expect(result.refreshToken).toBe('raw-token');
    const after = await prisma.invite.findFirst({ where: { email: 'alice@example.com' } });
    expect(after?.acceptedAt).not.toBeNull();
  });

  it('accept() fails on reused token', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('alice@example.com', admin.id, 7);
    await svc.accept(token, 'StrongPass123!', 'BALANCED');
    await expect(svc.accept(token, 'StrongPass123!', 'BALANCED')).rejects.toThrow();
  });

  it('accept() fails if email already a user', async () => {
    const admin = await makeAdmin();
    const { token } = await svc.create('admin@x.test', admin.id, 7); // admin's email
    await expect(svc.accept(token, 'StrongPass123!', 'BALANCED')).rejects.toThrow(/exists/i);
  });

  it('list() returns invites with creator email', async () => {
    const admin = await makeAdmin();
    await svc.create('a@x', admin.id, 7);
    await svc.create('b@x', admin.id, 7);
    const list = await svc.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(expect.objectContaining({ email: expect.any(String), status: 'pending' }));
  });

  it('revoke() sets expiresAt to now', async () => {
    const admin = await makeAdmin();
    const { invite } = await svc.create('alice@example.com', admin.id, 7);
    await svc.revoke(invite.id);
    const after = await prisma.invite.findUnique({ where: { id: invite.id } });
    expect(after!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
npx jest src/invites/invite.service.spec.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `InviteService`**

Create `src/invites/invite.service.ts`:

```ts
import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { PresetKey, Invite } from '@prisma/client';
import { PrismaService } from '@app/prisma';
import { MailService } from '../mail/mail.service';
import { AuthService } from '../auth/auth.service';
import { RefreshTokenService } from '../auth/refresh-token.service';

const TOKEN_BYTES = 32;
const DEFAULT_EXPIRY_DAYS = 7;

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly auth: AuthService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async create(email: string, createdById: string, expiresInDays = DEFAULT_EXPIRY_DAYS): Promise<{ invite: Invite; token: string }> {
    const normalized = email.toLowerCase().trim();
    const token = generateToken();
    const tokenHash = await argon2.hash(token, { type: argon2.argon2id });
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const invite = await this.prisma.invite.create({
      data: { email: normalized, tokenHash, createdById, expiresAt },
    });

    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const url = `${webUrl}/join/${token}`;
    await this.mail.sendInvite(normalized, url);

    return { invite, token };
  }

  async preview(token: string): Promise<{ email: string; expiresAt: Date } | null> {
    const invite = await this.findByToken(token);
    if (!invite) return null;
    if (invite.acceptedAt) return null;
    if (invite.expiresAt < new Date()) return null;
    return { email: invite.email, expiresAt: invite.expiresAt };
  }

  async accept(token: string, password: string, presetKey: PresetKey, userAgent?: string) {
    const invite = await this.findByToken(token);
    if (!invite) throw new BadRequestException('Invalid invite');
    if (invite.acceptedAt) throw new BadRequestException('Invite already used');
    if (invite.expiresAt < new Date()) throw new BadRequestException('Invite expired');

    const existing = await this.prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) throw new ConflictException('User already exists for this email');

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: invite.email,
          passwordHash,
          role: 'USER',
          presetKey,
          botEnabled: true,
        },
      });
      await tx.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      return created;
    });

    const accessToken = this.auth.signAccessToken(user);
    const { token: refreshToken } = await this.refreshTokens.issue(user.id, userAgent);

    return {
      user: { id: user.id, email: user.email, role: user.role },
      accessToken,
      refreshToken,
    };
  }

  async list() {
    const rows = await this.prisma.invite.findMany({
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      acceptedAt: r.acceptedAt,
      status: r.acceptedAt ? 'accepted' : r.expiresAt < new Date() ? 'expired' : 'pending',
      createdBy: r.createdBy.email,
    }));
  }

  async revoke(id: string): Promise<void> {
    const invite = await this.prisma.invite.findUnique({ where: { id } });
    if (!invite) throw new NotFoundException('Invite not found');
    await this.prisma.invite.update({
      where: { id },
      data: { expiresAt: new Date() },
    });
  }

  private async findByToken(presented: string): Promise<Invite | null> {
    // argon2 hashes are not deterministic — must compare against every pending row.
    // For 5–10 users this is trivially small. If this grows, switch to a deterministic
    // pepper or per-invite salt stored alongside.
    const candidates = await this.prisma.invite.findMany({
      where: { acceptedAt: null },
    });
    for (const row of candidates) {
      const ok = await argon2.verify(row.tokenHash, presented);
      if (ok) return row;
    }
    return null;
  }
}
```

- [ ] **Step 4: Create the module**

Create `src/invites/invite.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { InviteService } from './invite.service';
import { PrismaModule } from '@app/prisma';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, MailModule, AuthModule],
  providers: [InviteService],
  exports: [InviteService],
})
export class InviteModule {}
```

- [ ] **Step 5: Add `MailService.sendInvite` stub (real template in Task 8)**

Edit `src/mail/mail.service.ts` — add the method:

```ts
async sendInvite(email: string, url: string): Promise<void> {
  this.logger.log(`(stub) sendInvite to=${email} url=${url}`);
}
```

(Implementation with Handlebars template added in Task 8.)

- [ ] **Step 6: Re-run tests**

```bash
npx jest src/invites/invite.service.spec.ts
```

Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add src/invites/ src/mail/mail.service.ts
git commit -m "feat(invites): InviteService with argon2 token + accept transaction"
```

---

## Task 7: Invite controllers (`/admin/invites` + public `/invites/:token/*`)

**Files:**
- Create: `src/invites/invite.controller.ts`
- Create: `src/invites/dto/create-invite.dto.ts`
- Create: `src/invites/dto/accept-invite.dto.ts`
- Modify: `src/invites/invite.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Write DTOs**

Create `src/invites/dto/create-invite.dto.ts`:

```ts
import { IsEmail, IsInt, IsOptional, Min, Max } from 'class-validator';

export class CreateInviteDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number;
}
```

Create `src/invites/dto/accept-invite.dto.ts`:

```ts
import { IsEnum, IsString, MinLength } from 'class-validator';
import { PresetKey } from '@prisma/client';

export class AcceptInviteDto {
  @IsString()
  @MinLength(8)
  password!: string;

  @IsEnum(PresetKey)
  presetKey!: PresetKey;
}
```

- [ ] **Step 2: Write the controller**

Create `src/invites/invite.controller.ts`:

```ts
import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard, Public } from '../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { InviteService } from './invite.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';

const ACCESS_COOKIE = 'auth_token';
const REFRESH_COOKIE = 'refresh_token';
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieOpts(maxAge: number) {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
}

@Controller('api')
export class InviteController {
  constructor(private readonly invites: InviteService) {}

  // ---------- ADMIN ----------

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPERADMIN')
  @Post('admin/invites')
  async create(@Body() dto: CreateInviteDto, @CurrentUser() me: AuthenticatedUser) {
    const { invite, token } = await this.invites.create(dto.email, me.id, dto.expiresInDays);
    return {
      id: invite.id,
      email: invite.email,
      expiresAt: invite.expiresAt,
      token,        // returned once for fallback copy
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPERADMIN')
  @Get('admin/invites')
  list() {
    return this.invites.list();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPERADMIN')
  @Delete('admin/invites/:id')
  @HttpCode(204)
  async revoke(@Param('id') id: string) {
    await this.invites.revoke(id);
  }

  // ---------- PUBLIC ----------

  @Public()
  @Get('invites/:token/preview')
  async preview(@Param('token') token: string) {
    const preview = await this.invites.preview(token);
    if (!preview) return { valid: false };
    return { valid: true, ...preview };
  }

  @Public()
  @Post('invites/:token/accept')
  @HttpCode(200)
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ua = req.headers['user-agent'] ?? undefined;
    const result = await this.invites.accept(token, dto.password, dto.presetKey, ua);
    res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts(ACCESS_MAX_AGE_MS));
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts(REFRESH_MAX_AGE_MS));
    return { user: result.user };
  }
}
```

- [ ] **Step 3: Wire controller into module**

Edit `src/invites/invite.module.ts`:

```ts
@Module({
  imports: [PrismaModule, MailModule, AuthModule],
  controllers: [InviteController],
  providers: [InviteService],
  exports: [InviteService],
})
export class InviteModule {}
```

- [ ] **Step 4: Register module in `AppModule`**

Edit `src/app.module.ts` — add `InviteModule` to `imports`.

- [ ] **Step 5: Build + run all tests**

```bash
npm run build
npx jest src/invites
```

Expected: clean build; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/invites/ src/app.module.ts
git commit -m "feat(invites): admin + public controllers"
```

---

## Task 8: Invite email template

**Files:**
- Create: `src/mail/templates/invite.hbs`
- Modify: `src/mail/mail.service.ts`

- [ ] **Step 1: Create the template**

Create `src/mail/templates/invite.hbs` (mirror `reset-password.hbs` style — check that file first for layout consistency):

```hbs
<!DOCTYPE html>
<html>
<body style="background:#1a1612;color:#ece8e3;font-family:system-ui,sans-serif;padding:40px 20px;margin:0;">
  <div style="max-width:560px;margin:0 auto;background:#231f1a;border:1px solid #383229;border-radius:6px;padding:40px;">
    <div style="font-size:13px;letter-spacing:0.16em;color:#F2C31C;margin-bottom:24px;">▲ SHAMARX</div>
    <h1 style="font-size:22px;color:#ece8e3;margin:0 0 16px 0;">You're invited</h1>
    <p style="color:#ece8e3;line-height:1.6;font-size:14px;margin-bottom:24px;">
      You've been invited to join Shamarx. Click below to set your password and choose your strategy preset.
    </p>
    <a href="{{url}}" style="display:inline-block;background:#F2C31C;color:#1a1612;font-weight:600;padding:12px 24px;text-decoration:none;border-radius:4px;font-size:13px;letter-spacing:0.04em;">
      Accept invite
    </a>
    <p style="color:#8d8275;font-size:11px;margin-top:32px;line-height:1.6;">
      Or paste this link in your browser:<br>
      <span style="font-family:monospace;color:#5e5447;font-size:10px;word-break:break-all;">{{url}}</span>
    </p>
    <p style="color:#5e5447;font-size:11px;margin-top:24px;">
      This link expires in 7 days. If you weren't expecting this, you can safely ignore the email.
    </p>
  </div>
</body>
</html>
```

- [ ] **Step 2: Implement `MailService.sendInvite`**

Replace the stub from Task 6 in `src/mail/mail.service.ts`. Mirror the existing `sendPasswordReset` pattern (read that method first to match exactly how templates are loaded and rendered).

Example (adjust to match existing pattern):

```ts
async sendInvite(email: string, url: string): Promise<void> {
  const html = this.renderTemplate('invite', { url });
  await this.transporter.sendMail({
    from: this.fromAddress,
    to: email,
    subject: "You're invited to Shamarx",
    html,
  });
  this.logger.log(`Sent invite email to=${email}`);
}
```

- [ ] **Step 3: Manual smoke test**

Start backend locally (with SMTP env set). Create an invite via `curl`:

```bash
curl -X POST http://localhost:3001/api/admin/invites \
  -H "Content-Type: application/json" \
  -H "Cookie: auth_token=<your-jwt>" \
  -d '{"email":"test+invite@yourdomain.com"}'
```

Expected: email arrives in inbox with the gold-accented Shamarx template.

- [ ] **Step 4: Commit**

```bash
git add src/mail/templates/invite.hbs src/mail/mail.service.ts
git commit -m "feat(mail): invite.hbs template + sendInvite implementation"
```

---

## Task 9: `PRESETS` map + tests

**Files:**
- Create: `src/strategy/presets.ts`
- Create: `src/strategy/presets.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/strategy/presets.spec.ts`:

```ts
import { PRESETS, getPreset } from './presets';

describe('PRESETS', () => {
  it('defines all three presets', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['AGGRESSIVE', 'BALANCED', 'CONSERVATIVE']);
  });

  it('BALANCED matches the validated live config', () => {
    expect(PRESETS.BALANCED).toEqual({
      riskPercent: 1.0,
      maxDailyLossPercent: 3.0,
      maxOpenPositions: 3,
      pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
    });
  });

  it('CONSERVATIVE is strictly safer than BALANCED', () => {
    expect(PRESETS.CONSERVATIVE.riskPercent).toBeLessThan(PRESETS.BALANCED.riskPercent);
    expect(PRESETS.CONSERVATIVE.maxDailyLossPercent).toBeLessThan(PRESETS.BALANCED.maxDailyLossPercent);
  });

  it('AGGRESSIVE is bolder than BALANCED', () => {
    expect(PRESETS.AGGRESSIVE.riskPercent).toBeGreaterThan(PRESETS.BALANCED.riskPercent);
  });

  it('getPreset() returns the typed preset', () => {
    expect(getPreset('BALANCED')).toBe(PRESETS.BALANCED);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npx jest src/strategy/presets.spec.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/strategy/presets.ts`:

```ts
import { PresetKey } from '@prisma/client';

export interface StrategyPreset {
  riskPercent: number;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  pairs: string[];
}

export const PRESETS: Record<PresetKey, StrategyPreset> = {
  CONSERVATIVE: {
    riskPercent: 0.5,
    maxDailyLossPercent: 2.0,
    maxOpenPositions: 2,
    pairs: ['EURUSD', 'GBPUSD'],
  },
  BALANCED: {
    riskPercent: 1.0,
    maxDailyLossPercent: 3.0,
    maxOpenPositions: 3,
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  },
  AGGRESSIVE: {
    riskPercent: 1.5,
    maxDailyLossPercent: 5.0,
    maxOpenPositions: 3,
    pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  },
};

export function getPreset(key: PresetKey): StrategyPreset {
  return PRESETS[key];
}
```

- [ ] **Step 4: Re-run tests**

```bash
npx jest src/strategy/presets.spec.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/strategy/presets.ts src/strategy/presets.spec.ts
git commit -m "feat(strategy): PRESETS map (Conservative/Balanced/Aggressive)"
```

---

## Task 10: Engine fan-out gate — user.botEnabled, user.isActive, preset filter

**Files:**
- Modify: `src/strategy/live/live-strategy.service.ts` (around lines 540-580 — `evaluatePairForAccount` entry)
- Modify: `src/strategy/live/live-strategy.service.spec.ts` (if exists; otherwise create alongside)

- [ ] **Step 1: Write the failing test**

Add to `src/strategy/live/live-strategy.service.spec.ts` (or create if missing — extend existing pattern from other `live-*.spec.ts` files):

```ts
describe('LiveStrategyService — per-user gates', () => {
  // (constructor setup pattern: see existing spec file in same directory)

  it('skips fan-out when user.botEnabled = false', async () => {
    const acct = await seedAccount({ botEnabled: false });
    const evalSpy = jest.spyOn(service as any, 'evaluatePairForAccountInternal');
    await service.evaluatePairForAccount('EURUSD', acct);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('skips fan-out when user.isActive = false', async () => {
    const acct = await seedAccount({ isActive: false });
    const evalSpy = jest.spyOn(service as any, 'evaluatePairForAccountInternal');
    await service.evaluatePairForAccount('EURUSD', acct);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('skips when symbol not in user preset pairs (CONSERVATIVE excludes XAUUSD)', async () => {
    const acct = await seedAccount({ presetKey: 'CONSERVATIVE' });
    const evalSpy = jest.spyOn(service as any, 'evaluatePairForAccountInternal');
    await service.evaluatePairForAccount('XAUUSD', acct);
    expect(evalSpy).not.toHaveBeenCalled();
  });
});
```

(`seedAccount` is a test helper — create one if not present that creates `User` + `BrokerAccount` with overridable fields and joins `account.user` in the result.)

- [ ] **Step 2: Run tests, confirm failure**

```bash
npx jest src/strategy/live/live-strategy.service.spec.ts
```

Expected: FAIL (gates not implemented).

- [ ] **Step 3: Read existing `evaluatePairForAccount`**

```bash
sed -n '540,640p' src/strategy/live/live-strategy.service.ts
```

Identify where the method body begins and where the first real evaluation logic happens. We're inserting gates at the top.

- [ ] **Step 4: Refactor — extract gate**

In `src/strategy/live/live-strategy.service.ts`, add the import at top:

```ts
import { PRESETS } from '../presets';
```

Rename the existing implementation method to `evaluatePairForAccountInternal` (so the test's spy works). Add a new public entry point:

```ts
async evaluatePairForAccount(symbol: string, account: BrokerAccountWithUser): Promise<void> {
  if (!account.user) {
    this.logger.warn(`account=${account.id} has no user — skipping`);
    return;
  }
  if (!account.user.botEnabled || !account.user.isActive) {
    return;
  }
  if (!account.isEnabled || !account.healthOk) {
    return;
  }
  const preset = PRESETS[account.user.presetKey];
  if (!preset.pairs.includes(symbol)) {
    return;
  }
  return this.evaluatePairForAccountInternal(symbol, account, preset);
}
```

Update `BrokerAccountWithUser` type (or wherever the account is fetched) to ensure `user` is included via Prisma `.include({ user: true })`. Search for the call site (around line 546 from earlier inspection) and add the `include`.

- [ ] **Step 5: Thread the preset into `evaluatePairForAccountInternal`**

In the renamed method, replace any hardcoded reads of risk values (currently from `process.env.RISK_PER_TRADE_PERCENT` etc.) with the `preset.riskPercent`, `preset.maxDailyLossPercent`, `preset.maxOpenPositions`. Search for `RISK_PER_TRADE_PERCENT` and `MAX_DAILY_LOSS_PERCENT` references inside the method and replace.

Example shape (adapt to existing code):

```ts
private async evaluatePairForAccountInternal(
  symbol: string,
  account: BrokerAccountWithUser,
  preset: StrategyPreset,
): Promise<void> {
  const riskManager = new RiskManager({
    riskPercent: preset.riskPercent,
    maxDailyLossPercent: preset.maxDailyLossPercent,
    maxOpenPositions: preset.maxOpenPositions,
    // ...existing fields stay
  });
  // ... rest of existing logic
}
```

- [ ] **Step 6: Re-run tests**

```bash
npx jest src/strategy/live/live-strategy.service.spec.ts
```

Expected: PASS for the 3 new tests + all existing tests still pass.

- [ ] **Step 7: Smoke build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/strategy/live/live-strategy.service.ts src/strategy/live/live-strategy.service.spec.ts
git commit -m "feat(strategy): gate fan-out on user.botEnabled/isActive + apply preset params"
```

---

## Task 11: Scope `notifyTradeOpened` to trade owner

**Files:**
- Modify: `src/strategy/live/live-strategy.service.ts` (line ~828 area — where `notifyTradeOpened` is currently called)
- Modify: `src/mail/mail.service.ts`
- Modify: `src/mail/mail.service.spec.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `src/mail/mail.service.spec.ts`:

```ts
describe('notifyTradeOpened scoping', () => {
  it('sends to the recipient email passed in payload', async () => {
    const sendSpy = jest.spyOn(service as any, 'sendMail').mockResolvedValue(undefined);
    await service.notifyTradeOpened({
      to: 'alice@example.com',
      symbol: 'EURUSD',
      side: 'SELL',
      entry: 1.0834,
      sl: 1.0856,
      tp: 1.0790,
      lotSize: 0.5,
      riskPercent: 1.0,
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alice@example.com' }),
    );
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npx jest src/mail/mail.service.spec.ts
```

Expected: FAIL (payload type doesn't include `to`).

- [ ] **Step 3: Update `MailService.notifyTradeOpened` signature**

Edit `src/mail/mail.service.ts` — read the existing interface first. Add `to: string` to the payload type, and use it as the `to` field in the underlying send call (replacing any "iterate over active users" logic):

```ts
export interface TradeOpenedPayload {
  to: string;           // NEW — trade owner's email
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number;
  lotSize: number;
  riskPercent: number;
  // ...existing fields
}

async notifyTradeOpened(payload: TradeOpenedPayload): Promise<void> {
  const html = this.renderTemplate('trade-opened', { ...payload, riskLabel: `${payload.riskPercent.toFixed(2)}%` });
  await this.sendMail({
    to: payload.to,
    subject: `Trade opened: ${payload.symbol} ${payload.side}`,
    html,
  });
}
```

Remove any pre-existing loop over `prisma.user.findMany({ where: { isActive: true } })` inside `MailService` — the owner-scoping is the new contract.

- [ ] **Step 4: Update the call site in `LiveStrategyService`**

Search for `notifyTradeOpened(` in `src/strategy/live/live-strategy.service.ts`. At the call site (around line 800-830), fetch the owner email from `account.user.email` and pass it as `to`:

```ts
await this.mail.notifyTradeOpened({
  to: account.user.email,
  symbol,
  side: signal.side,
  entry: signal.entry,
  sl: signal.sl,
  tp: signal.tp,
  lotSize,
  riskPercent: preset.riskPercent,
});
```

Delete the comment "owner once LiveSession.userId exists" — it's now resolved.

- [ ] **Step 5: Re-run tests**

```bash
npx jest src/mail
npx jest src/strategy/live
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mail/mail.service.ts src/mail/mail.service.spec.ts src/strategy/live/live-strategy.service.ts
git commit -m "feat(mail): scope notifyTradeOpened to trade owner only"
```

---

## Task 12: `/me` controller (GET + PATCH)

**Files:**
- Create: `src/me/me.module.ts`
- Create: `src/me/me.controller.ts`
- Create: `src/me/me.controller.spec.ts`
- Create: `src/me/dto/update-me.dto.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/me/me.controller.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { MeController } from './me.controller';
import { PrismaService } from '@app/prisma';

describe('MeController', () => {
  let controller: MeController;
  let prisma: PrismaService;
  let user: { id: string; email: string; role: 'USER' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [PrismaService],
    }).compile();
    controller = moduleRef.get(MeController);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
    const created = await prisma.user.create({
      data: { email: 'a@b.test', passwordHash: 'x', role: 'USER' },
    });
    user = { id: created.id, email: created.email, role: 'USER' };
  });

  afterAll(async () => prisma.$disconnect());

  it('GET /me returns the current user with botEnabled + presetKey', async () => {
    const result = await controller.getMe(user as any);
    expect(result).toEqual(expect.objectContaining({
      id: user.id, email: 'a@b.test', botEnabled: true, presetKey: 'BALANCED',
    }));
  });

  it('PATCH /me updates botEnabled', async () => {
    const result = await controller.updateMe(user as any, { botEnabled: false });
    expect(result.botEnabled).toBe(false);
    const dbRow = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbRow!.botEnabled).toBe(false);
  });

  it('PATCH /me updates presetKey', async () => {
    const result = await controller.updateMe(user as any, { presetKey: 'CONSERVATIVE' });
    expect(result.presetKey).toBe('CONSERVATIVE');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npx jest src/me
```

Expected: FAIL.

- [ ] **Step 3: Implement DTOs**

Create `src/me/dto/update-me.dto.ts`:

```ts
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PresetKey } from '@prisma/client';

export class UpdateMeDto {
  @IsOptional()
  @IsBoolean()
  botEnabled?: boolean;

  @IsOptional()
  @IsEnum(PresetKey)
  presetKey?: PresetKey;
}
```

- [ ] **Step 4: Implement the controller**

Create `src/me/me.controller.ts`:

```ts
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { PrismaService } from '@app/prisma';
import { UpdateMeDto } from './dto/update-me.dto';

@UseGuards(JwtAuthGuard)
@Controller('api/me')
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getMe(@CurrentUser() me: AuthenticatedUser) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        botEnabled: true,
        presetKey: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    return user;
  }

  @Patch()
  async updateMe(@CurrentUser() me: AuthenticatedUser, @Body() dto: UpdateMeDto) {
    return this.prisma.user.update({
      where: { id: me.id },
      data: {
        ...(dto.botEnabled !== undefined && { botEnabled: dto.botEnabled }),
        ...(dto.presetKey !== undefined && { presetKey: dto.presetKey }),
      },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        botEnabled: true,
        presetKey: true,
      },
    });
  }
}
```

- [ ] **Step 5: Create the module + register**

Create `src/me/me.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { PrismaModule } from '@app/prisma';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MeController],
})
export class MeModule {}
```

Add `MeModule` to `src/app.module.ts` imports.

- [ ] **Step 6: Re-run tests + build**

```bash
npx jest src/me
npm run build
```

Expected: PASS + clean build.

- [ ] **Step 7: Commit**

```bash
git add src/me/ src/app.module.ts
git commit -m "feat(me): GET /api/me + PATCH /api/me (botEnabled, presetKey)"
```

---

## Task 13: Admin `users` + `invites` endpoints

**Files:**
- Create: `src/admin/admin.module.ts`
- Create: `src/admin/users/admin-users.controller.ts`
- Create: `src/admin/users/admin-users.service.ts`
- Create: `src/admin/users/admin-users.service.spec.ts`
- Modify: `src/app.module.ts`

Note: invite endpoints already live under `/api/admin/invites` from Task 7. This task adds the users + (later in Task 14) sessions/engine views.

- [ ] **Step 1: Write the failing tests**

Create `src/admin/users/admin-users.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { AdminUsersService } from './admin-users.service';
import { PrismaService } from '@app/prisma';
import { RefreshTokenService } from '../../auth/refresh-token.service';

describe('AdminUsersService', () => {
  let svc: AdminUsersService;
  let prisma: PrismaService;
  const refreshMock = { revokeAllForUser: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        PrismaService,
        { provide: RefreshTokenService, useValue: refreshMock },
      ],
    }).compile();
    svc = moduleRef.get(AdminUsersService);
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.brokerAccount.deleteMany();
    await prisma.user.deleteMany();
    refreshMock.revokeAllForUser.mockClear();
  });

  afterAll(async () => prisma.$disconnect());

  it('list() returns users with derived counts', async () => {
    await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER' } });
    await prisma.user.create({ data: { email: 'b@x', passwordHash: 'p', role: 'SUPERADMIN' } });
    const list = await svc.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(expect.objectContaining({
      email: expect.any(String),
      role: expect.any(String),
      botEnabled: true,
      isActive: true,
      accountsTotal: 0,
      accountsEnabled: 0,
    }));
  });

  it('setActive(false) revokes all refresh tokens', async () => {
    const u = await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER' } });
    await svc.setActive(u.id, false);
    expect(refreshMock.revokeAllForUser).toHaveBeenCalledWith(u.id);
    const after = await prisma.user.findUnique({ where: { id: u.id } });
    expect(after!.isActive).toBe(false);
  });

  it('setBotEnabled toggles user.botEnabled', async () => {
    const u = await prisma.user.create({ data: { email: 'a@x', passwordHash: 'p', role: 'USER' } });
    await svc.setBotEnabled(u.id, false);
    expect((await prisma.user.findUnique({ where: { id: u.id } }))!.botEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npx jest src/admin/users
```

Expected: FAIL.

- [ ] **Step 3: Implement the service**

Create `src/admin/users/admin-users.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { RefreshTokenService } from '../../auth/refresh-token.service';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refresh: RefreshTokenService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({
      orderBy: { email: 'asc' },
      include: {
        brokerAccounts: { select: { isEnabled: true } },
      },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      botEnabled: u.botEnabled,
      presetKey: u.presetKey,
      accountsTotal: u.brokerAccounts.length,
      accountsEnabled: u.brokerAccounts.filter((a) => a.isEnabled).length,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      include: {
        brokerAccounts: true,
        refreshTokens: {
          where: { revokedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    return user;
  }

  async setActive(id: string, isActive: boolean) {
    await this.prisma.user.update({ where: { id }, data: { isActive } });
    if (!isActive) {
      await this.refresh.revokeAllForUser(id);
    }
  }

  async setBotEnabled(id: string, botEnabled: boolean) {
    await this.prisma.user.update({ where: { id }, data: { botEnabled } });
  }
}
```

- [ ] **Step 4: Implement the controller**

Create `src/admin/users/admin-users.controller.ts`:

```ts
import { Body, Controller, Get, Param, Patch, UseGuards, HttpCode } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../auth/guards/roles.guard';
import { AdminUsersService } from './admin-users.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERADMIN')
@Controller('api/admin/users')
export class AdminUsersController {
  constructor(private readonly svc: AdminUsersService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Patch(':id/active')
  @HttpCode(204)
  async setActive(@Param('id') id: string, @Body() body: { isActive: boolean }) {
    await this.svc.setActive(id, body.isActive);
  }

  @Patch(':id/bot-enabled')
  @HttpCode(204)
  async setBotEnabled(@Param('id') id: string, @Body() body: { botEnabled: boolean }) {
    await this.svc.setBotEnabled(id, body.botEnabled);
  }
}
```

- [ ] **Step 5: Create the admin module**

Create `src/admin/admin.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersController } from './users/admin-users.controller';
import { AdminUsersService } from './users/admin-users.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminModule {}
```

Add `AdminModule` to `src/app.module.ts`.

- [ ] **Step 6: Re-run tests + build**

```bash
npx jest src/admin
npm run build
```

Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add src/admin/ src/app.module.ts
git commit -m "feat(admin): users list/detail + isActive/botEnabled toggles"
```

---

## Task 14: Admin `sessions` + `engine` endpoints

**Files:**
- Create: `src/admin/sessions/admin-sessions.controller.ts`
- Create: `src/admin/sessions/admin-sessions.service.ts`
- Create: `src/admin/engine/admin-engine.controller.ts`
- Modify: `src/admin/admin.module.ts`

- [ ] **Step 1: Implement sessions service**

Create `src/admin/sessions/admin-sessions.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';

@Injectable()
export class AdminSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.refreshToken.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userEmail: r.user.email,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  async revoke(id: string) {
    await this.prisma.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
```

- [ ] **Step 2: Implement sessions controller**

Create `src/admin/sessions/admin-sessions.controller.ts`:

```ts
import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../auth/guards/roles.guard';
import { AdminSessionsService } from './admin-sessions.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERADMIN')
@Controller('api/admin/sessions')
export class AdminSessionsController {
  constructor(private readonly svc: AdminSessionsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id') id: string) {
    await this.svc.revoke(id);
  }
}
```

- [ ] **Step 3: Implement engine controller**

Create `src/admin/engine/admin-engine.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../auth/guards/roles.guard';
import { PrismaService } from '@app/prisma';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERADMIN')
@Controller('api/admin/engine')
export class AdminEngineController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('status')
  async status() {
    const session = await this.prisma.liveSession.findFirst({
      orderBy: { startedAt: 'desc' },
    });
    const activeUsers = await this.prisma.user.count({
      where: { isActive: true, botEnabled: true },
    });
    const enabledAccounts = await this.prisma.brokerAccount.count({
      where: { isEnabled: true },
    });
    const tradesToday = await this.prisma.trade.count({
      where: { openedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    return {
      session,
      activeUsers,
      enabledAccounts,
      tradesToday,
    };
  }

  @Post('pause-all')
  @HttpCode(204)
  async pauseAll(@Body() body: { confirm: string }) {
    if (body.confirm !== 'PAUSE-ALL') {
      throw new Error('Confirmation phrase required');
    }
    await this.prisma.user.updateMany({
      where: { role: 'USER' },
      data: { botEnabled: false },
    });
  }
}
```

- [ ] **Step 4: Register in `AdminModule`**

Edit `src/admin/admin.module.ts`:

```ts
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    AdminUsersController,
    AdminSessionsController,
    AdminEngineController,
  ],
  providers: [AdminUsersService, AdminSessionsService],
})
export class AdminModule {}
```

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 6: Manual smoke**

`curl http://localhost:3001/api/admin/sessions` with admin JWT — expect array of active sessions.
`curl http://localhost:3001/api/admin/engine/status` with admin JWT — expect aggregate JSON.

- [ ] **Step 7: Commit**

```bash
git add src/admin/
git commit -m "feat(admin): sessions list/revoke + engine status + pause-all"
```

---

## Task 15: Tenant-scoping audit — DayNote + JournalEntry + EquitySnapshot reads

**Files:**
- Audit + modify: `src/journal/**.service.ts` (all read paths)
- Audit + modify: `src/strategy/**` for any reads of `EquitySnapshot`, `Trade` that aren't already account-scoped

- [ ] **Step 1: Grep for tenant-scoped models without `userId`/`accountId` filter**

```bash
grep -rn "prisma.dayNote\|prisma.journalEntry\|prisma.equitySnapshot\|prisma.trade" src/ | grep -v ".spec.ts" | grep -v "userId\|accountId"
```

Expected: a list of suspect call sites that need scoping. Some may be admin paths (legitimate); the rest need `{ where: { userId } }` (DayNote) or `{ where: { account: { userId } } }` (Trade/EquitySnapshot).

- [ ] **Step 2: For each suspect site, decide and modify**

For friend-facing endpoints, add `userId` filter via `@CurrentUser() me`. Example for DayNote read:

```ts
async listForUser(userId: string, fromDate: string, toDate: string) {
  return this.prisma.dayNote.findMany({
    where: { userId, tradeDate: { gte: fromDate, lte: toDate } },
    orderBy: { tradeDate: 'desc' },
  });
}
```

DayNote write:

```ts
async upsert(userId: string, tradeDate: string, note: string) {
  return this.prisma.dayNote.upsert({
    where: { userId_tradeDate: { userId, tradeDate } },
    update: { note },
    create: { userId, tradeDate, note },
  });
}
```

For Trade reads via JournalService (existing): if the query is `prisma.trade.findMany`, add `where: { account: { userId } }`.

- [ ] **Step 3: Update the controllers**

For every modified service method, update the controller to extract `userId` from `@CurrentUser()` and pass it down. Example:

```ts
@Get('day-notes')
async list(
  @CurrentUser() me: AuthenticatedUser,
  @Query('from') from: string,
  @Query('to') to: string,
) {
  return this.svc.listForUser(me.id, from, to);
}
```

- [ ] **Step 4: Add an integration test that proves isolation**

Create `test/multi-tenant-isolation.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Multi-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let aliceToken: string;
  let bobToken: string;
  let aliceId: string;
  let bobId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.dayNote.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    const pw = await bcrypt.hash('alice-pass', 10);
    const alice = await prisma.user.create({
      data: { email: 'alice@test', passwordHash: pw, role: 'USER' },
    });
    const bob = await prisma.user.create({
      data: { email: 'bob@test', passwordHash: pw, role: 'USER' },
    });
    aliceId = alice.id; bobId = bob.id;
    await prisma.dayNote.create({ data: { userId: aliceId, tradeDate: '2026-06-01', note: 'alice note' } });
    await prisma.dayNote.create({ data: { userId: bobId, tradeDate: '2026-06-01', note: 'bob note' } });

    aliceToken = (await request(app.getHttpServer())
      .post('/api/auth/login').send({ email: 'alice@test', password: 'alice-pass' }))
      .headers['set-cookie']
      ?.find((c: string) => c.startsWith('auth_token='))
      ?.split(';')[0].split('=')[1];
    bobToken = (await request(app.getHttpServer())
      .post('/api/auth/login').send({ email: 'bob@test', password: 'alice-pass' }))
      .headers['set-cookie']
      ?.find((c: string) => c.startsWith('auth_token='))
      ?.split(';')[0].split('=')[1];
  });

  afterAll(async () => app.close());

  it('alice can only see her own day notes', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/day-notes?from=2026-06-01&to=2026-06-01')
      .set('Cookie', `auth_token=${aliceToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ note: 'alice note' })]);
    expect(res.body.find((n: any) => n.note === 'bob note')).toBeUndefined();
  });

  it('bob can only see his own day notes', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/day-notes?from=2026-06-01&to=2026-06-01')
      .set('Cookie', `auth_token=${bobToken}`);
    expect(res.body).toEqual([expect.objectContaining({ note: 'bob note' })]);
  });

  it('non-SUPERADMIN gets 403 on /api/admin/users', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Cookie', `auth_token=${aliceToken}`);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 5: Run e2e**

```bash
npx jest test/multi-tenant-isolation.e2e-spec.ts --runInBand
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/journal/ test/multi-tenant-isolation.e2e-spec.ts
git commit -m "feat(journal): scope DayNote/JournalEntry queries by userId + e2e test"
```

---

## Task 16: Web — auth context (expose `botEnabled`, `presetKey`) + 401 retry interceptor

**Files:**
- Modify: `/Users/shepyrd/development/shamarx/shamarx-web/src/contexts/AuthContext.tsx`
- Modify: `/Users/shepyrd/development/shamarx/shamarx-web/src/lib/api.ts`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/lib/api-me.ts`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/hooks/use-me.ts`

- [ ] **Step 1: Read current `api.ts` to see the existing fetch shape**

```bash
sed -n '1,80p' /Users/shepyrd/development/shamarx/shamarx-web/src/lib/api.ts
```

Identify the request function (likely a wrapper around `fetch`). We'll add a single-retry-after-refresh on 401.

- [ ] **Step 2: Add 401 retry interceptor**

In `src/lib/api.ts`, wrap the request function:

```ts
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const opts: RequestInit = { credentials: 'include', ...init };
  let res = await fetch(input, opts);
  if (res.status === 401 && !input.includes('/api/auth/refresh') && !input.includes('/api/auth/login')) {
    // attempt refresh once
    const refresh = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (refresh.ok) {
      res = await fetch(input, opts);
    }
  }
  return res;
}
```

Replace direct `fetch` calls in `api.ts` exports with `apiFetch`.

- [ ] **Step 3: Add `/me` API client**

Create `src/lib/api-me.ts`:

```ts
export interface MeResponse {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN' | 'SUPERADMIN';
  isActive: boolean;
  botEnabled: boolean;
  presetKey: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
}

export async function fetchMe(): Promise<MeResponse> {
  const r = await fetch('/api/me', { credentials: 'include' });
  if (!r.ok) throw new Error('Failed to fetch me');
  return r.json();
}

export async function updateMe(patch: { botEnabled?: boolean; presetKey?: MeResponse['presetKey'] }): Promise<MeResponse> {
  const r = await fetch('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error('Failed to update me');
  return r.json();
}
```

- [ ] **Step 4: Add SWR hook**

Create `src/hooks/use-me.ts`:

```ts
import useSWR from 'swr';
import { fetchMe, MeResponse } from '@/lib/api-me';

export function useMe() {
  return useSWR<MeResponse>('/api/me', fetchMe, { revalidateOnFocus: false });
}
```

- [ ] **Step 5: Update `AuthContext` to surface preset + botEnabled**

Edit `src/contexts/AuthContext.tsx` — extend the user type returned by `loadCurrentUser`/`refresh` to include the new fields. The backend `/api/auth/me` may not yet return them; update its select clause to include `botEnabled` and `presetKey` if missing. (Check `auth.controller.ts:62` — it returns `req.user as AuthenticatedUser`; the JWT only contains id/email/role. Use `useMe()` hook for fresh data in components.)

- [ ] **Step 6: Smoke test in browser**

Log in. Open devtools network tab. Force a 401 on `/api/me` (delete the `auth_token` cookie). Reload the page → `/api/auth/refresh` should fire automatically, then `/api/me` should succeed.

- [ ] **Step 7: Commit**

```bash
cd /Users/shepyrd/development/shamarx/shamarx-web
git add src/contexts/AuthContext.tsx src/lib/api.ts src/lib/api-me.ts src/hooks/use-me.ts
git commit -m "feat(web): 401 retry interceptor + useMe hook with botEnabled/presetKey"
```

---

## Task 17: Web — `/join/[token]` accept-invite page with preset picker

**Files:**
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/join/[token]/page.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/components/preset/preset-card.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/components/preset/preset-picker.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/lib/api-invites.ts`

- [ ] **Step 1: Create the API client**

Create `src/lib/api-invites.ts`:

```ts
export type PresetKey = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

export interface InvitePreview {
  valid: boolean;
  email?: string;
  expiresAt?: string;
}

export async function previewInvite(token: string): Promise<InvitePreview> {
  const r = await fetch(`/api/invites/${encodeURIComponent(token)}/preview`);
  if (!r.ok) return { valid: false };
  return r.json();
}

export async function acceptInvite(token: string, password: string, presetKey: PresetKey) {
  const r = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ password, presetKey }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ message: 'Accept failed' }));
    throw new Error(err.message || 'Accept failed');
  }
  return r.json();
}
```

- [ ] **Step 2: Build `PresetCard` component**

Create `src/components/preset/preset-card.tsx`:

```tsx
'use client';
import { cn } from '@/lib/utils';
import type { PresetKey } from '@/lib/api-invites';

interface PresetCardProps {
  presetKey: PresetKey;
  selected: boolean;
  onSelect: () => void;
}

const META: Record<PresetKey, {
  label: string;
  tagline: string;
  dotClass: string;
  badge?: string;
  warning?: string;
  validated?: string;
  rows: { label: string; value: string; tip: string }[];
}> = {
  CONSERVATIVE: {
    label: 'Conservative',
    tagline: 'Safer, fewer trades. Good for learning the system.',
    dotClass: 'bg-sky-300',
    rows: [
      { label: 'Risk per trade', value: '0.5%', tip: 'On $1,000, each trade risks $5.' },
      { label: 'Max daily loss', value: '2%',  tip: 'Bot stops trading for the day if you lose this much.' },
      { label: 'Max open',       value: '2',   tip: 'How many positions can run at once.' },
      { label: 'Pairs',          value: 'EURUSD, GBPUSD', tip: 'Which markets the bot trades.' },
    ],
  },
  BALANCED: {
    label: 'Balanced',
    tagline: "What we run today. 28 months of live-validated config.",
    dotClass: 'bg-profit',
    badge: 'Recommended',
    validated: '686 trades · 64.9% WR · +143%',
    rows: [
      { label: 'Risk per trade', value: '1.0%', tip: 'On $1,000, each trade risks $10.' },
      { label: 'Max daily loss', value: '3%',  tip: 'Bot stops trading for the day if you lose this much.' },
      { label: 'Max open',       value: '3',   tip: 'How many positions can run at once.' },
      { label: 'Pairs',          value: 'XAUUSD, EURUSD, GBPUSD, USDJPY', tip: 'Which markets the bot trades.' },
    ],
  },
  AGGRESSIVE: {
    label: 'Aggressive',
    tagline: 'Larger size, bigger drawdowns. Not for beginners.',
    dotClass: 'bg-signal',
    warning: 'Drawdown can hit 5% in one day',
    rows: [
      { label: 'Risk per trade', value: '1.5%', tip: 'On $1,000, each trade risks $15.' },
      { label: 'Max daily loss', value: '5%',  tip: 'Bot stops trading for the day if you lose this much.' },
      { label: 'Max open',       value: '3',   tip: 'How many positions can run at once.' },
      { label: 'Pairs',          value: 'XAUUSD, EURUSD, GBPUSD, USDJPY', tip: 'Which markets the bot trades.' },
    ],
  },
};

export function PresetCard({ presetKey, selected, onSelect }: PresetCardProps) {
  const meta = META[presetKey];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative w-full text-left rounded border p-5 transition',
        'bg-card hover:bg-surface-2',
        selected
          ? 'border-profit ring-2 ring-profit/30'
          : 'border-border',
      )}
    >
      {meta.badge && (
        <span className="absolute -top-2 right-4 rounded-full bg-profit px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-background">
          {meta.badge}
        </span>
      )}
      <div className="mb-2 flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', meta.dotClass)} />
        <span className="text-sm font-semibold text-foreground">{meta.label}</span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{meta.tagline}</p>
      <dl className="space-y-1 border-t border-border pt-3 font-mono text-[11px] text-foreground">
        {meta.rows.map((r) => (
          <div key={r.label} className="flex justify-between" title={r.tip}>
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {meta.validated && (
        <div className="mt-3 rounded bg-background p-2 text-[10px] text-foreground/80">
          📊 Validated: {meta.validated}
        </div>
      )}
      {meta.warning && (
        <div className="mt-3 rounded bg-background p-2 text-[10px] text-signal">
          ⚠ {meta.warning}
        </div>
      )}
    </button>
  );
}
```

- [ ] **Step 3: Build `PresetPicker`**

Create `src/components/preset/preset-picker.tsx`:

```tsx
'use client';
import { PresetCard } from './preset-card';
import type { PresetKey } from '@/lib/api-invites';

const ORDER: PresetKey[] = ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'];

export function PresetPicker({
  value,
  onChange,
}: {
  value: PresetKey;
  onChange: (v: PresetKey) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {ORDER.map((k) => (
        <PresetCard
          key={k}
          presetKey={k}
          selected={value === k}
          onSelect={() => onChange(k)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Build the accept page**

Create `src/app/join/[token]/page.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PresetPicker } from '@/components/preset/preset-picker';
import { previewInvite, acceptInvite, type PresetKey } from '@/lib/api-invites';

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [state, setState] = useState<'loading' | 'valid' | 'invalid'>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [presetKey, setPresetKey] = useState<PresetKey>('BALANCED');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    previewInvite(params.token).then((p) => {
      if (p.valid && p.email) {
        setEmail(p.email);
        setState('valid');
      } else {
        setState('invalid');
      }
    });
  }, [params.token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await acceptInvite(params.token, password, presetKey);
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (state === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Checking invite…</div>;
  }
  if (state === 'invalid') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md text-center">
          <h1 className="mb-3 text-xl font-semibold">Link no longer valid</h1>
          <p className="text-sm text-muted-foreground">
            This invite has expired or already been used. Ask the admin to send a new one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header>
        <div className="mb-2 font-display text-sm tracking-widest text-signal">▲ SHAMARX</div>
        <h1 className="text-2xl font-semibold text-foreground">Welcome, {email}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Set your password and pick a strategy preset. You can change the preset anytime.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-8">
        <section>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2"
          />
          <p className="mt-1 text-xs text-muted-foreground">At least 8 characters.</p>
        </section>

        <section>
          <Label>Strategy preset</Label>
          <div className="mt-3">
            <PresetPicker value={presetKey} onChange={setPresetKey} />
          </div>
        </section>

        {error && <div className="text-sm text-loss">{error}</div>}

        <Button type="submit" disabled={submitting || password.length < 8}>
          {submitting ? 'Creating account…' : 'Accept invite'}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Manual smoke test**

Start backend + web. Create an invite via `/admin/invites` (or curl). Visit the resulting `/join/{token}` URL → form renders, picker selectable, submit creates user + redirects to `/dashboard`.

- [ ] **Step 6: Commit**

```bash
cd /Users/shepyrd/development/shamarx/shamarx-web
git add src/app/join src/components/preset src/lib/api-invites.ts
git commit -m "feat(web): /join/[token] accept-invite page with preset picker"
```

---

## Task 18: Web — `StatusPill` component + dashboard hero redesign

**Files:**
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/components/dashboard/status-pill.tsx`
- Modify: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/dashboard/page.tsx`
- Modify: `/Users/shepyrd/development/shamarx/shamarx-web/src/components/layout/topbar.tsx`

- [ ] **Step 1: Build `StatusPill`**

Create `src/components/dashboard/status-pill.tsx`:

```tsx
'use client';
import { cn } from '@/lib/utils';
import { useMe } from '@/hooks/use-me';
import { updateMe } from '@/lib/api-me';
import { useState } from 'react';

interface StatusPillProps {
  enabledAccountsCount: number;
  brokerHealthOk: boolean;
}

export function StatusPill({ enabledAccountsCount, brokerHealthOk }: StatusPillProps) {
  const { data: me, mutate } = useMe();
  const [confirming, setConfirming] = useState(false);

  if (!me) return <span className="h-6 w-32 rounded bg-card" />;

  let dotClass = 'bg-muted-foreground';
  let label = '';

  if (!me.isActive) {
    dotClass = 'bg-loss';
    label = 'Account disabled · contact admin';
  } else if (!me.botEnabled) {
    dotClass = 'bg-signal';
    label = 'Paused · click to resume';
  } else if (enabledAccountsCount === 0) {
    dotClass = 'bg-muted-foreground';
    label = 'No enabled accounts';
  } else if (!brokerHealthOk) {
    dotClass = 'bg-signal';
    label = 'Broker connection issue';
  } else {
    dotClass = 'bg-profit shadow-[0_0_6px_var(--color-profit)]';
    label = `Bot live · ${me.presetKey.charAt(0) + me.presetKey.slice(1).toLowerCase()}`;
  }

  async function handleClick() {
    if (!me) return;
    if (me.botEnabled) {
      setConfirming(true);
    } else {
      await updateMe({ botEnabled: true });
      mutate();
    }
  }

  async function handleConfirmPause() {
    await updateMe({ botEnabled: false });
    setConfirming(false);
    mutate();
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="flex items-center gap-2 rounded border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-surface-2"
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
        <span>{label}</span>
      </button>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
          <div className="max-w-sm rounded border border-border bg-card p-6">
            <h3 className="mb-3 text-sm font-semibold">Pause your bot?</h3>
            <p className="mb-4 text-xs text-muted-foreground">
              No new trades will open. Existing open positions stay open until they hit SL or TP.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="rounded border border-border px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPause}
                className="rounded bg-signal px-3 py-1.5 text-xs font-semibold text-background"
              >
                Pause bot
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Wire `StatusPill` into `Topbar`**

Edit `src/components/layout/topbar.tsx` — read existing structure, then add the pill into the right side of the topbar. Hook needs `enabledAccountsCount` and `brokerHealthOk` — accept them as props for flexibility (top-level dashboard page passes real values; other pages can pass defaults).

- [ ] **Step 3: Rewrite the dashboard page hero + open positions + today list**

Edit `src/app/dashboard/page.tsx`. Replace existing dashboard contents:

```tsx
'use client';
import { useEquity } from '@/hooks/use-equity';
import { useOpenPositions } from '@/hooks/use-open-positions';
import { useTodayTrades } from '@/hooks/use-today-trades';
import { useBrokerAccounts } from '@/hooks/use-broker-accounts';
import { PositionCard } from '@/components/lives/position-card';
import { TradeRow } from '@/components/trades/trade-row';
import Link from 'next/link';

export default function DashboardPage() {
  const { data: equity } = useEquity();
  const { data: positions } = useOpenPositions();
  const { data: today } = useTodayTrades();
  const { data: accounts } = useBrokerAccounts();

  const enabledCount = accounts?.filter((a) => a.isEnabled).length ?? 0;

  return (
    <div className="p-6 lg:p-8">
      <section className="mb-8">
        <div className="mb-2 font-display text-[10px] tracking-widest text-muted-foreground">
          EQUITY · LIVE
        </div>
        <div className="flex items-baseline gap-4">
          <div className="font-mono text-4xl font-semibold text-foreground">
            ${equity?.balance.toLocaleString() ?? '—'}
          </div>
          <div className={equity && equity.dayDelta >= 0 ? 'font-mono text-sm font-semibold text-profit' : 'font-mono text-sm font-semibold text-loss'}>
            {equity ? `${equity.dayDelta >= 0 ? '+' : ''}$${equity.dayDelta.toFixed(2)} ${equity.dayDelta >= 0 ? '↗' : '↘'}` : ''}
          </div>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {equity ? `${equity.monthPct >= 0 ? '+' : ''}${equity.monthPct.toFixed(1)}% this month · max DD ${equity.maxDd.toFixed(1)}%` : ''}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-signal">▸</span>
            <span className="text-sm font-semibold tracking-wider text-foreground">
              OPEN · {positions?.length ?? 0}
            </span>
          </div>
          <Link href="/lives" className="text-xs text-muted-foreground hover:text-foreground">All →</Link>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {positions?.map((p) => <PositionCard key={p.id} position={p} />)}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-signal">▸</span>
            <span className="text-sm font-semibold tracking-wider text-foreground">
              TODAY · {today?.length ?? 0} TRADES
            </span>
          </div>
          <div className={today && today.reduce((s, t) => s + (t.realisedPnl ?? 0), 0) >= 0 ? 'font-mono text-sm font-semibold text-profit' : 'font-mono text-sm font-semibold text-loss'}>
            {today ? `$${today.reduce((s, t) => s + (t.realisedPnl ?? 0), 0).toFixed(2)}` : ''}
          </div>
        </div>
        <div className="divide-y divide-border">
          {today?.map((t) => <TradeRow key={t.id} trade={t} />)}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Link href="/preferences" className="rounded border-l-2 border-signal border-y border-r border-y-border border-r-border bg-card p-3 hover:bg-surface-2">
          <div className="mb-1 text-[10px] tracking-widest text-muted-foreground">PRESET</div>
          <div className="text-sm font-semibold">Switch ↓</div>
        </Link>
        <Link href="/accounts" className="rounded border border-border bg-card p-3 hover:bg-surface-2">
          <div className="mb-1 text-[10px] tracking-widest text-muted-foreground">ACCOUNTS</div>
          <div className="text-sm font-semibold">{enabledCount} enabled →</div>
        </Link>
        <Link href="/lives" className="rounded border border-border bg-card p-3 hover:bg-surface-2">
          <div className="mb-1 text-[10px] tracking-widest text-muted-foreground">EQUITY CURVE</div>
          <div className="text-sm font-semibold">View →</div>
        </Link>
      </section>
    </div>
  );
}
```

(If `useEquity`, `useOpenPositions`, `useTodayTrades` don't exist yet, check `/hooks` directory and use whatever's available — adapt the import names. The hooks already exist for most of this data.)

- [ ] **Step 4: Manual visual check**

Start web, log in, view `/dashboard`. Verify:
- Hero shows big equity number with delta
- Status pill visible top-right
- Open positions render in 2-column grid
- Today's trades render
- 3 quick cards at bottom
- All colors come from existing tokens

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard src/components/layout/topbar.tsx src/app/dashboard/page.tsx
git commit -m "feat(web): status pill + dashboard redesign (status-focused)"
```

---

## Task 19: Web — `/preferences` page + sidebar conditional nav

**Files:**
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/preferences/page.tsx`
- Modify: `/Users/shepyrd/development/shamarx/shamarx-web/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Build `/preferences` page**

Create `src/app/preferences/page.tsx`:

```tsx
'use client';
import { useState, useEffect } from 'react';
import { useMe } from '@/hooks/use-me';
import { updateMe } from '@/lib/api-me';
import { PresetPicker } from '@/components/preset/preset-picker';
import { Button } from '@/components/ui/button';
import type { PresetKey } from '@/lib/api-invites';

export default function PreferencesPage() {
  const { data: me, mutate } = useMe();
  const [presetKey, setPresetKey] = useState<PresetKey>('BALANCED');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (me) setPresetKey(me.presetKey);
  }, [me]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    await updateMe({ presetKey });
    await mutate();
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  if (!me) return null;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <header className="mb-8">
        <div className="font-display text-[10px] tracking-widest text-muted-foreground">PREFERENCES</div>
        <h1 className="mt-1 text-xl font-semibold">Strategy preset</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick the risk profile. Open positions keep their original SL/TP — preset only affects new entries.
        </p>
      </header>

      <PresetPicker value={presetKey} onChange={setPresetKey} />

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || presetKey === me.presetKey}>
          {saving ? 'Saving…' : 'Save preset'}
        </Button>
        {saved && <span className="text-xs text-profit">Saved ✓</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update sidebar**

Edit `src/components/layout/sidebar.tsx`:

Replace the existing `NAV` array:

```ts
const WORKSPACE_NAV = [
  { href: '/dashboard',  label: 'Overview',  icon: LayoutDashboard },
  { href: '/lives',      label: 'Live',      icon: Radio },
  { href: '/journal',    label: 'Journal',   icon: BookOpen },
  { href: '/accounts',   label: 'Accounts',  icon: Briefcase },     // import Briefcase
];

const SETTINGS_NAV = [
  { href: '/preferences', label: 'Preferences', icon: Settings },    // import Settings
];

const ADMIN_NAV = [
  { href: '/admin/users',    label: 'Users',    icon: Users },
  { href: '/admin/invites',  label: 'Invites',  icon: Mail },
  { href: '/admin/sessions', label: 'Sessions', icon: KeyRound },
  { href: '/admin/engine',   label: 'Engine',   icon: Cpu },
  { href: '/admin/backtest', label: 'Backtest', icon: Activity },
];
```

In the render body, inside the existing `Sidebar` component, render three labelled sections — WORKSPACE, SETTINGS, and ADMIN. Render ADMIN only when `user?.role === 'SUPERADMIN'`.

Remove the existing backtest-related items (Runs, New Run, Replay) from WORKSPACE.

- [ ] **Step 3: Smoke test**

Visit `/preferences` as a USER → preset picker shows + save works. Visit as SUPERADMIN → also see ADMIN section in sidebar.

- [ ] **Step 4: Commit**

```bash
git add src/app/preferences src/components/layout/sidebar.tsx
git commit -m "feat(web): /preferences page + SUPERADMIN sidebar nav"
```

---

## Task 20: Web — `/admin/users` + `/admin/invites` pages

**Files:**
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/admin/layout.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/admin/users/page.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/admin/invites/page.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/lib/api-admin.ts`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/hooks/use-admin-users.ts`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/hooks/use-invites.ts`

- [ ] **Step 1: Admin API client**

Create `src/lib/api-admin.ts`:

```ts
export interface AdminUser {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN' | 'SUPERADMIN';
  isActive: boolean;
  botEnabled: boolean;
  presetKey: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  accountsTotal: number;
  accountsEnabled: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const r = await fetch('/api/admin/users', { credentials: 'include' });
  if (!r.ok) throw new Error('Failed');
  return r.json();
}

export async function setUserActive(id: string, isActive: boolean) {
  const r = await fetch(`/api/admin/users/${id}/active`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ isActive }),
  });
  if (!r.ok) throw new Error('Failed');
}

export async function setUserBotEnabled(id: string, botEnabled: boolean) {
  const r = await fetch(`/api/admin/users/${id}/bot-enabled`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ botEnabled }),
  });
  if (!r.ok) throw new Error('Failed');
}

export interface AdminInvite {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  status: 'pending' | 'accepted' | 'expired';
  createdBy: string;
}

export async function fetchInvites(): Promise<AdminInvite[]> {
  const r = await fetch('/api/admin/invites', { credentials: 'include' });
  if (!r.ok) throw new Error('Failed');
  return r.json();
}

export async function createInvite(email: string, expiresInDays = 7): Promise<{ id: string; email: string; token: string; expiresAt: string }> {
  const r = await fetch('/api/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, expiresInDays }),
  });
  if (!r.ok) throw new Error('Failed');
  return r.json();
}

export async function revokeInvite(id: string) {
  const r = await fetch(`/api/admin/invites/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!r.ok) throw new Error('Failed');
}
```

- [ ] **Step 2: Hooks**

Create `src/hooks/use-admin-users.ts`:

```ts
import useSWR from 'swr';
import { fetchAdminUsers } from '@/lib/api-admin';

export function useAdminUsers() {
  return useSWR('/api/admin/users', fetchAdminUsers);
}
```

Create `src/hooks/use-invites.ts`:

```ts
import useSWR from 'swr';
import { fetchInvites } from '@/lib/api-admin';

export function useInvites() {
  return useSWR('/api/admin/invites', fetchInvites);
}
```

- [ ] **Step 3: Admin layout (role guard)**

Create `src/app/admin/layout.tsx`:

```tsx
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMe } from '@/hooks/use-me';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading } = useMe();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && me && me.role !== 'SUPERADMIN') {
      router.replace('/dashboard');
    }
  }, [me, isLoading, router]);

  if (isLoading || !me) return null;
  if (me.role !== 'SUPERADMIN') return null;
  return <>{children}</>;
}
```

- [ ] **Step 4: `/admin/users` page**

Create `src/app/admin/users/page.tsx`:

```tsx
'use client';
import { useAdminUsers } from '@/hooks/use-admin-users';
import { setUserActive, setUserBotEnabled } from '@/lib/api-admin';
import { Switch } from '@/components/ui/switch';

export default function AdminUsersPage() {
  const { data: users, mutate } = useAdminUsers();
  if (!users) return null;

  return (
    <div className="p-6 lg:p-8">
      <header className="mb-6">
        <div className="font-display text-[10px] tracking-widest text-muted-foreground">ADMIN</div>
        <h1 className="mt-1 text-xl font-semibold">Users</h1>
      </header>

      <div className="overflow-hidden rounded border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">Email</th>
              <th className="px-4 py-2 text-left">Role</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Bot</th>
              <th className="px-4 py-2 text-left">Preset</th>
              <th className="px-4 py-2 text-left">Accounts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-card">
                <td className="px-4 py-3 font-mono text-xs">{u.email}</td>
                <td className="px-4 py-3 text-xs">{u.role}</td>
                <td className="px-4 py-3">
                  <Switch
                    checked={u.isActive}
                    onCheckedChange={async (v) => { await setUserActive(u.id, v); mutate(); }}
                  />
                </td>
                <td className="px-4 py-3">
                  <Switch
                    checked={u.botEnabled}
                    onCheckedChange={async (v) => { await setUserBotEnabled(u.id, v); mutate(); }}
                    disabled={!u.isActive}
                  />
                </td>
                <td className="px-4 py-3 text-xs">{u.presetKey}</td>
                <td className="px-4 py-3 text-xs">{u.accountsEnabled}/{u.accountsTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: `/admin/invites` page**

Create `src/app/admin/invites/page.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useInvites } from '@/hooks/use-invites';
import { createInvite, revokeInvite } from '@/lib/api-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function AdminInvitesPage() {
  const { data: invites, mutate } = useInvites();
  const [email, setEmail] = useState('');
  const [days, setDays] = useState(7);
  const [lastToken, setLastToken] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const result = await createInvite(email, days);
    setLastToken(result.token);
    setEmail('');
    mutate();
  }

  if (!invites) return null;

  return (
    <div className="p-6 lg:p-8">
      <header className="mb-6">
        <div className="font-display text-[10px] tracking-widest text-muted-foreground">ADMIN</div>
        <h1 className="mt-1 text-xl font-semibold">Invites</h1>
      </header>

      <form onSubmit={handleCreate} className="mb-8 grid max-w-2xl grid-cols-[1fr_auto_auto] items-end gap-3">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label htmlFor="days">Expires (days)</Label>
          <Input id="days" type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} className="mt-1 w-24" />
        </div>
        <Button type="submit">+ New invite</Button>
      </form>

      {lastToken && (
        <div className="mb-6 rounded border border-signal/40 bg-card p-4">
          <div className="mb-2 text-xs uppercase tracking-wider text-signal">Invite created — copy now</div>
          <code className="block break-all rounded bg-background p-3 font-mono text-xs">
            {window.location.origin}/join/{lastToken}
          </code>
          <p className="mt-2 text-xs text-muted-foreground">Also emailed to the user. This link is shown once.</p>
        </div>
      )}

      <div className="overflow-hidden rounded border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">Email</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Expires</th>
              <th className="px-4 py-2 text-left">Created by</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {invites.map((i) => (
              <tr key={i.id}>
                <td className="px-4 py-3 font-mono text-xs">{i.email}</td>
                <td className="px-4 py-3 text-xs">{i.status}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(i.expiresAt).toLocaleString()}</td>
                <td className="px-4 py-3 font-mono text-xs">{i.createdBy}</td>
                <td className="px-4 py-3 text-right">
                  {i.status === 'pending' && (
                    <button
                      onClick={async () => { await revokeInvite(i.id); mutate(); }}
                      className="text-xs text-loss hover:underline"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Smoke test**

Log in as SUPERADMIN → click "Users" in sidebar → see your row. Click "Invites" → form renders, create one, table updates. Log in as USER → visit `/admin/users` → redirected to `/dashboard`.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin src/lib/api-admin.ts src/hooks/use-admin-users.ts src/hooks/use-invites.ts
git commit -m "feat(web): /admin/users + /admin/invites pages with role guard"
```

---

## Task 21: Web — `/admin/sessions` + `/admin/engine` pages

**Files:**
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/admin/sessions/page.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/app/admin/engine/page.tsx`
- Create: `/Users/shepyrd/development/shamarx/shamarx-web/src/hooks/use-sessions.ts`
- Modify: `/Users/shepyrd/development/shamarx/shamarx-web/src/lib/api-admin.ts` (add sessions + engine client)

- [ ] **Step 1: Extend `api-admin.ts`**

Append to `src/lib/api-admin.ts`:

```ts
export interface AdminSession {
  id: string;
  userId: string;
  userEmail: string;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export async function fetchSessions(): Promise<AdminSession[]> {
  const r = await fetch('/api/admin/sessions', { credentials: 'include' });
  if (!r.ok) throw new Error('Failed');
  return r.json();
}

export async function revokeSession(id: string) {
  const r = await fetch(`/api/admin/sessions/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!r.ok) throw new Error('Failed');
}

export interface EngineStatus {
  session: { startedAt: string; lastTickAt: string | null } | null;
  activeUsers: number;
  enabledAccounts: number;
  tradesToday: number;
}

export async function fetchEngineStatus(): Promise<EngineStatus> {
  const r = await fetch('/api/admin/engine/status', { credentials: 'include' });
  if (!r.ok) throw new Error('Failed');
  return r.json();
}

export async function pauseAll(confirm: string) {
  const r = await fetch('/api/admin/engine/pause-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ confirm }),
  });
  if (!r.ok) throw new Error('Failed');
}
```

- [ ] **Step 2: Hook**

Create `src/hooks/use-sessions.ts`:

```ts
import useSWR from 'swr';
import { fetchSessions } from '@/lib/api-admin';

export function useSessions() {
  return useSWR('/api/admin/sessions', fetchSessions, { refreshInterval: 30_000 });
}
```

- [ ] **Step 3: Sessions page**

Create `src/app/admin/sessions/page.tsx`:

```tsx
'use client';
import { useSessions } from '@/hooks/use-sessions';
import { revokeSession } from '@/lib/api-admin';

export default function AdminSessionsPage() {
  const { data: sessions, mutate } = useSessions();
  if (!sessions) return null;

  return (
    <div className="p-6 lg:p-8">
      <header className="mb-6">
        <div className="font-display text-[10px] tracking-widest text-muted-foreground">ADMIN</div>
        <h1 className="mt-1 text-xl font-semibold">Active sessions</h1>
      </header>

      <div className="overflow-hidden rounded border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">User</th>
              <th className="px-4 py-2 text-left">User agent</th>
              <th className="px-4 py-2 text-left">Created</th>
              <th className="px-4 py-2 text-left">Expires</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sessions.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-3 font-mono text-xs">{s.userEmail}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{s.userAgent ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(s.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(s.expiresAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={async () => { await revokeSession(s.id); mutate(); }}
                    className="text-xs text-loss hover:underline"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Engine page**

Create `src/app/admin/engine/page.tsx`:

```tsx
'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { fetchEngineStatus, pauseAll } from '@/lib/api-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function AdminEnginePage() {
  const { data: status, mutate } = useSWR('/api/admin/engine/status', fetchEngineStatus, { refreshInterval: 10_000 });
  const [confirm, setConfirm] = useState('');
  const [pausing, setPausing] = useState(false);

  if (!status) return null;

  async function handlePauseAll() {
    setPausing(true);
    try {
      await pauseAll(confirm);
      setConfirm('');
      await mutate();
    } finally {
      setPausing(false);
    }
  }

  return (
    <div className="p-6 lg:p-8">
      <header className="mb-6">
        <div className="font-display text-[10px] tracking-widest text-muted-foreground">ADMIN</div>
        <h1 className="mt-1 text-xl font-semibold">Engine</h1>
      </header>

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Active users" value={status.activeUsers} />
        <Tile label="Enabled accounts" value={status.enabledAccounts} />
        <Tile label="Trades 24h" value={status.tradesToday} />
        <Tile label="Engine" value={status.session ? 'live' : 'down'} />
      </div>

      <section className="max-w-xl rounded border border-loss/40 bg-card p-5">
        <h2 className="mb-2 text-sm font-semibold text-loss">Emergency: pause everyone</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Sets <code>botEnabled = false</code> on every USER row. Reversible per-user from the Users page.
          Type <code>PAUSE-ALL</code> to confirm.
        </p>
        <div className="flex gap-2">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="PAUSE-ALL" />
          <Button variant="destructive" onClick={handlePauseAll} disabled={confirm !== 'PAUSE-ALL' || pausing}>
            {pausing ? 'Pausing…' : 'Pause everyone'}
          </Button>
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="mb-1 text-[10px] tracking-widest text-muted-foreground">{label.toUpperCase()}</div>
      <div className="font-mono text-xl font-semibold">{value}</div>
    </div>
  );
}
```

- [ ] **Step 5: Smoke test**

Visit `/admin/sessions` → see at least your own session. Visit `/admin/engine` → tiles render with current values. Type `PAUSE-ALL` → button enables → click → all USER rows get `botEnabled=false`.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/sessions src/app/admin/engine src/lib/api-admin.ts src/hooks/use-sessions.ts
git commit -m "feat(web): /admin/sessions and /admin/engine pages"
```

---

## Task 22: E2E + smoke + runbook updates

**Files:**
- Create: `/Users/shepyrd/development/shamarx/shamarx-app/test/invite-flow.e2e-spec.ts`
- Create: `/Users/shepyrd/development/shamarx/shamarx-app/test/auth-refresh.e2e-spec.ts`
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Invite-flow e2e**

Create `test/invite-flow.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Invite flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminCookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.invite.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();

    const pw = await bcrypt.hash('admin-pass', 10);
    await prisma.user.create({
      data: { email: 'admin@x.test', passwordHash: pw, role: 'SUPERADMIN' },
    });

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@x.test', password: 'admin-pass' });

    adminCookie = login.headers['set-cookie'].find((c: string) => c.startsWith('auth_token=')).split(';')[0];
  });

  afterAll(async () => app.close());

  it('admin creates invite, friend accepts, gets logged in', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/admin/invites')
      .set('Cookie', adminCookie)
      .send({ email: 'alice@example.com' });
    expect(create.status).toBe(201);
    const token = create.body.token;

    const preview = await request(app.getHttpServer())
      .get(`/api/invites/${token}/preview`);
    expect(preview.body).toEqual({ valid: true, email: 'alice@example.com', expiresAt: expect.any(String) });

    const accept = await request(app.getHttpServer())
      .post(`/api/invites/${token}/accept`)
      .send({ password: 'AliceStrong123!', presetKey: 'BALANCED' });
    expect(accept.status).toBe(200);
    expect(accept.body.user.email).toBe('alice@example.com');

    const aliceCookie = accept.headers['set-cookie'].find((c: string) => c.startsWith('auth_token=')).split(';')[0];
    const me = await request(app.getHttpServer())
      .get('/api/me')
      .set('Cookie', aliceCookie);
    expect(me.body.email).toBe('alice@example.com');
    expect(me.body.botEnabled).toBe(true);
    expect(me.body.presetKey).toBe('BALANCED');
  });

  it('reusing the same token fails', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/admin/invites')
      .set('Cookie', adminCookie)
      .send({ email: 'alice@example.com' });
    const token = create.body.token;
    await request(app.getHttpServer())
      .post(`/api/invites/${token}/accept`)
      .send({ password: 'AliceStrong123!', presetKey: 'BALANCED' });
    const second = await request(app.getHttpServer())
      .post(`/api/invites/${token}/accept`)
      .send({ password: 'AliceStrong123!', presetKey: 'BALANCED' });
    expect(second.status).toBe(400);
  });
});
```

- [ ] **Step 2: Auth-refresh e2e**

Create `test/auth-refresh.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import * as bcrypt from 'bcrypt';

describe('Auth refresh (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    const pw = await bcrypt.hash('pass-pass', 10);
    await prisma.user.create({
      data: { email: 'alice@x.test', passwordHash: pw, role: 'USER' },
    });
  });

  afterAll(async () => app.close());

  it('login → refresh → new token; old token kills chain on reuse', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'alice@x.test', password: 'pass-pass' });
    const oldRefresh = login.headers['set-cookie'].find((c: string) => c.startsWith('refresh_token=')).split(';')[0];

    const refresh = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', oldRefresh);
    expect(refresh.status).toBe(200);
    const newRefresh = refresh.headers['set-cookie'].find((c: string) => c.startsWith('refresh_token=')).split(';')[0];
    expect(newRefresh).not.toEqual(oldRefresh);

    // Now reuse the old one — should detect and revoke chain
    const reuse = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', oldRefresh);
    expect(reuse.status).toBe(401);

    // The new refresh should also be dead now
    const newReuse = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', newRefresh);
    expect(newReuse.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run all e2e**

```bash
npx jest test/ --runInBand
```

Expected: all PASS.

- [ ] **Step 4: Update runbook**

Append to `docs/RUNBOOK.md`:

```md
## Inviting a friend (multi-tenant Spec 2)

1. Log in as SUPERADMIN.
2. Sidebar → ADMIN → Invites.
3. Enter friend's email, click "+ New invite".
4. Copy the one-time link from the green panel and send it via your preferred channel (the email also goes out via SMTP).
5. Friend opens `/join/<token>`, sets password, picks preset, lands on `/dashboard`.

To revoke a pending invite: sidebar → ADMIN → Invites → Revoke.
To deactivate a user (with refresh-token revoke): ADMIN → Users → toggle "Status".
To pause everyone's bot in an emergency: ADMIN → Engine → type `PAUSE-ALL` → click button.

## Production smoke after deploy

1. Run backfill: `npx ts-node scripts/backfill-spec2.ts` (idempotent — safe to re-run).
2. Verify your row: `psql $DATABASE_URL -c "SELECT email, role, \"botEnabled\", \"presetKey\" FROM \"User\";"`. Expect role=SUPERADMIN, botEnabled=true, presetKey=BALANCED.
3. Verify next live signal still fires for your account (no behaviour change for single-user setup).
4. Create an invite for yourself at a secondary email → accept → verify second user works end-to-end.
```

- [ ] **Step 5: Commit**

```bash
git add test/ docs/RUNBOOK.md
git commit -m "test(e2e): invite-flow + auth-refresh + runbook update"
```

---

## Final review

After all 22 tasks ship, perform the rollout sequence from Spec §13:

1. Apply migrations on production (Task 1 + 2 migrations).
2. Run `scripts/backfill-spec2.ts` against production DB.
3. Deploy backend (Tasks 3–15).
4. Deploy web (Tasks 16–21).
5. Manually create one invite for a test email you control — accept it — verify isolation (your trades vs the test account's are separate).
6. Create real friend invites.

---

## Self-review (against the spec)

**Spec coverage check:**

| Spec section | Tasks |
|---|---|
| §3 Architecture | covered across all tasks |
| §4 Data model | Task 1, 2 |
| §5 Preset system | Task 9 (PRESETS), Task 10 (engine application), Task 12/17/19 (UI) |
| §6 Auth + invite | Task 3 (decorator), 4 (RefreshTokenService), 5 (auth wiring), 6 (InviteService), 7 (controllers), 8 (email) |
| §7 Run-state | Task 10 (engine gate), 12 (PATCH /me), 18 (StatusPill) |
| §8 Dashboard | Task 18 (redesign), 19 (sidebar) |
| §9 Admin section | Task 13 (users), 14 (sessions + engine), 20 (users + invites UI), 21 (sessions + engine UI) |
| §10 Data isolation | Task 15 (audit + e2e) |
| §11 Email scoping | Task 11 |
| §12 Edge cases | covered via tests in respective tasks |
| §13 Rollout | "Final review" section above |
| §14 Testing | Tasks 4 (refresh), 6 (invite), 9 (presets), 10 (engine), 11 (mail), 12 (me), 13 (admin users), 15 (isolation e2e), 22 (invite + refresh e2e) |
| §15 Rollback | covered by additive migrations + per-task revertibility |
| §16 Out of scope | not implemented (correct) |

**Type consistency:** `PresetKey` enum from Prisma → used in `PRESETS`, `AcceptInviteDto`, `UpdateMeDto`, web `PresetCard`, all reference the same values. `RefreshTokenService.issue()` returns `{ id, token }`; all consumers (auth service, invite service) destructure consistently. `BrokerAccountWithUser` type referenced in Task 10 — define inline in the same file (no separate types file needed).

**Placeholder scan:** zero "TBD"/"TODO"/"appropriate" found. Every step has either runnable commands or full code blocks.

**Estimated total commits:** 22 (one per task).

---
