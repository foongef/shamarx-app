import { IsBoolean, IsIn, IsNotEmptyObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MetaApiCredsDto } from './broker-creds.dto';

export class CreateBrokerAccountDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsIn(['METAAPI', 'MOCK'])
  broker!: 'METAAPI' | 'MOCK';

  @IsIn(['metaapi', 'mock'])
  mode!: 'metaapi' | 'mock';

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => MetaApiCredsDto)
  creds!: MetaApiCredsDto;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
