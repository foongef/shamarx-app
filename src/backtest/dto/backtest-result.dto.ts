import { ApiProperty } from '@nestjs/swagger';
import { BacktestMetrics } from '../engine/types';

export class BacktestMetricsDto {
  @ApiProperty({ example: 50 })
  totalTrades: number;

  @ApiProperty({ example: 30 })
  winCount: number;

  @ApiProperty({ example: 20 })
  lossCount: number;

  @ApiProperty({ example: 3 })
  breakevenCount: number;

  @ApiProperty({ example: 0.6 })
  winRate: number;

  @ApiProperty({ example: 1250.0 })
  totalPnl: number;

  @ApiProperty({ example: 1.8 })
  profitFactor: number;

  @ApiProperty({ example: 500.0 })
  maxDrawdown: number;

  @ApiProperty({ example: 5.0 })
  maxDrawdownPercent: number;

  @ApiProperty({ example: 1.2 })
  sharpeRatio: number;

  @ApiProperty({ example: 75.0 })
  avgWin: number;

  @ApiProperty({ example: -45.0 })
  avgLoss: number;

  @ApiProperty({ example: 1.67 })
  avgRR: number;

  @ApiProperty({ example: 250.0 })
  largestWin: number;

  @ApiProperty({ example: -120.0 })
  largestLoss: number;

  @ApiProperty({ example: 5 })
  maxConsecutiveWins: number;

  @ApiProperty({ example: 3 })
  maxConsecutiveLosses: number;

  @ApiProperty({ example: 11250.0 })
  finalBalance: number;

  @ApiProperty({ example: 350.0 })
  totalCommission: number;

  @ApiProperty({ example: 12.5 })
  returnPercent: number;
}

export class BacktestTradeResult {
  @ApiProperty({ example: 'uuid-123' })
  id: string;

  @ApiProperty({ example: 'BUY' })
  side: string;

  @ApiProperty({ example: 2665.0 })
  entryPrice: number;

  @ApiProperty({ example: 2675.0 })
  exitPrice: number;

  @ApiProperty({ example: 2660.0 })
  slPrice: number;

  @ApiProperty({ example: 2675.0 })
  tpPrice: number;

  @ApiProperty({ example: 0.1 })
  lotSize: number;

  @ApiProperty({ example: 100.0 })
  pnl: number;

  @ApiProperty({ example: 0.7 })
  commission: number;

  @ApiProperty({ example: ['BOS', 'PULLBACK_EMA20'] })
  setupTags: string[];

  @ApiProperty({ example: '2025-01-15T10:00:00Z' })
  entryTime: string;

  @ApiProperty({ example: '2025-01-15T11:30:00Z' })
  exitTime: string;

  @ApiProperty({ example: 'TP' })
  exitReason: string;

  @ApiProperty({ example: 'BULLISH' })
  h1Bias: string;

  @ApiProperty({ example: 55.3 })
  rsiAtEntry: number;

  @ApiProperty({ example: 12.5 })
  atrAtEntry: number;
}

export class BacktestRunResult {
  @ApiProperty({ example: 'uuid-123' })
  id: string;

  @ApiProperty({ example: 'XAUUSD' })
  symbol: string;

  @ApiProperty({ example: '2025-01-01' })
  startDate: string;

  @ApiProperty({ example: '2025-01-31' })
  endDate: string;

  @ApiProperty({ example: 10000 })
  initialBalance: number;

  @ApiProperty({ example: 1.0 })
  riskPercent: number;

  @ApiProperty({ example: false })
  withLlm: boolean;

  @ApiProperty({ example: 'V6-alt', nullable: true, enum: ['V5.5b', 'V6', 'V6-alt'] })
  strategyVersion: string | null;

  @ApiProperty({ example: 'COMPLETED' })
  status: string;

  @ApiProperty({ type: BacktestMetricsDto, nullable: true })
  metrics: BacktestMetrics | null;

  @ApiProperty({ example: null, nullable: true })
  errorMessage: string | null;

  @ApiProperty({ example: '2025-01-15T10:00:00Z' })
  createdAt: string;

  @ApiProperty({ example: '2025-01-15T10:05:00Z', nullable: true })
  completedAt: string | null;
}
