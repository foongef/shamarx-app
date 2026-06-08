import { IsEnum, IsString, MinLength } from 'class-validator';
import { PresetKey } from '@prisma/client';

export class AcceptInviteDto {
  @IsString()
  @MinLength(8)
  password!: string;

  @IsEnum(PresetKey)
  presetKey!: PresetKey;
}
