'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCreateBacktest } from '@/hooks/use-create-backtest';
import { Loader2 } from 'lucide-react';

const schema = z.object({
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  initialBalance: z.coerce.number().min(100).max(1_000_000),
  riskPercent: z.coerce.number().min(0.1).max(10),
  withLlm: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

export function BacktestForm() {
  const { mutate, isPending } = useCreateBacktest();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      initialBalance: 10000,
      riskPercent: 1.0,
      withLlm: false,
    },
  });

  const withLlm = watch('withLlm');

  function onSubmit(data: FormValues) {
    mutate(data);
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Run Backtest</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="startDate">Start Date</Label>
              <Input id="startDate" type="date" {...register('startDate')} />
              {errors.startDate && (
                <p className="text-sm text-destructive">{errors.startDate.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="endDate">End Date</Label>
              <Input id="endDate" type="date" {...register('endDate')} />
              {errors.endDate && (
                <p className="text-sm text-destructive">{errors.endDate.message}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="initialBalance">Initial Balance ($)</Label>
              <Input
                id="initialBalance"
                type="number"
                step="100"
                {...register('initialBalance')}
              />
              {errors.initialBalance && (
                <p className="text-sm text-destructive">{errors.initialBalance.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="riskPercent">Risk per Trade (%)</Label>
              <Input
                id="riskPercent"
                type="number"
                step="0.1"
                {...register('riskPercent')}
              />
              {errors.riskPercent && (
                <p className="text-sm text-destructive">{errors.riskPercent.message}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id="withLlm"
              checked={withLlm}
              onCheckedChange={(checked) => setValue('withLlm', checked)}
            />
            <Label htmlFor="withLlm">Enable LLM Filter</Label>
          </div>

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isPending ? 'Creating...' : 'Run Backtest'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
