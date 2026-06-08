import { Test } from '@nestjs/testing';
import { LiveSmcOrchestratorRegistry } from './live-smc-orchestrator-registry';

describe('LiveSmcOrchestratorRegistry', () => {
  let registry: LiveSmcOrchestratorRegistry;
  let factory: jest.Mock;

  beforeEach(async () => {
    factory = jest.fn(() => ({
      restore: jest.fn().mockResolvedValue(undefined),
      persistNow: jest.fn().mockResolvedValue(undefined),
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

  it('calls restore on first creation', () => {
    const inst = registry.getOrCreate('acct-1') as any;
    expect(inst.restore).toHaveBeenCalledWith('acct-1');
  });

  it('removeIfDisabled persists state', async () => {
    const inst = registry.getOrCreate('acct-1') as any;
    await registry.removeIfDisabled('acct-1');
    expect(inst.persistNow).toHaveBeenCalledWith('acct-1');
  });
});
