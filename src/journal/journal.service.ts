import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService, REDIS_CHANNELS } from '@app/redis';

@Injectable()
export class JournalService implements OnModuleInit {
  private readonly logger = new Logger(JournalService.name);

  constructor(private readonly redis: RedisService) {}

  async onModuleInit() {
    // Stub listeners for future implementation
    await this.redis.subscribe(REDIS_CHANNELS.TRADE_OPENED, (message) => {
      this.logger.log(`[STUB] Trade opened event: ${message}`);
    });

    await this.redis.subscribe(REDIS_CHANNELS.TRADE_CLOSED, (message) => {
      this.logger.log(`[STUB] Trade closed event: ${message}`);
    });

    await this.redis.subscribe(REDIS_CHANNELS.TRADE_REJECTED, (message) => {
      this.logger.log(`[STUB] Trade rejected event: ${message}`);
    });

    this.logger.log('Journal service initialized (stub mode)');
  }
}
