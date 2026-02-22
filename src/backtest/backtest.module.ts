import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';

@Module({
  imports: [HttpModule],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
