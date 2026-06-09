import { IsInt, IsString } from 'class-validator';

export class OAuthTokensDto {
  @IsString()
  accessToken!: string;

  @IsString()
  refreshToken!: string;

  @IsInt()
  expiresAt!: number;
}
