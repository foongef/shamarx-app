import { IsString, MaxLength } from 'class-validator';

export class MetaApiCredsDto {
  @IsString()
  @MaxLength(128)
  accountId!: string;

  @IsString()
  @MaxLength(1024)
  accessToken!: string;
}
