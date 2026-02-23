import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { EnvAwareLoggerService } from './env-aware-logger.service';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: EnvAwareLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errorResponse: unknown = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === 'string' ? res : (res as any).message || exception.message;
      errorResponse = res;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Log the full error with stack trace for 5xx
    if (status >= 500) {
      this.logger.error(
        {
          message: `${request.method} ${request.url} → ${status}`,
          error: message,
          stack: exception instanceof Error ? exception.stack : undefined,
          body: request.body,
          params: request.params,
          query: request.query,
        },
        exception instanceof Error ? exception.stack : undefined,
        'ExceptionFilter',
      );
    } else {
      this.logger.warn(
        {
          message: `${request.method} ${request.url} → ${status}`,
          error: message,
        },
        'ExceptionFilter',
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(errorResponse && typeof errorResponse === 'object' && !(errorResponse instanceof HttpException)
        ? errorResponse
        : {}),
    });
  }
}
