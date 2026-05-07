import { Module } from '@nestjs/common';
import { LiveReplayController } from './live-replay.controller';
import { LiveReplayService } from './live-replay.service';
import { SmcLiveEvaluator } from '../../strategy/live/smc-live-evaluator';

@Module({
  controllers: [LiveReplayController],
  providers: [LiveReplayService, SmcLiveEvaluator],
})
export class LiveReplayModule {}
