import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly mailer: MailerService) {}

  async sendPasswordReset(email: string, resetUrl: string): Promise<void> {
    try {
      await this.mailer.sendMail({
        to: email,
        subject: 'Reset your password',
        template: 'reset-password',
        context: { email, resetUrl },
      });
      this.logger.log(`Password reset email sent to ${email}`);
    } catch (err) {
      this.logger.error(`Failed to send password reset to ${email}`, err);
      throw err;
    }
  }
}
