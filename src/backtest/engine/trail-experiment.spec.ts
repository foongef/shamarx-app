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

describe('retrace-entry experiment (replay-only)', () => {
  const SIGNAL = {
    symbol: 'GBPUSD', side: 'BUY', entryPrice: 1.3000, slPrice: 1.2990, tpPrice: 1.3010,
    totalLot: 0.15,
    legs: [
      { lotSize: 0.05, tpPrice: 1.3010, setupTags: ['TP1'] },
      { lotSize: 0.10, tpPrice: 1.3040, setupTags: ['RUNNER'] },
    ],
    mode: 'REVERSAL', h1SweepTime: 't', reason: 'test',
  } as any;
  const bar = (low: number, high: number) => ({
    symbol: 'GBPUSD', timeframe: 'M15', openTime: 't1',
    open: (low + high) / 2, high, low, close: (low + high) / 2, volume: 1,
  } as any);

  it('parks a limit at frac of entry→SL distance instead of filling', () => {
    const broker = new SimulatedBroker(1000, undefined, { frac: 0.5, expiryBars: 6 });
    const positions = broker.placeOrder(SIGNAL, 't0');
    expect(positions).toHaveLength(0);
    expect(broker.pendingCount()).toBe(1);
    expect(broker.totalOpenCount()).toBe(0);
  });

  it('fills at the limit when touched, with lots rescaled to equal dollar risk', () => {
    const broker = new SimulatedBroker(1000, undefined, { frac: 0.5, expiryBars: 6 });
    broker.placeOrder(SIGNAL, 't0');
    // limit = 1.3000 - 0.5×(0.0010) = 1.2995; gentle bar dips to it without
    // ripping far enough to arm BE-trail on the same candle
    broker.processCandle('GBPUSD', bar(1.2995, 1.2996));
    expect(broker.pendingCount()).toBe(0);
    const dirs = broker.getOpenDirections('GBPUSD');
    expect(dirs.has('BUY')).toBe(true);
    // risk halved (5 pips vs 10) → lots doubled: 0.05→0.10, 0.10→0.20
    const open = (broker as any).positions.get('GBPUSD');
    expect(open.map((p: any) => p.lotSize)).toEqual([0.1, 0.2]);
    expect(open[0].entryPrice).toBeCloseTo(1.2995, 10);
    expect(open[0].slPrice).toBeCloseTo(1.2990, 10); // stop unchanged
  });

  it('expires unfilled after expiryBars — the runaway reversal is missed', () => {
    const broker = new SimulatedBroker(1000, undefined, { frac: 0.5, expiryBars: 2 });
    broker.placeOrder(SIGNAL, 't0');
    broker.processCandle('GBPUSD', bar(1.2997, 1.3008)); // never dips to 1.2995
    expect(broker.pendingCount()).toBe(1);
    broker.processCandle('GBPUSD', bar(1.2998, 1.3012));
    expect(broker.pendingCount()).toBe(0); // expired
    expect(broker.totalOpenCount()).toBe(0);
  });

  it('pessimistic same-bar stop: a bar sweeping limit AND stop fills then loses', () => {
    const broker = new SimulatedBroker(1000, undefined, { frac: 0.5, expiryBars: 6 });
    broker.placeOrder(SIGNAL, 't0');
    const closed = broker.processCandle('GBPUSD', bar(1.2985, 1.3002)); // through limit AND SL
    expect(broker.pendingCount()).toBe(0);
    expect(closed.length).toBe(2); // both legs stopped same bar
    expect(closed.every((c: any) => c.exitReason === 'SL')).toBe(true);
  });

  it('without the knob, behavior is exactly current (market fill at close)', () => {
    const broker = new SimulatedBroker(1000);
    const positions = broker.placeOrder(SIGNAL, 't0');
    expect(positions).toHaveLength(2);
    expect(positions[0].entryPrice).toBe(1.3);
    expect(broker.pendingCount()).toBe(0);
  });
});

describe('fill-bar pessimism', () => {
  const SIG = {
    symbol: 'GBPUSD', side: 'BUY', entryPrice: 1.3000, slPrice: 1.2990, tpPrice: 1.3010,
    totalLot: 0.15,
    legs: [{ lotSize: 0.05, tpPrice: 1.3010, setupTags: ['TP1'] }],
    mode: 'REVERSAL', h1SweepTime: 't', reason: 'test',
  } as any;

  it('a bar that fills the limit AND spans TP does NOT count the TP (no look-ahead)', () => {
    const broker = new SimulatedBroker(1000, undefined, { frac: 0.5, expiryBars: 6 });
    broker.placeOrder(SIG, 't0');
    // dips to limit 1.2995 and rips through TP 1.3010 in the same bar
    const closed = broker.processCandle('GBPUSD', {
      symbol: 'GBPUSD', timeframe: 'M15', openTime: 't1',
      open: 1.3, high: 1.3015, low: 1.2995, close: 1.3012, volume: 1,
    } as any);
    expect(closed).toHaveLength(0);          // still open — TP only from next bar
    expect(broker.totalOpenCount()).toBe(1);
    // next bar touching TP gently closes it normally
    const closed2 = broker.processCandle('GBPUSD', {
      symbol: 'GBPUSD', timeframe: 'M15', openTime: 't2',
      open: 1.3008, high: 1.30105, low: 1.30085, close: 1.301, volume: 1,
    } as any);
    expect(closed2).toHaveLength(1);
    expect(closed2[0].exitReason).toBe('TP');
    expect(closed2[0].pnl).toBeGreaterThan(0);
  });
});
