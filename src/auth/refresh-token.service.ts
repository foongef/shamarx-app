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
      this.logger.warn(`Refresh-token reuse detected for userId=${row.userId}`);
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (row.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const next = await this.issue(row.userId, userAgent);

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
