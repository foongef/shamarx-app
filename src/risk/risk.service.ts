import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { SERVICE_URLS, RiskStateDto, AccountInfoDto } from '@app/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class RiskService implements OnModuleInit {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    // Ensure risk config exists
    const configCount = await this.prisma.riskConfig.count();
    if (configCount === 0) {
      await this.prisma.riskConfig.create({
        data: {
          maxDailyLossPercent: parseFloat(
            this.configService.get('MAX_DAILY_LOSS_PERCENT', '3.0'),
          ),
          maxOpenPositions: parseInt(
            this.configService.get('MAX_OPEN_POSITIONS', '3'),
            10,
          ),
          maxConsecutiveLosses: parseInt(
            this.configService.get('MAX_CONSECUTIVE_LOSSES', '3'),
            10,
          ),
          riskPerTradePercent: parseFloat(
            this.configService.get('RISK_PER_TRADE_PERCENT', '1.0'),
          ),
          maxSpreadPoints: parseFloat(
            this.configService.get('MAX_SPREAD_POINTS', '50'),
          ),
        },
      });
    }

    // Subscribe to trade closed events
    await this.redis.subscribe(
      REDIS_CHANNELS.TRADE_CLOSED,
      (message) => {
        this.handleTradeClosed(JSON.parse(message)).catch((err) =>
          this.logger.error(`Failed to handle trade close: ${err.message}`),
        );
      },
    );

    this.logger.log('Risk service initialized');
  }

  async getRiskState(): Promise<RiskStateDto> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get or create today's risk state
    let riskState = await this.prisma.riskState.findUnique({
      where: { date: today },
    });

    if (!riskState) {
      // Carry over consecutive losses from previous day
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const prevState = await this.prisma.riskState.findUnique({
        where: { date: yesterday },
      });

      riskState = await this.prisma.riskState.create({
        data: {
          date: today,
          consecutiveLosses: prevState?.consecutiveLosses ?? 0,
        },
      });
    }

    // Fetch account info from execution service (external Python)
    let accountInfo: AccountInfoDto = {
      balance: 10000,
      equity: 10000,
      margin: 0,
      freeMargin: 10000,
      openPositions: 0,
    };

    try {
      const res = await firstValueFrom(
        this.httpService.get<AccountInfoDto>(
          `${SERVICE_URLS.EXECUTION}/account`,
        ),
      );
      accountInfo = res.data;
    } catch (error) {
      this.logger.warn(`Failed to fetch account info: ${error.message}`);
    }

    // Get risk config
    const config = await this.prisma.riskConfig.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    const dailyPnlPercent =
      accountInfo.balance > 0
        ? (riskState.dailyPnl / accountInfo.balance) * 100
        : 0;

    const dailyLossLimitHit =
      dailyPnlPercent <= -(config?.maxDailyLossPercent ?? 3.0);
    const consecutiveLossLimitHit =
      riskState.consecutiveLosses >= (config?.maxConsecutiveLosses ?? 3);

    const canTrade =
      !dailyLossLimitHit &&
      !consecutiveLossLimitHit &&
      accountInfo.openPositions < (config?.maxOpenPositions ?? 3);

    // Update risk state flags
    if (
      dailyLossLimitHit !== riskState.dailyLossLimitHit ||
      consecutiveLossLimitHit !== riskState.consecutiveLossLimitHit
    ) {
      await this.prisma.riskState.update({
        where: { id: riskState.id },
        data: {
          dailyLossLimitHit,
          consecutiveLossLimitHit,
          openPositionCount: accountInfo.openPositions,
        },
      });
    }

    return {
      date: today.toISOString().split('T')[0],
      balance: accountInfo.balance,
      equity: accountInfo.equity,
      dailyPnl: riskState.dailyPnl,
      dailyPnlPercent: Math.round(dailyPnlPercent * 100) / 100,
      consecutiveLosses: riskState.consecutiveLosses,
      openPositionCount: accountInfo.openPositions,
      maxDailyLossPercent: config?.maxDailyLossPercent ?? 3.0,
      maxOpenPositions: config?.maxOpenPositions ?? 3,
      maxConsecutiveLosses: config?.maxConsecutiveLosses ?? 3,
      riskPerTradePercent: config?.riskPerTradePercent ?? 1.0,
      maxSpreadPoints: config?.maxSpreadPoints ?? 50,
      dailyLossLimitHit,
      consecutiveLossLimitHit,
      canTrade,
    };
  }

  private async handleTradeClosed(data: {
    tradeId: string;
    pnl: number;
  }): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let riskState = await this.prisma.riskState.findUnique({
      where: { date: today },
    });

    if (!riskState) {
      riskState = await this.prisma.riskState.create({
        data: { date: today },
      });
    }

    const newDailyPnl = riskState.dailyPnl + data.pnl;
    const newConsecutiveLosses =
      data.pnl < 0 ? riskState.consecutiveLosses + 1 : 0;

    await this.prisma.riskState.update({
      where: { id: riskState.id },
      data: {
        dailyPnl: newDailyPnl,
        consecutiveLosses: newConsecutiveLosses,
      },
    });

    await this.redis.publish(REDIS_CHANNELS.RISK_STATE_UPDATED, {
      date: today.toISOString(),
      dailyPnl: newDailyPnl,
      consecutiveLosses: newConsecutiveLosses,
    });

    this.logger.log(
      `Risk state updated: dailyPnl=${newDailyPnl}, consecutiveLosses=${newConsecutiveLosses}`,
    );
  }
}
