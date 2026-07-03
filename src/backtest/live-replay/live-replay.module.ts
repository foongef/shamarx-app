import { Module } from '@nestjs/common';
import { LiveReplayController } from './live-replay.controller';
import { LiveReplayService } from './live-replay.service';
import { LiveSmcOrchestrator } from '../../strategy/live/live-smc-orchestrator';
import { DecisionLogService } from '../../strategy/live/decision-log.service';

@Module({
  controllers: [LiveReplayController],
  // DecisionLogService is intentionally provided here as its own instance
  // (it only depends on the global PrismaService) — importing StrategyModule
  // just for it would risk a circular module dependency.
  providers: [LiveReplayService, LiveSmcOrchestrator, DecisionLogService],
})
export class LiveReplayModule {}
