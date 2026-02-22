'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { BacktestCandle } from '@/lib/types';

export function useBacktestCandles(id: string, enabled: boolean) {
  return useQuery<BacktestCandle[]>({
    queryKey: ['backtest', id, 'candles'],
    queryFn: () => api.getBacktestCandles(id),
    enabled,
  });
}
