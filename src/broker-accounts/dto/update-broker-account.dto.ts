import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateBrokerAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsIn(['metaapi', 'mock'])
  mode?: 'metaapi' | 'mock';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortIndex?: number;
}
