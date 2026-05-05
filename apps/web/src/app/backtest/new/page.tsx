import { BacktestForm } from '@/components/backtest/backtest-form';

export default function NewBacktestPage() {
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-8 pb-12">
      <header className="flex flex-col gap-1.5 border-b border-border pb-6">
        <span className="label-eyebrow">
          <span className="text-signal">◆</span>&nbsp;Submit Run
        </span>
        <h1 className="display-serif text-[32px] leading-[0.95] tracking-[0.04em] sm:text-[40px]">
          Compose a <span className="text-signal">new</span> backtest.
        </h1>
        <p className="max-w-2xl text-[13px] text-muted-foreground">
          Select strategy, instrument and account profile. The engine will
          run the M15 walk-forward against real Dukascopy data and stream the
          result back to your library when complete.
        </p>
      </header>
      <BacktestForm />
    </div>
  );
}
