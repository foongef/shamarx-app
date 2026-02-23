import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { EnvAwareLoggerService } from './env-aware-logger.service';

@Injectable()
export class ApiLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: EnvAwareLoggerService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();

    res.on('finish', () => {
      if (req.originalUrl === '/health' && res.statusCode < 400) {
        return;
      }

      const duration = Date.now() - start;
      const logData = {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
      };

      if (res.statusCode >= 500) {
        this.logger.error(logData, undefined, 'HTTP');
      } else if (res.statusCode >= 400) {
        this.logger.warn(logData, 'HTTP');
      } else {
        this.logger.log(logData, 'HTTP');
      }
    });

    next();
  }
}
