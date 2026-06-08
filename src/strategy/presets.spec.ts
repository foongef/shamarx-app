import { PRESETS, getPreset } from './presets';

describe('PRESETS', () => {
  it('defines all three presets', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['AGGRESSIVE', 'BALANCED', 'CONSERVATIVE']);
  });

  it('BALANCED matches the validated live config', () => {
    expect(PRESETS.BALANCED).toEqual({
      riskPercent: 1.0,
      maxDailyLossPercent: 3.0,
      maxOpenPositions: 3,
      pairs: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
    });
  });

  it('CONSERVATIVE is strictly safer than BALANCED', () => {
    expect(PRESETS.CONSERVATIVE.riskPercent).toBeLessThan(PRESETS.BALANCED.riskPercent);
    expect(PRESETS.CONSERVATIVE.maxDailyLossPercent).toBeLessThan(PRESETS.BALANCED.maxDailyLossPercent);
  });

  it('AGGRESSIVE is bolder than BALANCED', () => {
    expect(PRESETS.AGGRESSIVE.riskPercent).toBeGreaterThan(PRESETS.BALANCED.riskPercent);
  });

  it('getPreset() returns the typed preset', () => {
    expect(getPreset('BALANCED')).toBe(PRESETS.BALANCED);
  });
});
