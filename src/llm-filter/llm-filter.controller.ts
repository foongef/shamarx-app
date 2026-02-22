import { Controller, Post, Body, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiBody } from '@nestjs/swagger';
import { LlmFilterService } from './llm-filter.service';
import { LlmValidationRequest, LlmValidationResponse } from '@app/common';

@ApiTags('LLM Filter')
@Controller('api/llm-filter')
export class LlmFilterController {
  constructor(private readonly llmFilterService: LlmFilterService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check for LLM filter service' })
  health() {
    return { status: 'ok', service: 'llm-filter' };
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate a trade candidate using LLM analysis' })
  @ApiBody({ type: LlmValidationRequest })
  @ApiOkResponse({ type: LlmValidationResponse })
  async validate(
    @Body() request: LlmValidationRequest,
  ): Promise<LlmValidationResponse> {
    return this.llmFilterService.validateCandidate(request);
  }
}
