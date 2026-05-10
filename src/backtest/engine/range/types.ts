/**
 * Per-pair tuning knobs for the Range Reversion strategy. Mirrors the
 * shape of SmcPairConfig but with range-specific knobs.
 */

export interface RangePairConfig {
  /** Symbol — must match the broker symbol (e.g. "XAUUSD", "EURUSD"). */
  symbol: string;

  /** Master enable flag. Default false. Trades only fire when this is
   *  true AND all gates pass. Lets us A/B in replay before flipping
   *  on per-pair. */
  enabled: boolean;

  /** RSI threshold for oversold (BUY trigger). */
  rsiOversold: number;

  /** RSI threshold for overbought (SELL trigger). */
  rsiOverbought: number;

  /** D1 ADX above this → trending market → skip. Should typically
   *  match or be slightly lower than the SMC strategy's
   *  `trendingD1Adx` so the two strategies are regime-orthogonal. */
  d1AdxMaxForRange: number;

  /** Skip if M15 ATR / atrBaseline > this (news spike). */
  atrSpikeRatio: number;

  /** Minimum distance (× M15 ATR) from trigger close to EMA20 mean.
   *  Filters out tiny-edge trades. */
  minMeanDistanceAtr: number;

  /** SL placement — buffer (× M15 ATR) beyond trigger candle extreme. */
  slBufferAtrM15: number;

  /** Killzone UTC hour ranges [start, end). Same shape as SmcPairConfig.
   *  Inherits the same regime windows (London / NY) by default. */
  killzones: Array<[number, number]>;

  /** TP target as a fraction of the meanDistance. 1.0 = aim for full
   *  EMA20; 0.7 = take profit at 70% of the way to mean (more
   *  conservative). */
  tpFraction: number;

  /** Cooldown bars after a stop-out before this strategy can re-fire
   *  on the same pair. Default 4. */
  cooldownBarsAfterSL: number;

  /** Min bars between consecutive triggers (dedup). Default 8 — prevents
   *  the strategy from re-firing every M15 while RSI stays extreme. */
  minBarsBetweenTriggers: number;
}
