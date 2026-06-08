import { IsEmail, IsInt, IsOptional, Min, Max } from 'class-validator';

export class CreateInviteDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number;
}
