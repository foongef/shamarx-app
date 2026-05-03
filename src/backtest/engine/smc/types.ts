/**
 * V6-alt SMC types — pair-agnostic.
 *
 * The strategy core in smc-engine.ts and sweep-detector.ts only depends on
 * these types + a SmcPairConfig (in pairs/). To add a new pair, create a
 * new file in pairs/ exporting an SmcPairConfig — no other changes.
 */

export type SmcMode = 'REVERSAL' | 'CONTINUATION';

export interface PendingSetup {
  direction: 'BUY' | 'SELL';
  sweepLevel: number;       // the swept swing extreme
  sweepWick: number;        // wick extreme — basis for SL in REVERSAL mode
  sweepMid: number;         // mid-price of the sweep candle
  sweepCandleAtr: number;   // H1 ATR at sweep time
  sweepCandleHigh: number;  // for CONTINUATION SL placement
  sweepCandleLow: number;
  detectedAtH1Idx: number;
  expiresAtH1Idx: number;
  mode: SmcMode;
}

/**
 * Tunable SMC parameters per currency pair.
 *
 * `*AtrFraction` values are dimensionless (multiplied by the relevant ATR),
 * so the same number works across instruments with very different absolute
 * volatility. Only `trendingD1Adx` and the `killzone*` UTC hours are absolute.
 */
export interface SmcPairConfig {
  /** Symbol — must match the broker symbol (e.g. "XAUUSD", "EURUSD"). */
  symbol: string;

  /** How far the wick must exceed the swung level (fraction of H1 ATR). */
  sweepBufferAtr: number;

  /** SL buffer beyond the sweep wick / failed-sweep close (fraction of M15 ATR). */
  slBufferAtrM15: number;

  /** Setup is valid for this many H1 bars after detection. */
  setupExpiryH1Bars: number;

  /** H1 ATR / baseline ratio above which we treat the bar as news-spike. */
  atrSpikeLimit: number;

  /** D1 ADX threshold above which we switch to CONTINUATION mode. */
  trendingD1Adx: number;

  /** D1 ADX below this floor — skip all setups (no HTF trend at all). */
  d1AdxFloor: number;

  /** Look back this many H1 bars for swing detection. */
  recentSwingLookbackH1: number;

  /** SL cooldown after a stop loss — M15 bars. */
  slCooldownBars: number;

  /** Killzone UTC hour ranges [start, end). Pair can have 1-N zones. */
  killzones: Array<[number, number]>;

  /** TP ladder: partial fraction of total lot taken at TP1 (e.g. 0.30).
   *  Set to 0 to disable the TP1 leg — single position with TP at tp2R. */
  tp1PartialFraction: number;

  /** TP1 R-multiple. */
  tp1R: number;

  /** TP2 (runner) R-multiple. */
  tp2R: number;

  /** Disable specific SMC modes for this pair. Use ONLY for explicit overrides;
   *  prefer `autoModeFilter` for adaptive detection. */
  disabledModes?: SmcMode[];

  /** When true, the engine runs structural-health checks before accepting a
   *  CONTINUATION setup: D1 ADX must be rising, D1 EMA stack must align with
   *  bias, ADX not over-extended (<50), and price not too far from EMA50.
   *  Pair-agnostic — replaces hardcoded per-pair disable lists. Default: true. */
  autoModeFilter?: boolean;

  /** When true, sweep detection only fires at HTF anchor liquidity levels —
   *  Previous Day High/Low, Asian Range High/Low, Weekly High/Low — instead
   *  of any recent H1 swing. Targets pairs whose retail liquidity clusters
   *  at session anchors rather than arbitrary swings (forex pairs).
   *  Default: false (use legacy generic-swing detection). */
  useAnchorSweeps?: boolean;

  /** When > 0, anchor sweeps require the FOLLOWING H1 bar to displace
   *  ≥ this fraction of ATR in the trade direction. Filters chop where the
   *  sweep wick happens but no real momentum follows. 0 = disabled.
   *  Only applies when useAnchorSweeps is true. */
  anchorDisplacementAtr?: number;

  /** When > 0, skip new entries within ± this many minutes of HIGH-impact
   *  news events (NFP, FOMC, CPI, ECB). 0 = disabled. */
  newsBlackoutMinutes?: number;
}
