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
  /** openTime of the sweep H1 bar. Stable across array shifts (the live H1
   *  buffer rolls every minute), unlike detectedAtH1Idx which only points
   *  to the right bar at the moment of creation. Used by the orchestrator
   *  to identify and dedup setups after they've been added to pending. */
  sweepTime: string;
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

  /** When > 0, reject setups where SL distance exceeds this many M15 ATRs.
   *  Mimics the lot-floor selection effect that helps small accounts —
   *  wide-SL setups have systematically lower win rate and dilute edge at
   *  large account sizes (where the lot floor never binds). 0 = disabled. */
  maxSlAtrM15?: number;

  // ─── SMC structure gates (optional, default OFF) ─────────────────────
  // Each gate is a pure-function check that runs after the sweep + bias
  // filters but before signal-fire. When enabled, the trade is rejected
  // if the gate fails. Used to extend the strategy to incorporate FVG /
  // OB / BOS confirmation. ALL gates default off so the baseline
  // strategy is unchanged until a gate is validated to meet or beat
  // baseline metrics in replay.

  /** When true, fire only if there is an unmitigated direction-aligned
   *  Fair Value Gap on M15 within `fvgGateMaxDistanceAtr` of the entry
   *  price. Reads at signal-time from the M15 candle window. */
  useFvgGate?: boolean;
  /** Distance (in M15-ATR multiples) within which the FVG must sit
   *  relative to the entry price. Default 1.5 — tight enough to be
   *  meaningful, loose enough to catch most retests. */
  fvgGateMaxDistanceAtr?: number;
  /** Drop FVGs smaller than this fraction of the M15 ATR. 0 = keep all. */
  fvgGateMinHeightAtr?: number;

  /** When true, fire only if there is an unmitigated direction-aligned
   *  Order Block on H1 within `obGateMaxDistanceAtr` of the entry. */
  useObGate?: boolean;
  /** OB displacement threshold — the impulsive move that confirms the
   *  block must displace at least this many H1 ATRs. Default 1.5. */
  obGateDisplacementAtrMult?: number;
  /** Distance (in H1-ATR multiples) within which the OB must sit
   *  relative to the entry price. Default 2.0. */
  obGateMaxDistanceAtr?: number;

  /** When true, fire only if there's a Break of Structure in the entry
   *  direction between the sweep candle and the M15 entry candle.
   *  Conservative confirmation — typically reduces trade count but
   *  improves win rate. */
  useBosGate?: boolean;
  /** Swing-fractal lookback used to define the structure that needs to
   *  break. Default = sweep-detector's `recentSwingLookbackH1`. */
  bosGateSwingLookback?: number;

  // ─── Path-3 pre-sweep validity gates (default OFF) ───────────────────
  // The original useFvgGate / useObGate / useBosGate above check structure
  // AFTER our entry candle, which fails because our entry IS the start of
  // the impulse that creates the structure (validated 2026-05-09 replay:
  // every gate dropped both trade count AND win rate). These reframed
  // gates check the validity of the swept LEVEL — was it formed by
  // institutional structure (OB / FVG / BOS-of-prior-swing) — answering
  // a different question that's actually answerable at signal time.

  /** When true, require a fresh OB at the swept level — i.e. the swing
   *  high/low was preceded by an opposing-direction candle whose impulse
   *  toward the level was meaningful. Filters out sweeps of chop wicks. */
  useObOriginGate?: boolean;
  /** Look back this many H1 bars from the swept swing for the OB. Default 12. */
  obOriginLookback?: number;
  /** Required impulse displacement (× ATR) from OB candle to swung level. Default 1.2. */
  obOriginDisplacementAtr?: number;

  /** When true, require an FVG behind the impulse that BUILT the swept
   *  level. Confirms the swing was formed by a real impulse, not chop. */
  useImpulseFvgGate?: boolean;
  /** Look back this many H1 bars from the swept swing for the impulse FVG. Default 5. */
  impulseFvgLookback?: number;

  /** When true, require the swept level itself was a break of an EARLIER
   *  same-side swing — i.e. the wick that got swept was extending past
   *  prior structure. Filters out sweeps of insignificant levels. */
  useBosOriginGate?: boolean;
  /** How far back to look for the prior swing whose level the swept
   *  swing must have broken. Default 24 H1 bars. */
  bosOriginLookback?: number;
}
