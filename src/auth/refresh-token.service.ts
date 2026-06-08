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

    if (!row) {
      // Same external message regardless of state — no enumeration oracle
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (row.revokedAt) {
      this.logger.warn(`Refresh-token reuse detected for userId=${row.userId}`);
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (row.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const next = await this.prisma.$transaction(async (tx) => {
      const tokenForNew = generateToken();
      const hashForNew = hash(tokenForNew);
      const newRow = await tx.refreshToken.create({
        data: {
          userId: row.userId,
          tokenHash: hashForNew,
          expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
          userAgent: userAgent ?? null,
        },
      });

      const revoked = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: newRow.id },
      });

      if (revoked.count === 0) {
        // Another rotate() raced us — abort this transaction.
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      return { id: newRow.id, token: tokenForNew };
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
    const cutoff = new Date();
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return count;
  }
}
