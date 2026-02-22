import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '@app/prisma';
import { SYMBOL, SERVICE_URLS, SpreadStatsDto } from '@app/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class SpreadService {
  private readonly logger = new Logger(SpreadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
  ) {}

  @Cron('*/5 * * * * *') // Every 5 seconds
  async pollSpread() {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${SERVICE_URLS.EXECUTION}/account`),
      );

      // The execution service returns bid/ask in the tick data
      // For now, we'll estimate spread from the account endpoint
      // In production, we'd have a dedicated tick endpoint
      const tick = response.data;

      if (tick.bid && tick.ask) {
        await this.prisma.spreadSnapshot.create({
          data: {
            symbol: SYMBOL,
            bid: tick.bid,
            ask: tick.ask,
            spread: (tick.ask - tick.bid) * 100, // Convert to points
          },
        });
      }
    } catch (error) {
      // Silently fail on spread polling - non-critical
      this.logger.debug(`Spread poll failed: ${error.message}`);
    }
  }

  async getSpreadStats(): Promise<SpreadStatsDto> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const snapshots = await this.prisma.spreadSnapshot.findMany({
      where: {
        symbol: SYMBOL,
        timestamp: { gte: oneHourAgo },
      },
      orderBy: { timestamp: 'desc' },
    });

    if (snapshots.length === 0) {
      return {
        symbol: SYMBOL,
        currentSpread: 0,
        avgSpread1h: 0,
        maxSpread1h: 0,
        isHighSpread: false,
      };
    }

    const currentSpread = snapshots[0].spread;
    const avgSpread1h =
      snapshots.reduce((sum, s) => sum + s.spread, 0) / snapshots.length;
    const maxSpread1h = Math.max(...snapshots.map((s) => s.spread));

    return {
      symbol: SYMBOL,
      currentSpread,
      avgSpread1h: Math.round(avgSpread1h * 100) / 100,
      maxSpread1h,
      isHighSpread: currentSpread > 50, // 50 points threshold
    };
  }
}
