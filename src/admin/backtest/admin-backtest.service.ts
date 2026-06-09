import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';

@Injectable()
export class AdminBacktestService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.backtestRun.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
  }

  findOne(id: string) {
    return this.prisma.backtestRun.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    });
  }
}
