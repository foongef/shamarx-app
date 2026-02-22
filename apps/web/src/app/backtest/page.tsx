import { BacktestForm } from '@/components/backtest/backtest-form';

export default function BacktestPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Backtest</h1>
        <p className="text-muted-foreground">
          Configure and run a historical backtest on XAUUSD.
        </p>
      </div>
      <BacktestForm />
    </div>
  );
}
