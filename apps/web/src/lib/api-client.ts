import type {
  BacktestRun,
  BacktestTrade,
  BacktestCandle,
  CreateBacktestInput,
  CreateBacktestResponse,
} from './types';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:9000';

export interface AuthUser {
  id: string;
  email: string;
  role: 'SUPERADMIN' | 'ADMIN' | 'USER';
}

export interface LiveStatus {
  enabled: boolean;
  running: boolean;
  mt5Mode: 'mock' | 'metaapi';
  pairs: string[];
  riskPercent: number;
  strategyVersion?: string;
  mockBalance?: number | null;
  lastChangedAt: string | null;
  account?: {
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    openPositions: number;
  } | null;
}

export interface LivePosition {
  ticket: number;
  symbol: string;
  side: string;
  lotSize: number;
  entryPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  pnl: number;
  openTime: string;
}

export interface LiveCandle {
  symbol: string;
  timeframe: string;
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LiveTrade {
  id: string;
  symbol: string;
  side: string;
  lotSize: number;
  entryPrice: number;
  closePrice: number | null;
  slPrice: number;
  tpPrice: number;
  status: string;
  exitReason: string | null;
  pnl: number | null;
  closedAt: string | null;
  createdAt: string;
}

export interface PairStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

export interface LiveStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  realizedPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  avgRR: number;
  largestWin: number;
  largestLoss: number;
  exitReasons: Record<string, number>;
  perPair: Record<string, PairStats>;
}

export interface EquityPoint {
  t: string;
  balance: number;
  equity: number;
  unrealizedPnl: number;
  openPositions: number;
}

export interface LoopHealth {
  verdict: string;
  healthy: boolean;
  executionReachable: boolean;
  executionMode: string;
  pairs: Array<{
    symbol: string;
    lastCandleOpenTime: string | null;
    lastIngestedAt: string | null;
    ageSec: number | null;
  }>;
  checkedAt: string;
}

export interface LiveSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  strategyVersion: string;
  riskPercent: number;
  mode: 'mock' | 'metaapi';
  mockBalance: number | null;
  startEquity: number;
  endEquity: number | null;
  realizedPnl: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
  status: 'RUNNING' | 'ENDED' | 'CRASHED';
  pairs: string[];
}

class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

export { ApiError };

export const api = {
  // Auth
  login(email: string, password: string) {
    return request<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  logout() {
    return request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
  },

  me() {
    return request<{ user: AuthUser }>('/api/auth/me');
  },

  refresh() {
    return request<{ user: AuthUser | null }>('/api/auth/refresh', { method: 'POST' });
  },

  forgotPassword(email: string) {
    return request<{ ok: true }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  validateResetToken(token: string) {
    return request<{ valid: boolean; reason?: string }>(
      `/api/auth/validate-reset-token?token=${encodeURIComponent(token)}`,
    );
  },

  resetPassword(token: string, password: string) {
    return request<{ ok: true }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  },

  // Live trading
  liveStatus() {
    return request<LiveStatus>('/api/strategy/live/status');
  },

  liveStart(config: {
    strategyVersion: 'V6-alt';
    riskPercent: number;
    mode: 'mock' | 'metaapi';
    mockBalance?: number;
  }) {
    return request<LiveStatus>('/api/strategy/live/start', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  liveStop() {
    return request<LiveStatus>('/api/strategy/live/stop', { method: 'POST' });
  },

  livePositions() {
    return request<{ positions: LivePosition[]; error?: string }>(
      '/api/strategy/live/positions',
    );
  },

  liveCandles(symbol: string, timeframe = 'M15', count = 100) {
    return request<{ candles: LiveCandle[]; error?: string }>(
      `/api/strategy/live/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&count=${count}`,
    );
  },

  liveRecentTrades(limit = 20) {
    return request<{ trades: LiveTrade[] }>(
      `/api/strategy/live/recent-trades?limit=${limit}`,
    );
  },

  liveTrades(opts: {
    status?: 'OPEN' | 'CLOSED' | 'ALL';
    symbol?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    return request<{ trades: LiveTrade[]; total: number; limit: number; offset: number }>(
      `/api/strategy/live/trades?${q}`,
    );
  },

  liveStats(days = 30) {
    return request<LiveStats>(`/api/strategy/live/stats?days=${days}`);
  },

  liveEquityHistory(hours = 24) {
    return request<{ points: EquityPoint[] }>(
      `/api/strategy/live/equity-history?hours=${hours}`,
    );
  },

  liveLoopHealth() {
    return request<LoopHealth>('/api/strategy/live/loop-health');
  },

  liveSessions(limit = 50) {
    return request<{ sessions: LiveSession[] }>(
      `/api/strategy/live/sessions?limit=${limit}`,
    );
  },

  liveSession(id: string) {
    return request<{ session: LiveSession | null }>(`/api/strategy/live/sessions/${id}`);
  },

  liveSessionTrades(id: string) {
    return request<{ trades: LiveTrade[] }>(`/api/strategy/live/sessions/${id}/trades`);
  },

  liveSessionStats(id: string) {
    return request<LiveStats>(`/api/strategy/live/sessions/${id}/stats`);
  },

  liveEquityHistoryForSession(sessionId: string) {
    return request<{ points: EquityPoint[] }>(
      `/api/strategy/live/equity-history?sessionId=${encodeURIComponent(sessionId)}`,
    );
  },

  liveEvaluate(symbol: string) {
    return request<{ symbol: string; signal: unknown }>(
      `/api/strategy/live/evaluate/${encodeURIComponent(symbol)}`,
      { method: 'POST' },
    );
  },

  liveReconcile() {
    return request<{ ok: true }>('/api/strategy/live/reconcile', { method: 'POST' });
  },

  liveTestTrade(opts: {
    symbol: string;
    side?: 'BUY' | 'SELL';
    lotSize?: number;
    slAtrMult?: number;
    tpRMult?: number;
  }) {
    return request<{ signal: { reason: string; entryPrice: number; slPrice: number; tpPrice: number } }>(
      '/api/strategy/live/test-trade',
      { method: 'POST', body: JSON.stringify(opts) },
    );
  },

  // Backtest
  listBacktests() {
    return request<BacktestRun[]>('/api/backtest');
  },

  createBacktest(input: CreateBacktestInput) {
    return request<CreateBacktestResponse>('/api/backtest', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getBacktest(id: string) {
    return request<BacktestRun>(`/api/backtest/${id}`);
  },

  getBacktestTrades(id: string) {
    return request<BacktestTrade[]>(`/api/backtest/${id}/trades`);
  },

  getBacktestCandles(id: string) {
    return request<BacktestCandle[]>(`/api/backtest/${id}/candles`);
  },
};
