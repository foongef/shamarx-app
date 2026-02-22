import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Strategy')
@Controller('api/strategy')
export class StrategyController {
  @Get('health')
  @ApiOperation({ summary: 'Health check for strategy service' })
  health() {
    return { status: 'ok', service: 'strategy' };
  }
}
