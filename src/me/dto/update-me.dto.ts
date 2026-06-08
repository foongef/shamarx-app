import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PresetKey } from '@prisma/client';

export class UpdateMeDto {
  @IsOptional()
  @IsBoolean()
  botEnabled?: boolean;

  @IsOptional()
  @IsEnum(PresetKey)
  presetKey?: PresetKey;
}
