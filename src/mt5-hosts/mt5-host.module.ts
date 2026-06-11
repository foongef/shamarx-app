import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '@app/prisma';
import { RedisModule } from '@app/redis';
import { Mt5HostService } from './mt5-host.service';
import { Mt5HostController } from './mt5-host.controller';

@Module({
  imports: [HttpModule, PrismaModule, RedisModule],
  controllers: [Mt5HostController],
  providers: [Mt5HostService],
  exports: [Mt5HostService],
})
export class Mt5HostModule {}
