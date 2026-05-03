'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { BacktestRun } from '@/lib/types';

export function useBacktests() {
  return useQuery<BacktestRun[]>({
    queryKey: ['backtests'],
    queryFn: () => api.listBacktests(),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (data?.some((r) => r.status === 'PENDING' || r.status === 'RUNNING')) return 3000;
      return false;
    },
  });
}
