import { Module } from '@nestjs/common';
import { InviteService } from './invite.service';
import { PrismaModule } from '@app/prisma';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, MailModule, AuthModule],
  providers: [InviteService],
  exports: [InviteService],
})
export class InviteModule {}
