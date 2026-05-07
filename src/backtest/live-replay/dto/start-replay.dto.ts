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
}

export const REPLAY_DEFAULT_PAIRS = DEFAULT_PAIRS;
