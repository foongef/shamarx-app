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
