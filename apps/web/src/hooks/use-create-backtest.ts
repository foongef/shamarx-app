'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import type { CreateBacktestInput } from '@/lib/types';

export function useCreateBacktest() {
  const router = useRouter();

  return useMutation({
    mutationFn: (input: CreateBacktestInput) => api.createBacktest(input),
    onSuccess: (data) => {
      router.push(`/backtest/${data.id}`);
    },
  });
}
