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

    // Refuse to invite emails that already have an account. The accept path
    // (line 60-61) already throws ConflictException for this case, but failing
    // at create time saves the admin from sending a doomed email and avoids
    // surprising the recipient with an error after they type a password.
    const existingUser = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (existingUser) {
      throw new ConflictException(`A Shamarx account already exists for ${normalized}`);
    }

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
    // If a user got created with this email after the invite was issued (e.g.
    // a stale invite from before they signed up via another path), don't show
    // the join form — accept would throw ConflictException anyway.
    const existingUser = await this.prisma.user.findUnique({ where: { email: invite.email } });
    if (existingUser) return null;
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
      createdBy: r.createdBy?.email ?? null,
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
    // argon2 hashes are non-deterministic, so we must compare against every pending row.
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
