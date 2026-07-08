/**
 * Guards the replay-only exit-experiment knobs:
 *  - trailWidthMult widens computed trail distance; absent → exactly current
 *  - SimulatedBroker runner override applies to RUNNER legs only
 */
import { updatePositionManagement } from './position-simulator';
import { SMC_RUNNER_TRAIL } from './smc/trail-config';
import { SimulatedBroker } from '../live-replay/simulated-broker';

function pos(over: any = {}) {
  return {
    id: 'p1', symbol: 'GBPUSD', side: 'BUY' as const,
    lotSize: 0.1, entryPrice: 1.3000, slPrice: 1.2990, originalSlPrice: 1.2990,
    tpPrice: null, openedAt: 't', entryTime: 't', entryIndex: 0,
    setupTags: ['SMC'], h1Bias: 'BULLISH', rsiAtEntry: 50, atrAtEntry: 0,
    breakevenActivated: true, peakFavorablePrice: 1.3020, // +2R peak
    trailConfig: { ...SMC_RUNNER_TRAIL },
    ...over,
  } as any;
}
const bar = { symbol: 'GBPUSD', timeframe: 'M15', openTime: 't', open: 1.302, high: 1.302, low: 1.3015, close: 1.302, volume: 1 } as any;

describe('trailWidthMult experiment knob', () => {
  it('absent → identical to current behavior', () => {
    const a = updatePositionManagement(pos(), bar, 0);
    const b = updatePositionManagement(pos({ trailConfig: { ...SMC_RUNNER_TRAIL, trailWidthMult: 1 } }), bar, 0);
    expect(a.slPrice).toBeCloseTo(b.slPrice, 10);
  });

  it('1.5 → trail sits wider (lower SL for a BUY)', () => {
    const base = updatePositionManagement(pos(), bar, 0);
    const wide = updatePositionManagement(pos({ trailConfig: { ...SMC_RUNNER_TRAIL, trailWidthMult: 1.5 } }), bar, 0);
    expect(wide.slPrice).toBeLessThan(base.slPrice);
  });
});

describe('SimulatedBroker runner-trail override', () => {
  const SIGNAL = {
    symbol: 'GBPUSD', side: 'BUY', entryPrice: 1.3, slPrice: 1.299, tpPrice: 1.301,
    totalLot: 0.15,
    legs: [
      { lotSize: 0.05, tpPrice: 1.301, setupTags: ['TP1'] },
      { lotSize: 0.10, tpPrice: 1.304, setupTags: ['RUNNER'] },
    ],
    mode: 'REVERSAL', h1SweepTime: 't', reason: 'test',
  } as any;

  it('override reaches RUNNER legs only; TP1 untouched', () => {
    const broker = new SimulatedBroker(1000, { beThresholdR: 2.0, trailWidthMult: 1.3 });
    const [tp1, runner] = broker.placeOrder(SIGNAL, '2026-07-01T00:00:00Z');
    expect(runner.trailConfig!.beThresholdR).toBe(2.0);
    expect(runner.trailConfig!.trailWidthMult).toBe(1.3);
    expect(tp1.trailConfig!.beThresholdR).toBe(0.6); // SMC_TP1_TRAIL untouched
  });

  it('no override → exact current configs', () => {
    const broker = new SimulatedBroker(1000);
    const [, runner] = broker.placeOrder(SIGNAL, '2026-07-01T00:00:00Z');
    expect(runner.trailConfig).toEqual(SMC_RUNNER_TRAIL);
  });
});
