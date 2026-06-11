import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MetaApiCredsDto, Mt5DirectCredsDto } from './broker-creds.dto';

export class CreateBrokerAccountDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsIn(['METAAPI', 'MOCK', 'CTRADER', 'MT5_DIRECT'])
  broker!: 'METAAPI' | 'MOCK' | 'CTRADER' | 'MT5_DIRECT';

  @IsIn(['metaapi', 'mock'])
  mode!: 'metaapi' | 'mock';

  /** Present for METAAPI + MOCK. CTRADER uses oauthSessionId + ctidTraderAccountId instead. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MetaApiCredsDto)
  creds?: MetaApiCredsDto | Mt5DirectCredsDto;

  /** CTRADER finalize shape — carried in the body for clients that POST through this DTO. */
  @IsOptional()
  @IsString()
  oauthSessionId?: string;

  @IsOptional()
  @IsInt()
  ctidTraderAccountId?: number;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
