'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { BacktestTrade } from '@/lib/types';

export function useBacktestTrades(id: string, enabled: boolean) {
  return useQuery<BacktestTrade[]>({
    queryKey: ['backtest', id, 'trades'],
    queryFn: () => api.getBacktestTrades(id),
    enabled,
  });
}
