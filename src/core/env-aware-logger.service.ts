import { Injectable, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

export interface LogContext {
  context?: string;
  trace?: string;
  stack?: string;
  [key: string]: unknown;
}

@Injectable()
export class EnvAwareLoggerService implements LoggerService {
  private pinoLogger: PinoLogger;
  private context = 'Logger';
  private readonly environment: string;

  constructor(private readonly configService: ConfigService) {
    this.environment = this.configService.get<string>('NODE_ENV', 'development');
    this.initializeLogger();
  }

  private getLogLevel(): string {
    switch (this.environment) {
      case 'production':
        return 'info';
      case 'staging':
        return 'debug';
      default:
        return 'debug';
    }
  }

  private initializeLogger(): void {
    this.pinoLogger = new PinoLogger({
      pinoHttp: {
        level: this.getLogLevel(),
        transport:
          this.environment === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  destination: 1,
                  all: true,
                  translateTime: 'SYS:standard',
                  colorize: true,
                  ignore: 'pid,hostname',
                  singleLine: false,
                },
              },
        base: {
          environment: this.environment,
          service: 'trading-bot',
        },
        formatters: {
          level: (label: string) => ({ level: label }),
        },
      },
    });
  }

  setContext(context: string): void {
    this.context = context;
  }

  log(message: unknown, context?: string): void {
    const ctx = context || this.context;
    if (typeof message === 'string') {
      this.pinoLogger.info({ context: ctx }, message);
    } else {
      this.pinoLogger.info({ context: ctx, ...(message as object) });
    }
  }

  error(message: unknown, trace?: string, context?: string): void {
    const ctx = context || this.context;
    if (typeof message === 'string') {
      this.pinoLogger.error({ context: ctx, trace }, message);
    } else {
      this.pinoLogger.error({ context: ctx, trace, ...(message as object) });
    }
  }

  warn(message: unknown, context?: string): void {
    const ctx = context || this.context;
    if (typeof message === 'string') {
      this.pinoLogger.warn({ context: ctx }, message);
    } else {
      this.pinoLogger.warn({ context: ctx, ...(message as object) });
    }
  }

  debug(message: unknown, context?: string): void {
    const ctx = context || this.context;
    if (typeof message === 'string') {
      this.pinoLogger.debug({ context: ctx }, message);
    } else {
      this.pinoLogger.debug({ context: ctx, ...(message as object) });
    }
  }

  verbose(message: unknown, context?: string): void {
    const ctx = context || this.context;
    if (typeof message === 'string') {
      this.pinoLogger.trace({ context: ctx }, message);
    } else {
      this.pinoLogger.trace({ context: ctx, ...(message as object) });
    }
  }
}
