export interface BacktestMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
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

export type BacktestStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface BacktestRun {
  id: string;
  startDate: string;
  endDate: string;
  initialBalance: number;
  riskPercent: number;
  withLlm: boolean;
  status: BacktestStatus;
  metrics: BacktestMetrics | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface BacktestTrade {
  id: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  slPrice: number;
  tpPrice: number;
  lotSize: number;
  pnl: number;
  commission: number;
  setupTags: string[];
  entryTime: string;
  exitTime: string;
  exitReason: string;
  h1Bias: string;
  rsiAtEntry: number;
  atrAtEntry: number;
}

export interface BacktestCandle {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CreateBacktestInput {
  startDate: string;
  endDate: string;
  initialBalance: number;
  riskPercent: number;
  withLlm?: boolean;
}

export interface CreateBacktestResponse {
  id: string;
  status: string;
}
