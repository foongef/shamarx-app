import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersController } from './users/admin-users.controller';
import { AdminUsersService } from './users/admin-users.service';
import { AdminSessionsController } from './sessions/admin-sessions.controller';
import { AdminSessionsService } from './sessions/admin-sessions.service';
import { AdminEngineController } from './engine/admin-engine.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    AdminUsersController,
    AdminSessionsController,
    AdminEngineController,
  ],
  providers: [AdminUsersService, AdminSessionsService],
})
export class AdminModule {}
