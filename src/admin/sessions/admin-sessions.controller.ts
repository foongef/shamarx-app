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
