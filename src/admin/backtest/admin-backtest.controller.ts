import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../auth/guards/roles.guard';
import { AdminBacktestService } from './admin-backtest.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERADMIN')
@Controller('api/admin/backtest')
export class AdminBacktestController {
  constructor(private readonly svc: AdminBacktestService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }
}
