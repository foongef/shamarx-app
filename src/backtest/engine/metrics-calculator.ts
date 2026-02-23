import { ClosedTrade, BacktestMetrics } from './types';

export function calculateMetrics(
  trades: ClosedTrade[],
  initialBalance: number,
): BacktestMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winCount: 0,
      lossCount: 0,
      breakevenCount: 0,
      winRate: 0,
      totalPnl: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      avgWin: 0,
      avgLoss: 0,
      avgRR: 0,
      largestWin: 0,
      largestLoss: 0,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      totalCommission: 0,
      finalBalance: initialBalance,
      returnPercent: 0,
    };
  }

  const breakevenTrades = trades.filter((t) => t.exitReason === 'BREAKEVEN');
  const decisiveTrades = trades.filter((t) => t.exitReason !== 'BREAKEVEN');
  const wins = decisiveTrades.filter((t) => t.pnl > 0);
  const losses = decisiveTrades.filter((t) => t.pnl <= 0);

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  // Max drawdown
  let peak = initialBalance;
  let maxDD = 0;
  let maxDDPercent = 0;
  let runningBalance = initialBalance;

  for (const trade of trades) {
    runningBalance += trade.pnl;
    if (runningBalance > peak) {
      peak = runningBalance;
    }
    const dd = peak - runningBalance;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPercent = (dd / peak) * 100;
    }
  }

  // Sharpe ratio (annualized, assuming ~252 trading days, ~4 trades/day avg)
  const returns = trades.map((t) => t.pnl);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
    returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio =
    stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Consecutive wins/losses (skip breakeven trades)
  let maxConsWins = 0;
  let maxConsLosses = 0;
  let curConsWins = 0;
  let curConsLosses = 0;

  for (const trade of trades) {
    if (trade.exitReason === 'BREAKEVEN') continue; // skip BE for streaks
    if (trade.pnl > 0) {
      curConsWins++;
      curConsLosses = 0;
      if (curConsWins > maxConsWins) maxConsWins = curConsWins;
    } else {
      curConsLosses++;
      curConsWins = 0;
      if (curConsLosses > maxConsLosses) maxConsLosses = curConsLosses;
    }
  }

  const totalCommission = trades.reduce((sum, t) => sum + t.commission, 0);
  const finalBalance = initialBalance + totalPnl;

  return {
    totalTrades: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    breakevenCount: breakevenTrades.length,
    winRate: decisiveTrades.length > 0
      ? Math.round((wins.length / decisiveTrades.length) * 10000) / 100
      : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    profitFactor:
      grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? Infinity : 0,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownPercent: Math.round(maxDDPercent * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    avgWin: wins.length > 0 ? Math.round((grossProfit / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length > 0 ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
    avgRR: losses.length > 0 && grossLoss > 0
      ? Math.round(((grossProfit / wins.length || 0) / (grossLoss / losses.length)) * 100) / 100
      : 0,
    largestWin: wins.length > 0 ? Math.round(Math.max(...wins.map((t) => t.pnl)) * 100) / 100 : 0,
    largestLoss: losses.length > 0 ? Math.round(Math.min(...losses.map((t) => t.pnl)) * 100) / 100 : 0,
    maxConsecutiveWins: maxConsWins,
    maxConsecutiveLosses: maxConsLosses,
    totalCommission: Math.round(totalCommission * 100) / 100,
    finalBalance: Math.round(finalBalance * 100) / 100,
    returnPercent: Math.round(((finalBalance - initialBalance) / initialBalance) * 10000) / 100,
  };
}
