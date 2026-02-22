import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '@app/prisma';
import { EconomicRiskDto, ImpactLevel } from '@app/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class EconomicCalendarService {
  private readonly logger = new Logger(EconomicCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async scrapeCalendar() {
    try {
      await this.fetchForexFactoryEvents();
    } catch (error) {
      this.logger.error(`Failed to scrape calendar: ${error.message}`);
    }
  }

  private async fetchForexFactoryEvents(): Promise<void> {
    try {
      const url = 'https://www.forexfactory.com/calendar?week=this';
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          timeout: 10000,
        }),
      );

      const events = this.parseForexFactoryHtml(response.data);

      for (const event of events) {
        await this.prisma.economicEvent.upsert({
          where: {
            title_eventTime: {
              title: event.title,
              eventTime: event.eventTime,
            },
          },
          update: {
            actual: event.actual,
            forecast: event.forecast,
            previous: event.previous,
          },
          create: event,
        });
      }

      this.logger.log(`Stored ${events.length} economic events`);
    } catch (error) {
      this.logger.warn(`Calendar scrape failed: ${error.message}`);
    }
  }

  private parseForexFactoryHtml(
    html: string,
  ): {
    title: string;
    country: string;
    impact: string;
    eventTime: Date;
    actual?: string;
    forecast?: string;
    previous?: string;
  }[] {
    // Simple regex-based parser for forex factory calendar
    // In production, use cheerio or similar HTML parser
    const events: {
      title: string;
      country: string;
      impact: string;
      eventTime: Date;
      actual?: string;
      forecast?: string;
      previous?: string;
    }[] = [];

    // Extract rows with high/medium impact events
    const impactPattern =
      /class="calendar__cell calendar__impact"[^>]*>.*?(high|medium|low)/gi;
    const titlePattern =
      /class="calendar__event-title"[^>]*>([^<]+)/gi;

    // This is a simplified parser - in production would use proper HTML parsing
    // For now, we'll rely on the stored events and manual seeding
    this.logger.debug('HTML calendar parsing attempted');

    return events;
  }

  async getEconomicRisk(): Promise<EconomicRiskDto> {
    const now = new Date();
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const upcomingEvents = await this.prisma.economicEvent.findMany({
      where: {
        eventTime: {
          gte: now,
          lte: twoHoursFromNow,
        },
        impact: ImpactLevel.HIGH,
      },
      orderBy: { eventTime: 'asc' },
    });

    let minutesToNextHighImpact: number | null = null;
    if (upcomingEvents.length > 0) {
      minutesToNextHighImpact = Math.round(
        (upcomingEvents[0].eventTime.getTime() - now.getTime()) / 60000,
      );
    }

    // High risk if high-impact event within 30 minutes
    const isHighRiskPeriod =
      minutesToNextHighImpact !== null && minutesToNextHighImpact <= 30;

    return {
      upcomingHighImpact: upcomingEvents.map((e) => ({
        title: e.title,
        country: e.country,
        impact: e.impact,
        eventTime: e.eventTime.toISOString(),
      })),
      isHighRiskPeriod,
      minutesToNextHighImpact,
    };
  }
}
