import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class TestTradeDto {
  @IsString()
  symbol!: string;

  @IsOptional()
  @IsIn(['BUY', 'SELL'])
  side?: 'BUY' | 'SELL';

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1.0)
  lotSize?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.25)
  @Max(5)
  slAtrMult?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(10)
  tpRMult?: number;
}
