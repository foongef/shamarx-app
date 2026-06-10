import { Test } from '@nestjs/testing';
import { LiveSmcOrchestratorRegistry } from './live-smc-orchestrator-registry';

describe('LiveSmcOrchestratorRegistry', () => {
  let registry: LiveSmcOrchestratorRegistry;
  let factory: jest.Mock;

  beforeEach(async () => {
    factory = jest.fn(() => ({
      restoreFromRedis: jest.fn().mockResolvedValue(undefined),
      persistToRedis: jest.fn().mockResolvedValue(undefined),
    } as any));
    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSmcOrchestratorRegistry,
        { provide: 'ORCHESTRATOR_FACTORY', useValue: factory },
      ],
    }).compile();
    registry = moduleRef.get(LiveSmcOrchestratorRegistry);
  });

  it('returns the same instance for the same accountId', async () => {
    const a1 = await registry.getOrCreate('acct-1');
    const a2 = await registry.getOrCreate('acct-1');
    expect(a1).toBe(a2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns different instances for different accountIds', async () => {
    const a = await registry.getOrCreate('acct-1');
    const b = await registry.getOrCreate('acct-2');
    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('calls restoreFromRedis on first creation', async () => {
    const inst = await registry.getOrCreate('acct-1') as any;
    expect(inst.restoreFromRedis).toHaveBeenCalledWith('acct-1');
  });

  it('removeIfDisabled calls persistToRedis', async () => {
    const inst = await registry.getOrCreate('acct-1') as any;
    await registry.removeIfDisabled('acct-1');
    expect(inst.persistToRedis).toHaveBeenCalledWith('acct-1');
  });

  describe('persistAll', () => {
    it('persists every in-memory orchestrator with its accountId', async () => {
      const a = await registry.getOrCreate('acct-1') as any;
      const b = await registry.getOrCreate('acct-2') as any;
      const c = await registry.getOrCreate('acct-3') as any;

      const count = await registry.persistAll();

      expect(count).toBe(3);
      expect(a.persistToRedis).toHaveBeenCalledWith('acct-1');
      expect(b.persistToRedis).toHaveBeenCalledWith('acct-2');
      expect(c.persistToRedis).toHaveBeenCalledWith('acct-3');
    });

    it('returns 0 when no orchestrators are loaded', async () => {
      const count = await registry.persistAll();
      expect(count).toBe(0);
    });

    it('isolates failures — one bad persist does not block others', async () => {
      const a = await registry.getOrCreate('acct-1') as any;
      const b = await registry.getOrCreate('acct-2') as any;

      (a.persistToRedis as jest.Mock).mockRejectedValueOnce(new Error('redis flake'));

      const count = await registry.persistAll();

      expect(count).toBe(1); // only b succeeded
      expect(a.persistToRedis).toHaveBeenCalledWith('acct-1');
      expect(b.persistToRedis).toHaveBeenCalledWith('acct-2');
    });
  });

  describe('persistAllScheduled', () => {
    it('skips when registry is empty (no log spam)', async () => {
      const spy = jest.spyOn(registry, 'persistAll');
      await registry.persistAllScheduled();
      expect(spy).not.toHaveBeenCalled();
    });

    it('calls persistAll when instances exist', async () => {
      await registry.getOrCreate('acct-1');
      const spy = jest.spyOn(registry, 'persistAll').mockResolvedValue(1);
      await registry.persistAllScheduled();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('LiveSmcOrchestratorRegistry — restore-before-use (2026-06 dup-sweep regression)', () => {
  it('awaits restoreFromRedis before returning the instance', async () => {
    let restoreResolved = false;
    const factory = jest.fn(() => ({
      restoreFromRedis: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        restoreResolved = true;
      }),
      persistToRedis: jest.fn().mockResolvedValue(undefined),
    } as any));
    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSmcOrchestratorRegistry,
        { provide: 'ORCHESTRATOR_FACTORY', useValue: factory },
      ],
    }).compile();
    const registry = moduleRef.get(LiveSmcOrchestratorRegistry);

    await registry.getOrCreate('acct-1');
    expect(restoreResolved).toBe(true);
  });

  it('concurrent first calls share ONE creation (no racing instances)', async () => {
    const factory = jest.fn(() => ({
      restoreFromRedis: jest.fn(async () => new Promise((r) => setTimeout(r, 20))),
      persistToRedis: jest.fn().mockResolvedValue(undefined),
    } as any));
    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSmcOrchestratorRegistry,
        { provide: 'ORCHESTRATOR_FACTORY', useValue: factory },
      ],
    }).compile();
    const registry = moduleRef.get(LiveSmcOrchestratorRegistry);

    const [a, b, c] = await Promise.all([
      registry.getOrCreate('acct-1'),
      registry.getOrCreate('acct-1'),
      registry.getOrCreate('acct-1'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('survives a failing restore (starts fresh, instance still usable)', async () => {
    const factory = jest.fn(() => ({
      restoreFromRedis: jest.fn().mockRejectedValue(new Error('redis down')),
      persistToRedis: jest.fn().mockResolvedValue(undefined),
    } as any));
    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveSmcOrchestratorRegistry,
        { provide: 'ORCHESTRATOR_FACTORY', useValue: factory },
      ],
    }).compile();
    const registry = moduleRef.get(LiveSmcOrchestratorRegistry);

    const inst = await registry.getOrCreate('acct-1');
    expect(inst).toBeDefined();
    // Second call returns the cached instance — no re-create loop
    const again = await registry.getOrCreate('acct-1');
    expect(again).toBe(inst);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
