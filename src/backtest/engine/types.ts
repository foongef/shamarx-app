export type TradingMode = 'AGGRESSIVE' | 'NORMAL' | 'DEFENSIVE';

export interface BacktestCandle {
  symbol: string;
  timeframe: string;
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorState {
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi14: number[];
  atr14: number[];
  adx14: number[];
  plusDI14: number[];
  minusDI14: number[];
  atrBaseline: number[];
}

// V6: Detailed regime classification
export type DetailedRegime = 'STRONG_TREND' | 'WEAK_TREND' | 'RANGING' | 'VOLATILE' | 'TRANSITIONING';

// V6: Engine type for performance tracking
export type EngineType =
  | 'TREND_PULLBACK'
  | 'FVG_FILL'
  | 'RANGE_ENGINE'
  | 'BB_REVERSAL'   // V6: Bollinger reversal (replaces RANGE_ENGINE in V6 profile)
  | 'SMC';          // V6-alt: order-flow / smart money concepts

// V6: Strategy version selector. 'SMC-V2' is the current canonical name;
// 'V6-alt' is kept as a legacy alias so existing DB rows + scripts still
// type-check. New writes should use 'SMC-V2'.
export type StrategyVersion = 'V5.5b' | 'V6' | 'V6-alt' | 'SMC-V2';

/** True when the strategy is the live SMC engine — accepts both new and
 *  legacy names. Use this instead of `=== 'V6-alt'` in new code. */
export function isSmcV2(v: string | null | undefined): boolean {
  return v === 'SMC-V2' || v === 'V6-alt';
}

// V6: D1 trend bias for HTF confluence filter
export type D1Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

// V6: Volatility regime (ATR-percentile based)
export type VolatilityRegime = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

// V6: News event for blackout calendar
export interface NewsEvent {
  time: string;        // ISO 8601 UTC
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  currency: string;
}

// V6: Regime state machine output
export interface RegimeState {
  regime: DetailedRegime;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  durationBars: number;
  adx: number;
  adxSlope: number; // positive = rising, from 3-bar lookback
  diSeparation: number;
  atrRatio: number; // current ATR / baseline
  emaStackAligned: boolean;
  h1Idx: number;
  // V6 additions
  d1Bias?: D1Bias;
  volRegime?: VolatilityRegime;
  inNewsBlackout?: boolean;
}

// V6: Per-regime trade parameters
export interface RegimeTradeParams {
  trendTpR: number;       // Trend engine TP in R multiples
  fvgTpR: number;         // FVG engine TP in R multiples
  beThresholdR: number;   // Breakeven activation threshold in R
  tpRemovalR: number;     // Favorable move to remove TP (0 = never remove)
  slClampMaxAtr: number;  // Max SL distance in ATR multiples
}

export interface SimulatedPosition {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  slPrice: number;
  tpPrice: number | null;
  originalSlPrice: number;
  breakevenActivated: boolean;
  peakFavorablePrice: number;
  lotSize: number;
  entryTime: string;
  entryIndex: number;
  setupTags: string[];
  h1Bias: string;
  rsiAtEntry: number;
  atrAtEntry: number;
  // V6: Regime-adaptive trailing config
  trailConfig?: RegimeTradeParams;
  regimeAtEntry?: DetailedRegime;
  // V6: Scale-in tracking
  isScaleIn?: boolean;
  parentEntryPrice?: number;
  hasScaleIn?: boolean;
}

export interface ClosedTrade {
  side: string;
  entryPrice: number;
  exitPrice: number;
  slPrice: number;
  tpPrice: number | null;
  lotSize: number;
  pnl: number;
  commission: number;
  setupTags: string[];
  entryTime: string;
  exitTime: string;
  exitReason: 'SL' | 'TP' | 'BREAKEVEN' | 'FORCED_CLOSE';
  h1Bias: string;
  rsiAtEntry: number;
  atrAtEntry: number;
  // V6: Performance tracking fields
  rMultiple?: number;
  regimeAtEntry?: DetailedRegime;
  engineType?: EngineType;
}

export interface BacktestRiskState {
  balance: number;
  equity: number;
  dailyPnl: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  lastTradeDate: string | null;
}

export interface EngineConfig {
  symbol: string;
  initialBalance: number;
  riskPercent: number;
  maxDailyLossPercent: number;
  maxConsecutiveLosses: number;
  maxOpenPositions: number;
  // V6: Selects which strategy version to run. Default 'V5.5b' for backward compat.
  strategyVersion?: StrategyVersion;
}

export interface BacktestMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  avgWin: number;
  avgLoss: number;
  avgRR: number;
  largestWin: number;
  largestLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  totalCommission: number;
  finalBalance: number;
  returnPercent: number;
}

export interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

export interface BOSEvent {
  direction: 'BUY' | 'SELL';
  brokenLevel: number;
  candleIndex: number;
}

export type SetupType = 'TREND_PULLBACK' | 'RANGE_REVERSION' | 'BOS_RETEST' | 'FVG_FILL' | 'MOMENTUM_CONT';

export interface BOSLevel {
  direction: 'BUY' | 'SELL';
  brokenLevel: number;
  breakIndex: number;
  traded: boolean;
  expiryCandles: number; // 32 = 8 hours
}

export interface FairValueGap {
  direction: 'BUY' | 'SELL';
  zoneHigh: number;
  zoneLow: number;
  createdAtIndex: number;
  expiryCandles: number; // 48 = 12 hours
  traded: boolean;
}

export interface SwingPointTracker {
  recentHighs: SwingPoint[];
  recentLows: SwingPoint[];
}

export interface EngineState {
  swingTracker: SwingPointTracker;
  activeBOSLevels: BOSLevel[];
  activeFVGs: FairValueGap[];
}
