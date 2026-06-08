import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../auth.service';

export function currentUserFactory(
  _data: unknown,
  ctx: ExecutionContext,
): AuthenticatedUser | undefined {
  const req = ctx.switchToHttp().getRequest();
  return req.user as AuthenticatedUser | undefined;
}

export const CurrentUser = createParamDecorator(currentUserFactory);
