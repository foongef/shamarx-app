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

  it('returns the same instance for the same accountId', () => {
    const a1 = registry.getOrCreate('acct-1');
    const a2 = registry.getOrCreate('acct-1');
    expect(a1).toBe(a2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns different instances for different accountIds', () => {
    const a = registry.getOrCreate('acct-1');
    const b = registry.getOrCreate('acct-2');
    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('calls restoreFromRedis on first creation', () => {
    const inst = registry.getOrCreate('acct-1') as any;
    expect(inst.restoreFromRedis).toHaveBeenCalledWith('acct-1');
  });

  it('removeIfDisabled calls persistToRedis', async () => {
    const inst = registry.getOrCreate('acct-1') as any;
    await registry.removeIfDisabled('acct-1');
    expect(inst.persistToRedis).toHaveBeenCalledWith('acct-1');
  });

  describe('persistAll', () => {
    it('persists every in-memory orchestrator with its accountId', async () => {
      const a = registry.getOrCreate('acct-1') as any;
      const b = registry.getOrCreate('acct-2') as any;
      const c = registry.getOrCreate('acct-3') as any;

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
      const a = registry.getOrCreate('acct-1') as any;
      const b = registry.getOrCreate('acct-2') as any;

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
      registry.getOrCreate('acct-1');
      const spy = jest.spyOn(registry, 'persistAll').mockResolvedValue(1);
      await registry.persistAllScheduled();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
