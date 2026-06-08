import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersController } from './users/admin-users.controller';
import { AdminUsersService } from './users/admin-users.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminModule {}
