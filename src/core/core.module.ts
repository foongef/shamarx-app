import { Global, MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EnvAwareLoggerService } from './env-aware-logger.service';
import { ApiLoggingMiddleware } from './api-logging.middleware';
import { GlobalExceptionFilter } from './global-exception.filter';

@Global()
@Module({
  providers: [
    EnvAwareLoggerService,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
  exports: [EnvAwareLoggerService],
})
export class CoreModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ApiLoggingMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
