import { STRATEGY_BASELINE } from './baseline';

describe('STRATEGY_BASELINE', () => {
  it('matches the published validation numbers', () => {
    expect(STRATEGY_BASELINE.trades).toBe(686);
    expect(STRATEGY_BASELINE.winRate).toBeCloseTo(0.649, 3);
    expect(STRATEGY_BASELINE.expectancy).toBeCloseTo(0.42, 2);
    expect(STRATEGY_BASELINE.avgRR).toBeCloseTo(1.6, 1);
    expect(STRATEGY_BASELINE.maxDdPct).toBeCloseTo(4.1, 1);
  });
});
