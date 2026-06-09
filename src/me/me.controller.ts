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
        ...(dto.botEnabled !== undefined && {
          botEnabled: dto.botEnabled,
          pausedAt: dto.botEnabled ? null : new Date(),
        }),
        ...(dto.presetKey !== undefined && { presetKey: dto.presetKey }),
      },
      select: {
        id: true, email: true, role: true, isActive: true, botEnabled: true, presetKey: true, pausedAt: true,
      },
    });
  }
}
