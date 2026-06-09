import { Test } from '@nestjs/testing';
import { BrokerAccountsController } from './broker-accounts.controller';
import { BrokerAccountsService } from './broker-accounts.service';
import { BrokerOAuthService } from './oauth/broker-oauth.service';
import { InternalIpGuard } from './oauth/guards/internal-ip.guard';

describe('BrokerAccountsController routing', () => {
  let controller: BrokerAccountsController;
  let service: jest.Mocked<BrokerAccountsService>;
  let oauth: jest.Mocked<Partial<BrokerOAuthService>>;

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue({ id: 'a1', name: 'demo' }),
      findAllForUser: jest.fn().mockResolvedValue([]),
      findOneForUser: jest.fn().mockResolvedValue({ id: 'a1' }),
      update: jest.fn().mockResolvedValue({ id: 'a1' }),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;
    oauth = { storeRefreshedTokens: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [BrokerAccountsController],
      providers: [
        { provide: BrokerAccountsService, useValue: service },
        { provide: BrokerOAuthService, useValue: oauth },
      ],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(InternalIpGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(BrokerAccountsController);
  });

  it('GET / lists accounts for current user', async () => {
    await controller.list({ user: { id: 'u1' } } as any);
    expect(service.findAllForUser).toHaveBeenCalledWith('u1');
  });

  it('POST / creates with current user id', async () => {
    const body = { name: 'demo', broker: 'METAAPI', mode: 'metaapi', creds: { accountId: 'a', accessToken: 't' } };
    await controller.create({ user: { id: 'u1' } } as any, body as any);
    expect(service.create).toHaveBeenCalledWith('u1', body);
  });

  it('GET /:id returns single account', async () => {
    await controller.findOne({ user: { id: 'u1' } } as any, 'a1');
    expect(service.findOneForUser).toHaveBeenCalledWith('u1', 'a1');
  });

  it('PATCH /:id updates', async () => {
    await controller.update({ user: { id: 'u1' } } as any, 'a1', { name: 'New' });
    expect(service.update).toHaveBeenCalledWith('u1', 'a1', { name: 'New' });
  });

  it('DELETE /:id soft-deletes by default', async () => {
    await controller.delete({ user: { id: 'u1' } } as any, 'a1', undefined);
    expect(service.delete).toHaveBeenCalledWith('u1', 'a1', false);
  });

  it('DELETE /:id?force=true passes force flag', async () => {
    await controller.delete({ user: { id: 'u1' } } as any, 'a1', 'true');
    expect(service.delete).toHaveBeenCalledWith('u1', 'a1', true);
  });

  it('PATCH /:id/oauth-tokens forwards refreshed tokens to BrokerOAuthService', async () => {
    const dto = { accessToken: 'NEW', refreshToken: 'R2', expiresAt: 9999999 };
    const result = await controller.updateOAuthTokens('a1', dto);
    expect(oauth.storeRefreshedTokens).toHaveBeenCalledWith('a1', dto);
    expect(result).toEqual({ ok: true });
  });
});

describe('InternalIpGuard', () => {
  function build(ip: string) {
    return {
      switchToHttp: () => ({ getRequest: () => ({ ip, url: '/x' }) }),
    } as any;
  }
  const guard = new InternalIpGuard();

  it.each([
    '127.0.0.1', '::1',
    '10.0.0.1', '192.168.1.1',
    '172.16.0.5', '172.31.255.254',
    '::ffff:172.18.0.2',  // IPv4-mapped IPv6
  ])('allows internal address %s', (ip) => {
    expect(guard.canActivate(build(ip))).toBe(true);
  });

  it.each([
    '8.8.8.8', '203.0.113.10', '172.15.0.1', '172.32.0.1',
  ])('rejects external address %s', (ip) => {
    expect(() => guard.canActivate(build(ip))).toThrow(/Internal-only/);
  });
});
