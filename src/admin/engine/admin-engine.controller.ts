import { Body, Controller, Get, HttpCode, Post, UseGuards, BadRequestException } from '@nestjs/common';
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
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
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
      throw new BadRequestException('Confirmation phrase required');
    }
    await this.prisma.user.updateMany({
      where: { role: 'USER' },
      data: { botEnabled: false },
    });
  }
}
