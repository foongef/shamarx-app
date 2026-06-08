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
