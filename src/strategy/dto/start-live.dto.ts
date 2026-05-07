import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class StartLiveDto {
  // 'SMC-V2' is the current name; 'V6-alt' kept as legacy alias.
  @IsIn(['SMC-V2', 'V6-alt'])
  strategyVersion!: 'SMC-V2' | 'V6-alt';

  @IsNumber()
  @Min(0.25)
  @Max(4.0)
  riskPercent!: number;

  @IsIn(['mock', 'metaapi'])
  mode!: 'mock' | 'metaapi';

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(1_000_000)
  mockBalance?: number;
}
