import { IsDateString, IsNumber, IsBoolean, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBacktestDto {
  @ApiProperty({ example: '2025-01-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2025-01-31' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ example: 10000, minimum: 1000, maximum: 1000000 })
  @Type(() => Number)
  @IsNumber()
  @Min(1000)
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
}
