import { Injectable, Logger } from '@nestjs/common';
import { IndicatorService } from '../market-data/indicator.service';
import { SRLevelService } from '../market-data/sr-level.service';
import { SpreadService } from '../market-data/spread.service';
import { EconomicCalendarService } from '../market-data/economic-calendar.service';
import { RiskService } from '../risk/risk.service';

@Injectable()
export class ToolExecutor {
  private readonly logger = new Logger(ToolExecutor.name);

  constructor(
    private readonly indicatorService: IndicatorService,
    private readonly srLevelService: SRLevelService,
    private readonly spreadService: SpreadService,
    private readonly economicCalendarService: EconomicCalendarService,
    private readonly riskService: RiskService,
  ) {}

  async execute(toolName: string, _input: Record<string, unknown>): Promise<string> {
    try {
      switch (toolName) {
        case 'get_account_risk_state': {
          const riskState = await this.riskService.getRiskState();
          return JSON.stringify(riskState);
        }

        case 'get_market_snapshot': {
          const snapshot = await this.indicatorService.getMarketSnapshot();
          return JSON.stringify(snapshot);
        }

        case 'get_structure_context': {
          const context = await this.srLevelService.getStructureContext();
          return JSON.stringify(context);
        }

        case 'get_sr_levels': {
          const levels = await this.srLevelService.getActiveLevels();
          return JSON.stringify(levels);
        }

        case 'get_economic_risk': {
          const risk = await this.economicCalendarService.getEconomicRisk();
          return JSON.stringify(risk);
        }

        case 'get_spread_stats': {
          const stats = await this.spreadService.getSpreadStats();
          return JSON.stringify(stats);
        }

        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    } catch (error) {
      this.logger.error(`Tool ${toolName} failed: ${error.message}`);
      return JSON.stringify({
        error: `Tool execution failed: ${error.message}`,
      });
    }
  }
}
