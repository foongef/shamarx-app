import { Module } from '@nestjs/common';
import { LiveReplayController } from './live-replay.controller';
import { LiveReplayService } from './live-replay.service';
import { LiveSmcOrchestrator } from '../../strategy/live/live-smc-orchestrator';

@Module({
  controllers: [LiveReplayController],
  providers: [LiveReplayService, LiveSmcOrchestrator],
})
export class LiveReplayModule {}
