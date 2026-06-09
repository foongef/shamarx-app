export type FlagSeverity = 'loss' | 'signal' | 'neutral';

export interface Flag {
  name: 'DD_ALERT' | 'DAILY_LOSS_HIT' | 'BROKER_DOWN' | 'PAUSE_WATCH' | 'INACTIVE_USER' | 'NO_ACCOUNTS';
  severity: FlagSeverity;
  userId: string;
  userEmail: string;
  message: string;
  detail?: string;
}

export interface Trend {
  name: 'WR_DRIFT' | 'EXPECTANCY_DRIFT' | 'PAIR_DIVERGENCE' | 'PRESET_DIVERGENCE';
  direction: 'up' | 'down';
  magnitude: number;
  sampleSize: number;
  recommendation: string;
}

export type StrategyStatus = 'HEALTHY' | 'WATCHING' | 'DEGRADED';
