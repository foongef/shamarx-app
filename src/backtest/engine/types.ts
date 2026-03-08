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
