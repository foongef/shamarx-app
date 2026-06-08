import { IsString, MaxLength } from 'class-validator';

export class UpdateDayNoteDto {
  @IsString()
  @MaxLength(5000)
  note: string;
}
