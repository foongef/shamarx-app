import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class FinalizeOAuthDto {
  @IsString()
  oauthSessionId!: string;

  @IsInt()
  ctidTraderAccountId!: number;

  @IsString()
  @MaxLength(60)
  name!: string;

  @IsBoolean()
  @IsOptional()
  isEnabled?: boolean;
}
