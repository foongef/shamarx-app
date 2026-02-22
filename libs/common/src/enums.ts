export enum Side {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum Timeframe {
  M1 = 'M1',
  M5 = 'M5',
  M15 = 'M15',
  H1 = 'H1',
  H4 = 'H4',
  D1 = 'D1',
}

export enum Bias {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL',
}

export enum TradeStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export enum CandidateStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum LlmDecisionType {
  ALLOW = 'ALLOW',
  REJECT = 'REJECT',
}

export enum ImpactLevel {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export enum SRType {
  SUPPORT = 'SUPPORT',
  RESISTANCE = 'RESISTANCE',
}

export enum SetupTag {
  BOS = 'BOS',
  PULLBACK_EMA20 = 'PULLBACK_EMA20',
  PULLBACK_EMA50 = 'PULLBACK_EMA50',
  ENGULFING = 'ENGULFING',
  STRONG_CLOSE = 'STRONG_CLOSE',
  RSI_ALIGNED = 'RSI_ALIGNED',
  H1_BIAS_ALIGNED = 'H1_BIAS_ALIGNED',
}

export enum IndicatorName {
  EMA20 = 'EMA20',
  EMA50 = 'EMA50',
  EMA200 = 'EMA200',
  RSI14 = 'RSI14',
  ATR14 = 'ATR14',
}
