import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { RiskService } from './risk.service';
import { RiskStateDto } from '@app/common';

@ApiTags('Risk')
@Controller('api/risk')
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check for risk service' })
  health() {
    return { status: 'ok', service: 'risk' };
  }

  @Get('risk-state')
  @ApiOperation({ summary: 'Get current risk state and trading limits' })
  @ApiOkResponse({ type: RiskStateDto })
  async getRiskState(): Promise<RiskStateDto> {
    return this.riskService.getRiskState();
  }
}
