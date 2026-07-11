import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

const DEFAULT_PAIRS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];

export class StartReplayDto {
  @ApiProperty({ example: '2026-04-01' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-05-01' })
  @IsDateString()
  endDate!: string;

  @ApiProperty({ example: 10000, description: 'Starting account balance ($).' })
  @IsNumber()
  @Min(100)
  initialBalance!: number;

  @ApiProperty({ example: 1.5, description: 'Risk per trade (%).' })
  @IsNumber()
  @Min(0.1)
  riskPercent!: number;

  @ApiPropertyOptional({
    example: DEFAULT_PAIRS,
    description: 'Pairs to replay. Defaults to all 4 SMC pairs.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pairs?: string[];

  @ApiPropertyOptional({
    description:
      'Exit-experiment override for the RUNNER trail (A/B testing) — e.g. {"beThresholdR":2,"trailWidthMult":1.3}. Replay-only.',
  })
  @IsOptional()
  runnerTrail?: Record<string, number>;

  @ApiPropertyOptional({
    description:
      'Entry-experiment (replay-only): {"frac":0.5,"expiryBars":6} — limit at frac of entry→SL distance, cancelled after expiryBars M15 bars.',
  })
  @IsOptional()
  retraceEntry?: { frac: number; expiryBars: number };

  @ApiPropertyOptional({
    description:
      'Experiment-only per-pair config overrides, e.g. {"GBPUSD":{"disableContinuation":true,"killzones":[[7,8],[9,11]]}}. Applied in the replay worker only.',
  })
  @IsOptional()
  pairConfigOverrides?: Record<string, Record<string, unknown>>;

  @ApiPropertyOptional({ description: 'Human-readable experiment label shown in History.' })
  @IsOptional()
  @IsString()
  label?: string;
}

export const REPLAY_DEFAULT_PAIRS = DEFAULT_PAIRS;
