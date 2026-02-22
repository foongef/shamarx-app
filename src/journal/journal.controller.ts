import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Journal')
@Controller('api/journal')
export class JournalController {
  @Get('health')
  @ApiOperation({ summary: 'Health check for journal service' })
  health() {
    return { status: 'ok', service: 'journal' };
  }
}
