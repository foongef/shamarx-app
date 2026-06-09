import { Test } from '@nestjs/testing';
import { BrokerOAuthController } from './broker-oauth.controller';
import { BrokerOAuthService } from './broker-oauth.service';

describe('BrokerOAuthController', () => {
  let ctrl: BrokerOAuthController;
  let svc: { startOAuth: jest.Mock; handleCallback: jest.Mock; finalize: jest.Mock };

  beforeEach(async () => {
    svc = { startOAuth: jest.fn(), handleCallback: jest.fn(), finalize: jest.fn() };
    const mod = await Test.createTestingModule({
      controllers: [BrokerOAuthController],
      providers: [{ provide: BrokerOAuthService, useValue: svc }],
    }).compile();
    ctrl = mod.get(BrokerOAuthController);
  });

  it('GET /oauth/start delegates with the JWT user id', async () => {
    svc.startOAuth.mockResolvedValue({ authUrl: 'X', state: 'S' });
    const res = await ctrl.start({ id: 'u1', email: 'u@x', role: 'USER' } as any);
    expect(svc.startOAuth).toHaveBeenCalledWith('u1');
    expect(res.authUrl).toBe('X');
  });

  it('POST /callback delegates code+state', async () => {
    svc.handleCallback.mockResolvedValue({ sessionId: 'S', accounts: [] });
    await ctrl.callback({ code: 'CODE', state: 'STATE' });
    expect(svc.handleCallback).toHaveBeenCalledWith('CODE', 'STATE');
  });

  it('POST /finalize forwards userId + dto fields, defaults isEnabled to false', async () => {
    svc.finalize.mockResolvedValue({ id: 'new-id' });
    await ctrl.finalize(
      { id: 'u1', email: 'u@x', role: 'USER' } as any,
      { oauthSessionId: 'S', ctidTraderAccountId: 42, name: 'X' } as any,
    );
    expect(svc.finalize).toHaveBeenCalledWith('u1', 'S', 42, 'X', false);
  });

  it('POST /finalize honours isEnabled=true when provided', async () => {
    svc.finalize.mockResolvedValue({ id: 'new-id' });
    await ctrl.finalize(
      { id: 'u1', email: 'u@x', role: 'USER' } as any,
      { oauthSessionId: 'S', ctidTraderAccountId: 42, name: 'X', isEnabled: true } as any,
    );
    expect(svc.finalize).toHaveBeenCalledWith('u1', 'S', 42, 'X', true);
  });
});
