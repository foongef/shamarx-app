import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { PrismaModule } from '@app/prisma';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MeController],
})
export class MeModule {}
