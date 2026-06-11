import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { MetaApiCredsDto, Mt5DirectCredsDto } from './broker-creds.dto';

export class CreateBrokerAccountDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsIn(['METAAPI', 'MOCK', 'CTRADER', 'MT5_DIRECT'])
  broker!: 'METAAPI' | 'MOCK' | 'CTRADER' | 'MT5_DIRECT';

  @IsIn(['metaapi', 'mock'])
  mode!: 'metaapi' | 'mock';

  /**
   * Present for METAAPI + MOCK ({accountId, accessToken}) and MT5_DIRECT
   * ({login, password, server}). CTRADER uses oauthSessionId instead.
   * class-validator can't discriminate a union on a sibling field, so the
   * per-broker shape check lives in BrokerAccountsService.validateCreds().
   */
  @IsOptional()
  @IsObject()
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
