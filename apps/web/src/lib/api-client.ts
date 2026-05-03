import type {
  BacktestRun,
  BacktestTrade,
  BacktestCandle,
  CreateBacktestInput,
  CreateBacktestResponse,
} from './types';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:9000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
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
