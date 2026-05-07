import { IsDateString, IsNumber, IsBoolean, IsOptional, IsIn, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const SUPPORTED_SYMBOLS = ['XAUUSD', 'GBPUSD', 'EURUSD', 'USDJPY', 'US30', 'NAS100'] as const;
// 'SMC-V2' is canonical; 'V6-alt' kept as legacy alias for back-compat.
const SUPPORTED_STRATEGIES = ['V5.5b', 'V6', 'V6-alt', 'SMC-V2'] as const;

export class CreateBacktestDto {
  @ApiPropertyOptional({ example: 'XAUUSD', default: 'XAUUSD', enum: SUPPORTED_SYMBOLS })
  @IsOptional()
  @IsString()
  @IsIn(SUPPORTED_SYMBOLS)
  symbol?: string = 'XAUUSD';

  @ApiProperty({ example: '2025-01-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2025-01-31' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ example: 10000, minimum: 100, maximum: 1000000 })
  @Type(() => Number)
  @IsNumber()
  @Min(100)
  @Max(1000000)
  initialBalance: number;

  @ApiProperty({ example: 1.0, minimum: 0.1, maximum: 10 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(10)
  riskPercent: number;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  withLlm?: boolean = false;

  @ApiPropertyOptional({
    example: 'SMC-V2',
    default: 'SMC-V2',
    enum: SUPPORTED_STRATEGIES,
    description: 'Strategy version: V5.5b = legacy baseline, V6 = evolved, SMC-V2 = SMC/order-flow (formerly V6-alt)',
  })
  @IsOptional()
  @IsString()
  @IsIn(SUPPORTED_STRATEGIES)
  strategyVersion?: 'V5.5b' | 'V6' | 'V6-alt' | 'SMC-V2' = 'SMC-V2';
}
