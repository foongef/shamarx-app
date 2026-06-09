import { IsString } from 'class-validator';

export class CallbackDto {
  @IsString()
  code!: string;

  @IsString()
  state!: string;
}
