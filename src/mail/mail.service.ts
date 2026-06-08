import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';

export interface TradeOpenedPayload {
  symbol: string;
  side: 'BUY' | 'SELL';
  mode: string;            // REVERSAL / CONTINUATION
  lotSize: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number | null;
  riskPercent: number;
  reason: string;          // SmcLiveSignal.reason — concise human-readable
  openedAtIso: string;     // when the trade fired
  dashboardUrl: string;    // link to the live session view
}

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

  /**
   * Notify a user that the engine just opened a trade. Fire-and-forget from
   * the caller's perspective — failures log but don't propagate (an email
   * outage must not block live execution).
   */
  async sendTradeOpened(email: string, payload: TradeOpenedPayload): Promise<void> {
    const sideLabel = payload.side === 'BUY' ? 'LONG' : 'SHORT';
    const subject = `Trade opened · ${payload.symbol} ${sideLabel} @ ${payload.entryPrice}`;
    try {
      await this.mailer.sendMail({
        to: email,
        subject,
        template: 'trade-opened',
        context: {
          ...payload,
          sideLabel,
          // Pretty timestamp pre-formatted for the template (HH:MM UTC, YYYY-MM-DD)
          openedAtPretty: this.formatUtc(payload.openedAtIso),
          // Direction-tinted accent for the heading bar
          accentColor: payload.side === 'BUY' ? '#22c55e' : '#ef4444',
          // Risk shown as a short string
          riskLabel: `${payload.riskPercent.toFixed(2)}%`,
          tpDisplay: payload.tpPrice == null ? 'open' : payload.tpPrice.toFixed(5),
        },
      });
      this.logger.log(`Trade-opened email sent to ${email} (${payload.symbol} ${sideLabel})`);
    } catch (err) {
      this.logger.warn(`Failed to send trade-opened to ${email}: ${(err as Error).message}`);
      // No throw — caller (live strategy) must keep moving.
    }
  }

  async sendInvite(email: string, url: string): Promise<void> {
    try {
      await this.mailer.sendMail({
        to: email,
        subject: "You're invited to Shamarx",
        template: 'invite',
        context: { url },
      });
      this.logger.log(`Invite email sent to ${email}`);
    } catch (err) {
      this.logger.error(`Failed to send invite to ${email}`, err);
      throw err;
    }
  }

  private formatUtc(iso: string): string {
    const d = new Date(iso);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mi} UTC · ${yyyy}-${mm}-${dd}`;
  }
}
