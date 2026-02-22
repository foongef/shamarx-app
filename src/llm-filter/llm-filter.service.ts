import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import {
  LlmValidationRequest,
  LlmValidationResponse,
  LlmDecisionType,
} from '@app/common';
import { SYSTEM_PROMPT } from './prompts/system-prompt';
import { TOOL_DEFINITIONS } from './tool-definitions';
import { ToolExecutor } from './tool-executor';
import OpenAI from 'openai';
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

const MAX_TOOL_ROUNDS = 3;

@Injectable()
export class LlmFilterService {
  private readonly logger = new Logger(LlmFilterService.name);
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly toolExecutor: ToolExecutor,
  ) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('MINIMAX_API_KEY'),
      baseURL: 'https://api.minimax.io/v1',
    });
    this.model = this.configService.get<string>(
      'LLM_MODEL',
      'MiniMax-M2.5',
    );
  }

  async validateCandidate(
    request: LlmValidationRequest,
  ): Promise<LlmValidationResponse> {
    const startTime = Date.now();
    const toolsUsed: string[] = [];

    try {
      const messages: ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: `Validate this candidate trade:\n\n${JSON.stringify(request.candidate, null, 2)}\n\nUse the available tools to gather market context and risk state, then make your ALLOW/REJECT decision.`,
        },
      ];

      const tools: ChatCompletionTool[] = TOOL_DEFINITIONS.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));

      let response: OpenAI.Chat.Completions.ChatCompletion;
      let rounds = 0;

      // Tool-use loop
      while (rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 1024,
          tools,
          tool_choice: 'auto',
          messages,
        });

        const choice = response.choices[0];
        const assistantMsg = choice.message;

        // Append assistant message to conversation
        messages.push(assistantMsg);

        // Check if model wants to call tools
        if (
          !assistantMsg.tool_calls ||
          assistantMsg.tool_calls.length === 0
        ) {
          break;
        }

        // Execute each tool call and append results
        for (const toolCall of assistantMsg.tool_calls) {
          if (toolCall.type !== 'function') continue;
          const fnName = toolCall.function.name;
          toolsUsed.push(fnName);

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            // empty args is fine
          }

          const result = await this.toolExecutor.execute(fnName, args);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }
      }

      // Parse the final response
      const finalContent =
        response!.choices[0].message.content || '';
      const decision = this.parseDecision(finalContent);
      const latencyMs = Date.now() - startTime;

      // Store LLM decision
      if (request.candidate.id) {
        await this.prisma.llmDecision.create({
          data: {
            candidateId: request.candidate.id,
            decision: decision.decision,
            confidence: decision.confidence,
            reasoning: decision.reasoning,
            toolsUsed,
            rawResponse: finalContent,
            inputTokens: response!.usage?.prompt_tokens ?? 0,
            outputTokens: response!.usage?.completion_tokens ?? 0,
            latencyMs,
          },
        });
      }

      await this.redis.publish(REDIS_CHANNELS.LLM_DECISION, {
        candidateId: request.candidate.id,
        decision: decision.decision,
        confidence: decision.confidence,
      });

      this.logger.log(
        `Validation complete: ${decision.decision} (${decision.confidence}) in ${latencyMs}ms`,
      );

      return { ...decision, toolsUsed };
    } catch (error) {
      this.logger.error(`LLM validation error: ${error.message}`);

      return {
        decision: LlmDecisionType.REJECT,
        confidence: 0,
        reasoning: `Validation error: ${error.message}`,
        toolsUsed,
      };
    }
  }

  private parseDecision(
    text: string,
  ): Omit<LlmValidationResponse, 'toolsUsed'> {
    try {
      const jsonMatch = text.match(/\{[\s\S]*?"decision"[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          decision:
            parsed.decision === 'ALLOW'
              ? LlmDecisionType.ALLOW
              : LlmDecisionType.REJECT,
          confidence:
            typeof parsed.confidence === 'number'
              ? parsed.confidence
              : 0.5,
          reasoning: parsed.reasoning || 'No reasoning provided',
        };
      }
    } catch {
      this.logger.warn('Failed to parse LLM JSON response');
    }

    return {
      decision: LlmDecisionType.REJECT,
      confidence: 0,
      reasoning: `Failed to parse LLM response: ${text.slice(0, 200)}`,
    };
  }
}
