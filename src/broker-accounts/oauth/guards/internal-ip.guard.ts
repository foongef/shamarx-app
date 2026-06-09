import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';

/** Allows requests only from internal docker-compose subnets or loopback.
 *  The execution-service container reaches NestJS over docker's default bridge
 *  (172.16.0.0/12) or the project-named network. */
@Injectable()
export class InternalIpGuard implements CanActivate {
  private readonly logger = new Logger(InternalIpGuard.name);

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const raw = req.ip ?? '';
    const ip = raw.replace('::ffff:', '');  // strip IPv4-mapped-IPv6 prefix
    const ok =
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip);
    if (!ok) {
      this.logger.warn(`InternalIpGuard: rejected request from ${ip} for ${req.url}`);
      throw new ForbiddenException('Internal-only endpoint');
    }
    return true;
  }
}
