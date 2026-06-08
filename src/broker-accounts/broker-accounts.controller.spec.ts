import { Test } from '@nestjs/testing';
import { BrokerAccountsController } from './broker-accounts.controller';
import { BrokerAccountsService } from './broker-accounts.service';

describe('BrokerAccountsController routing', () => {
  let controller: BrokerAccountsController;
  let service: jest.Mocked<BrokerAccountsService>;

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue({ id: 'a1', name: 'demo' }),
      findAllForUser: jest.fn().mockResolvedValue([]),
      findOneForUser: jest.fn().mockResolvedValue({ id: 'a1' }),
      update: jest.fn().mockResolvedValue({ id: 'a1' }),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;

    const moduleRef = await Test.createTestingModule({
      controllers: [BrokerAccountsController],
      providers: [{ provide: BrokerAccountsService, useValue: service }],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard)
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
});
