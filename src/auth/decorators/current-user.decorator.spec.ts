import { ExecutionContext } from '@nestjs/common';
import { currentUserFactory } from './current-user.decorator';

function mockCtx(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('CurrentUser decorator', () => {
  it('returns the user from the request', () => {
    const user = { id: 'u1', email: 'a@b', role: 'USER' };
    expect(currentUserFactory(undefined, mockCtx(user))).toEqual(user);
  });

  it('returns undefined if request has no user', () => {
    expect(currentUserFactory(undefined, mockCtx(undefined))).toBeUndefined();
  });
});
