import { ConflictException, UnauthorizedException, BadGatewayException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { Mt5HostService } from './mt5-host.service';

function makeService(opts: {
  hosts?: any[];
  postImpl?: () => any;
}) {
  const prisma = {
    mt5Host: { findMany: jest.fn(async () => opts.hosts ?? []), findUnique: jest.fn() },
    brokerAccount: { update: jest.fn(async () => ({})), findUnique: jest.fn() },
  } as any;
  const http = {
    post: jest.fn(opts.postImpl ?? (() => of({ data: { status: 'CONNECTED' } }))),
    get: jest.fn(() => of({ data: { verdict: 'OK' } })),
    delete: jest.fn(() => of({ data: {} })),
  } as any;
  const config = { getOrThrow: jest.fn(() => 'secret') } as any;
  return { svc: new Mt5HostService(prisma, http, config), prisma, http };
}

const host = (name: string, accounts: number, capacity = 4) => ({
  id: `id-${name}`, name, privateIp: '10.0.2.48', port: 8100, capacity,
  status: 'ACTIVE', _count: { accounts },
});

describe('Mt5HostService', () => {
  it('selectHost picks the least-loaded ACTIVE host with headroom', async () => {
    const { svc } = makeService({ hosts: [host('a', 3), host('b', 1)] });
    const picked = await svc.selectHost();
    expect(picked.name).toBe('b');
  });

  it('selectHost throws 409 when every host is full', async () => {
    const { svc } = makeService({ hosts: [host('a', 4, 4)] });
    await expect(svc.selectHost()).rejects.toBeInstanceOf(ConflictException);
  });

  it('provision stamps hostId + lastConnectedAt on success', async () => {
    const { svc, prisma } = makeService({ hosts: [host('a', 0)] });
    const res = await svc.provision('acct-1', { login: 'l', password: 'p', server: 's' });
    expect(res.status).toBe('CONNECTED');
    expect(prisma.brokerAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'acct-1' },
        data: expect.objectContaining({ hostId: 'id-a' }),
      }),
    );
  });

  it('provision maps manager 401 to UnauthorizedException', async () => {
    const { svc } = makeService({
      hosts: [host('a', 0)],
      postImpl: () => throwError(() => ({ response: { status: 401 }, message: 'auth' })),
    });
    await expect(svc.provision('acct-1', { login: 'l', password: 'x', server: 's' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('provision maps network errors to BadGatewayException', async () => {
    const { svc } = makeService({
      hosts: [host('a', 0)],
      postImpl: () => throwError(() => ({ message: 'ECONNREFUSED' })),
    });
    await expect(svc.provision('acct-1', { login: 'l', password: 'p', server: 's' }))
      .rejects.toBeInstanceOf(BadGatewayException);
  });

  it('deprovision swallows network errors (idempotent host cleanup)', async () => {
    const { svc, prisma, http } = makeService({});
    prisma.brokerAccount.findUnique.mockResolvedValue({
      id: 'acct-1', host: { privateIp: '10.0.2.48', port: 8100 },
    });
    http.delete.mockReturnValue(throwError(() => ({ message: 'timeout' })));
    await expect(svc.deprovision('acct-1')).resolves.toBeUndefined();
  });

  it('capacities marks unreachable hosts instead of failing the batch', async () => {
    const { svc, prisma, http } = makeService({});
    prisma.mt5Host.findMany.mockResolvedValue([
      { name: 'mt5-host-01', privateIp: '10.0.2.48', port: 8100 },
      { name: 'mt5-host-02', privateIp: '10.0.2.99', port: 8100 },
    ]);
    http.get
      .mockReturnValueOnce(of({ data: { verdict: 'OK' } }))
      .mockReturnValueOnce(throwError(() => ({ message: 'unreachable' })));
    const out = await svc.capacities();
    expect(out[0]).toMatchObject({ name: 'mt5-host-01', reachable: true, verdict: 'OK' });
    expect(out[1]).toMatchObject({ name: 'mt5-host-02', reachable: false });
  });
});
