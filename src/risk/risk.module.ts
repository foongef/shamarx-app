import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';

@Module({
  imports: [HttpModule],
  controllers: [RiskController],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
