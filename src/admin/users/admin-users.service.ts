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
