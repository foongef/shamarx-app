'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { BacktestRun } from '@/lib/types';

export function useBacktest(id: string) {
  return useQuery<BacktestRun>({
    queryKey: ['backtest', id],
    queryFn: () => api.getBacktest(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'PENDING' || status === 'RUNNING') return 2000;
      return false;
    },
  });
}
