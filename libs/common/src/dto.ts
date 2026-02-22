import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Side, Bias, LlmDecisionType } from './enums';

export class CandleDto {
  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ example: 'M15' })
  timeframe: string;

  @ApiProperty({ example: '2025-01-15T10:00:00Z' })
  openTime: string;

  @ApiProperty({ example: 2665.5 })
  open: number;

  @ApiProperty({ example: 2668.0 })
  high: number;

  @ApiProperty({ example: 2664.0 })
  low: number;

  @ApiProperty({ example: 2667.0 })
  close: number;

  @ApiProperty({ example: 1250 })
  volume: number;
}

export class CandidateTradeDto {
  @ApiPropertyOptional({ example: 'uuid-123' })
  id?: string;

  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ enum: Side, example: Side.BUY })
  side: Side;

  @ApiProperty({ example: 2665.0 })
  entryPrice: number;

  @ApiProperty({ example: 2660.0 })
  slPrice: number;

  @ApiProperty({ example: 2675.0 })
  tpPrice: number;

  @ApiProperty({ example: 50 })
  slPoints: number;

  @ApiProperty({ example: 100 })
  tpPoints: number;

  @ApiProperty({ example: ['BOS', 'PULLBACK_EMA20'] })
  setupTags: string[];

  @ApiProperty({ enum: Bias, example: Bias.BULLISH })
  h1Bias: Bias;

  @ApiProperty({ example: 55.3 })
  rsiValue: number;

  @ApiProperty({ example: 12.5 })
  atrValue: number;

  @ApiProperty({ example: 2.5 })
  spreadAtDetection: number;

  @ApiProperty({ example: 'M15' })
  timeframe: string;
}

export class LlmValidationRequest {
  @ApiProperty({ type: CandidateTradeDto })
  candidate: CandidateTradeDto;
}

export class LlmValidationResponse {
  @ApiProperty({ enum: LlmDecisionType, example: LlmDecisionType.ALLOW })
  decision: LlmDecisionType;

  @ApiProperty({ example: 0.85 })
  confidence: number;

  @ApiProperty({ example: 'Trade aligns with H1 bullish bias and BOS confirmed' })
  reasoning: string;

  @ApiProperty({ example: ['market_snapshot', 'sr_levels'] })
  toolsUsed: string[];
}

export class MarketSnapshotDto {
  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ example: 'M15' })
  timeframe: string;

  @ApiProperty({ example: 2665.5 })
  currentPrice: number;

  @ApiProperty({ example: 2663.0 })
  ema20: number;

  @ApiProperty({ example: 2660.0 })
  ema50: number;

  @ApiProperty({ example: 2640.0 })
  ema200: number;

  @ApiProperty({ example: 55.3 })
  rsi14: number;

  @ApiProperty({ example: 12.5 })
  atr14: number;

  @ApiProperty({ type: CandleDto, nullable: true })
  lastCandle: CandleDto | null;
}

export class StructureContextDto {
  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ enum: Bias, example: Bias.BULLISH })
  h1Bias: Bias;

  @ApiProperty({ example: [2670.0, 2680.0] })
  recentSwingHighs: number[];

  @ApiProperty({ example: [2650.0, 2645.0] })
  recentSwingLows: number[];

  @ApiProperty({ enum: Side, nullable: true, example: Side.BUY })
  lastBosDirection: Side | null;
}

export class SRLevelDto {
  @ApiProperty({ example: 2670.0 })
  price: number;

  @ApiProperty({ example: 'RESISTANCE' })
  type: string;

  @ApiProperty({ example: 3 })
  strength: number;

  @ApiProperty({ example: 'H1' })
  timeframe: string;
}

export class SpreadStatsDto {
  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ example: 2.5 })
  currentSpread: number;

  @ApiProperty({ example: 2.8 })
  avgSpread1h: number;

  @ApiProperty({ example: 5.0 })
  maxSpread1h: number;

  @ApiProperty({ example: false })
  isHighSpread: boolean;
}

export class EconomicEventDto {
  @ApiProperty({ example: 'Non-Farm Payrolls' })
  title: string;

  @ApiProperty({ example: 'USD' })
  country: string;

  @ApiProperty({ example: 'HIGH' })
  impact: string;

  @ApiProperty({ example: '2025-01-15T13:30:00Z' })
  eventTime: string;
}

export class EconomicRiskDto {
  @ApiProperty({ type: [EconomicEventDto] })
  upcomingHighImpact: EconomicEventDto[];

  @ApiProperty({ example: false })
  isHighRiskPeriod: boolean;

  @ApiProperty({ example: 45, nullable: true })
  minutesToNextHighImpact: number | null;
}

export class RiskStateDto {
  @ApiProperty({ example: '2025-01-15' })
  date: string;

  @ApiProperty({ example: 10000 })
  balance: number;

  @ApiProperty({ example: 10050 })
  equity: number;

  @ApiProperty({ example: 150.0 })
  dailyPnl: number;

  @ApiProperty({ example: 1.5 })
  dailyPnlPercent: number;

  @ApiProperty({ example: 0 })
  consecutiveLosses: number;

  @ApiProperty({ example: 1 })
  openPositionCount: number;

  @ApiProperty({ example: 3.0 })
  maxDailyLossPercent: number;

  @ApiProperty({ example: 2 })
  maxOpenPositions: number;

  @ApiProperty({ example: 3 })
  maxConsecutiveLosses: number;

  @ApiProperty({ example: 1.0 })
  riskPerTradePercent: number;

  @ApiProperty({ example: 5.0 })
  maxSpreadPoints: number;

  @ApiProperty({ example: false })
  dailyLossLimitHit: boolean;

  @ApiProperty({ example: false })
  consecutiveLossLimitHit: boolean;

  @ApiProperty({ example: true })
  canTrade: boolean;
}

export class AccountInfoDto {
  @ApiProperty({ example: 10000 })
  balance: number;

  @ApiProperty({ example: 10050 })
  equity: number;

  @ApiProperty({ example: 500 })
  margin: number;

  @ApiProperty({ example: 9550 })
  freeMargin: number;

  @ApiProperty({ example: 1 })
  openPositions: number;
}

export class OrderRequestDto {
  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ enum: Side, example: Side.BUY })
  side: Side;

  @ApiProperty({ example: 0.1 })
  lotSize: number;

  @ApiProperty({ example: 2665.0 })
  entryPrice: number;

  @ApiProperty({ example: 2660.0 })
  slPrice: number;

  @ApiProperty({ example: 2675.0 })
  tpPrice: number;

  @ApiPropertyOptional({ example: 'BOS+EMA20 pullback' })
  comment?: string;
}

export class OrderResponseDto {
  @ApiProperty({ example: 'order-uuid-123' })
  orderId: string;

  @ApiProperty({ example: 12345678, nullable: true })
  mt5Ticket: number | null;

  @ApiProperty({ example: 'FILLED' })
  status: string;

  @ApiProperty({ example: 'Order filled successfully' })
  message: string;
}

export class PositionDto {
  @ApiProperty({ example: 12345678 })
  ticket: number;

  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ example: 'BUY' })
  side: string;

  @ApiProperty({ example: 0.1 })
  lotSize: number;

  @ApiProperty({ example: 2665.0 })
  entryPrice: number;

  @ApiProperty({ example: 2667.5 })
  currentPrice: number;

  @ApiProperty({ example: 2660.0 })
  sl: number;

  @ApiProperty({ example: 2675.0 })
  tp: number;

  @ApiProperty({ example: 25.0 })
  pnl: number;

  @ApiProperty({ example: '2025-01-15T10:30:00Z' })
  openTime: string;
}

export class LotSizeRequest {
  @ApiProperty({ example: 10000 })
  balance: number;

  @ApiProperty({ example: 1.0 })
  riskPercent: number;

  @ApiProperty({ example: 50 })
  slPoints: number;
}

export class LotSizeResponse {
  @ApiProperty({ example: 0.1 })
  lotSize: number;

  @ApiProperty({ example: 100 })
  riskAmount: number;
}
