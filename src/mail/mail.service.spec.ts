import { MailService, TradeOpenedPayload } from './mail.service';
import { MailerService } from '@nestjs-modules/mailer';

describe('MailService', () => {
  let service: MailService;
  let mailerService: MailerService;

  beforeEach(() => {
    mailerService = {
      sendMail: jest.fn().mockResolvedValue(undefined),
    } as unknown as MailerService;

    service = new MailService(mailerService);
  });

  describe('notifyTradeOpened scoping', () => {
    it('sends to the recipient email passed in payload', async () => {
      const sendSpy = jest.spyOn(mailerService, 'sendMail').mockResolvedValue(undefined as any);

      const payload: TradeOpenedPayload = {
        symbol: 'EURUSD',
        side: 'SELL',
        mode: 'REVERSAL',
        lotSize: 0.5,
        entryPrice: 1.0834,
        slPrice: 1.0856,
        tpPrice: 1.079,
        riskPercent: 1.0,
        reason: 'BOS below H1 OB',
        openedAtIso: '2024-01-15T09:00:00.000Z',
        dashboardUrl: 'https://shamarx.com/lives',
      };

      await service.sendTradeOpened('alice@example.com', payload);

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'alice@example.com' }),
      );
    });

    it('does NOT send to any other address', async () => {
      const sendSpy = jest.spyOn(mailerService, 'sendMail').mockResolvedValue(undefined as any);

      const payload: TradeOpenedPayload = {
        symbol: 'XAUUSD',
        side: 'BUY',
        mode: 'CONTINUATION',
        lotSize: 0.1,
        entryPrice: 2320.5,
        slPrice: 2305.0,
        tpPrice: 2350.0,
        riskPercent: 0.5,
        reason: 'sweep + BOS',
        openedAtIso: '2024-01-15T14:00:00.000Z',
        dashboardUrl: 'https://shamarx.com/lives',
      };

      await service.sendTradeOpened('bob@example.com', payload);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const callArg = sendSpy.mock.calls[0][0] as { to: string };
      expect(callArg.to).toBe('bob@example.com');
    });

    it('does not throw when mailer fails — swallows error', async () => {
      jest.spyOn(mailerService, 'sendMail').mockRejectedValue(new Error('SMTP timeout'));

      const payload: TradeOpenedPayload = {
        symbol: 'GBPUSD',
        side: 'SELL',
        mode: 'REVERSAL',
        lotSize: 0.2,
        entryPrice: 1.265,
        slPrice: 1.268,
        tpPrice: null,
        riskPercent: 1.0,
        reason: 'liquidity sweep',
        openedAtIso: '2024-01-15T10:00:00.000Z',
        dashboardUrl: 'https://shamarx.com/lives',
      };

      // sendTradeOpened internally warns but does not rethrow
      await expect(service.sendTradeOpened('carol@example.com', payload)).resolves.toBeUndefined();
    });
  });
});
