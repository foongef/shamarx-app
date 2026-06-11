import { IsString, MaxLength } from 'class-validator';

export class MetaApiCredsDto {
  @IsString()
  @MaxLength(128)
  accountId!: string;

  @IsString()
  @MaxLength(1024)
  accessToken!: string;
}

export class Mt5DirectCredsDto {
  @IsString()
  @MaxLength(32)
  login!: string;

  @IsString()
  @MaxLength(128)
  password!: string;

  /** MT5 server name, e.g. "ICMarketsSC-Demo". */
  @IsString()
  @MaxLength(128)
  server!: string;
}
