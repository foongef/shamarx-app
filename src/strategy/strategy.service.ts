import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import {
  SYMBOL,
  SERVICE_URLS,
  Timeframe,
  Side,
  Bias,
  SetupTag,
  CandidateTradeDto,
  CandleDto,
} from '@app/common';
import { IndicatorService } from '../market-data/indicator.service';
import { SRLevelService } from '../market-data/sr-level.service';
import { SpreadService } from '../market-data/spread.service';
import { RiskService } from '../risk/risk.service';
import { LlmFilterService } from '../llm-filter/llm-filter.service';
import { PatternDetector } from './pattern-detector';
import { StructureAnalyzer } from './structure-analyzer';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class StrategyService implements OnModuleInit {
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly indicatorService: IndicatorService,
    private readonly srLevelService: SRLevelService,
    private readonly spreadService: SpreadService,
    private readonly riskService: RiskService,
    private readonly llmFilterService: LlmFilterService,
    private readonly patternDetector: PatternDetector,
    private readonly structureAnalyzer: StructureAnalyzer,
  ) {}

  async onModuleInit() {
    await this.redis.subscribe(REDIS_CHANNELS.CANDLE_STORED, (message) => {
      const data = JSON.parse(message);
      if (data.timeframe === Timeframe.M15) {
        this.evaluateSetup().catch((err) =>
          this.logger.error(`Setup evaluation failed: ${err.message}`),
        );
      }
    });
    this.logger.log('Subscribed to candle:stored events');
  }

  async evaluateSetup(): Promise<void> {
    this.logger.log('Evaluating setup...');

    // Get market snapshot directly from service
    const snapshot = await this.indicatorService.getMarketSnapshot();

    // Get structure context directly from service
    const structure = await this.srLevelService.getStructureContext();

    // Fetch recent M15 candles from execution-service (external)
    const candlesRes = await firstValueFrom(
      this.httpService.get<CandleDto[]>(
        `${SERVICE_URLS.EXECUTION}/candles`,
        { params: { symbol: SYMBOL, timeframe: Timeframe.M15, count: 50 } },
      ),
    );
    const candles = candlesRes.data;

    if (candles.length < 20) {
      this.logger.warn('Not enough candles for analysis');
      return;
    }

    // Step 1: Detect swing points and BOS
    const swingPoints = this.structureAnalyzer.detectSwingPoints(candles);
    const bos = this.structureAnalyzer.detectBOS(candles, swingPoints);

    if (!bos) {
      this.logger.debug('No BOS detected');
      return;
    }

    const isBullish = bos.direction === Side.BUY;

    // Step 2: Check H1 bias alignment
    const biasAligned =
      (isBullish && structure.h1Bias === Bias.BULLISH) ||
      (!isBullish && structure.h1Bias === Bias.BEARISH);

    // Step 3: Get confirmation tags
    const tags = this.patternDetector.getConfirmationTags(
      candles,
      snapshot.ema20,
      snapshot.ema50,
      snapshot.rsi14,
      snapshot.atr14,
      isBullish,
    );

    tags.unshift(SetupTag.BOS); // BOS is always first tag

    if (biasAligned) {
      tags.push(SetupTag.H1_BIAS_ALIGNED);
    }

    // Require at least BOS + one confirmation
    const hasPullback = tags.includes(SetupTag.PULLBACK_EMA20) ||
      tags.includes(SetupTag.PULLBACK_EMA50);
    const hasConfirmation = tags.includes(SetupTag.ENGULFING) ||
      tags.includes(SetupTag.STRONG_CLOSE);

    if (!hasPullback || !hasConfirmation) {
      this.logger.debug(
        `Insufficient setup confirmations: ${tags.join(', ')}`,
      );
      return;
    }

    // Step 4: Compute entry, SL, TP
    const lastCandle = candles[candles.length - 1];
    const entryPrice = lastCandle.close;
    const atr = snapshot.atr14;

    let slPrice: number;
    let tpPrice: number;

    if (isBullish) {
      // SL below recent swing low or 1.5x ATR
      const recentLows = swingPoints
        .filter((p) => p.type === 'LOW')
        .slice(-3)
        .map((p) => p.price);
      const swingSL = recentLows.length > 0 ? Math.min(...recentLows) : 0;
      const atrSL = entryPrice - atr * 1.5;
      slPrice = Math.max(swingSL, atrSL); // Use the closer SL
      const slPoints = entryPrice - slPrice;
      tpPrice = entryPrice + slPoints * 2; // 2:1 RR
    } else {
      const recentHighs = swingPoints
        .filter((p) => p.type === 'HIGH')
        .slice(-3)
        .map((p) => p.price);
      const swingSL = recentHighs.length > 0 ? Math.max(...recentHighs) : 0;
      const atrSL = entryPrice + atr * 1.5;
      slPrice = Math.min(swingSL, atrSL);
      const slPoints = slPrice - entryPrice;
      tpPrice = entryPrice - slPoints * 2;
    }

    const slPoints = Math.abs(entryPrice - slPrice);
    const tpPoints = Math.abs(tpPrice - entryPrice);

    // Step 5: Create candidate trade
    const candidate: CandidateTradeDto = {
      symbol: SYMBOL,
      side: bos.direction,
      entryPrice: Math.round(entryPrice * 100) / 100,
      slPrice: Math.round(slPrice * 100) / 100,
      tpPrice: Math.round(tpPrice * 100) / 100,
      slPoints: Math.round(slPoints * 100) / 100,
      tpPoints: Math.round(tpPoints * 100) / 100,
      setupTags: tags,
      h1Bias: structure.h1Bias,
      rsiValue: snapshot.rsi14,
      atrValue: snapshot.atr14,
      spreadAtDetection: 0, // Will be filled from spread service
      timeframe: Timeframe.M15,
    };

    // Get current spread directly from service
    try {
      const spreadStats = await this.spreadService.getSpreadStats();
      candidate.spreadAtDetection = spreadStats.currentSpread;
    } catch {
      this.logger.warn('Could not fetch spread');
    }

    // Store candidate
    const stored = await this.prisma.candidateTrade.create({
      data: candidate,
    });

    this.logger.log(
      `Candidate trade created: ${stored.id} ${candidate.side} @ ${candidate.entryPrice}`,
    );

    // Send to LLM filter for validation directly
    try {
      const decision = await this.llmFilterService.validateCandidate(
        { candidate: { ...candidate, id: stored.id } },
      );

      this.logger.log(
        `LLM decision: ${decision.decision} (confidence: ${decision.confidence})`,
      );

      if (decision.decision === 'ALLOW') {
        await this.executeApprovedTrade(stored.id, candidate);
      } else {
        await this.prisma.candidateTrade.update({
          where: { id: stored.id },
          data: { status: 'REJECTED' },
        });
        await this.redis.publish(REDIS_CHANNELS.TRADE_REJECTED, {
          candidateId: stored.id,
          reason: decision.reasoning,
        });
      }
    } catch (error) {
      this.logger.error(`LLM validation failed: ${error.message}`);
      // Default to reject on failure
      await this.prisma.candidateTrade.update({
        where: { id: stored.id },
        data: { status: 'REJECTED' },
      });
    }
  }

  private async executeApprovedTrade(
    candidateId: string,
    candidate: CandidateTradeDto,
  ): Promise<void> {
    // Get risk state directly from service
    const riskState = await this.riskService.getRiskState();

    if (!riskState.canTrade) {
      this.logger.warn('Risk limits hit, skipping trade execution');
      return;
    }

    // Compute lot size
    const riskAmount = riskState.balance * (riskState.riskPerTradePercent / 100);
    const lotSize = Math.round((riskAmount / (candidate.slPoints * 100)) * 100) / 100;
    const finalLotSize = Math.max(0.01, Math.min(lotSize, 1.0)); // Clamp

    // Place order via execution service (external Python)
    const orderRes = await firstValueFrom(
      this.httpService.post(`${SERVICE_URLS.EXECUTION}/orders`, {
        symbol: candidate.symbol,
        side: candidate.side,
        lotSize: finalLotSize,
        entryPrice: candidate.entryPrice,
        slPrice: candidate.slPrice,
        tpPrice: candidate.tpPrice,
        comment: `Bot:${candidateId.slice(0, 8)}`,
      }),
    );

    const order = orderRes.data;

    // Store trade
    await this.prisma.trade.create({
      data: {
        candidateId,
        mt5Ticket: order.mt5Ticket,
        symbol: candidate.symbol,
        side: candidate.side,
        lotSize: finalLotSize,
        entryPrice: candidate.entryPrice,
        slPrice: candidate.slPrice,
        tpPrice: candidate.tpPrice,
        status: 'OPEN',
        statusHistory: [
          { status: 'PENDING', timestamp: new Date().toISOString() },
          { status: 'OPEN', timestamp: new Date().toISOString() },
        ],
      },
    });

    await this.prisma.candidateTrade.update({
      where: { id: candidateId },
      data: { status: 'APPROVED' },
    });

    await this.redis.publish(REDIS_CHANNELS.TRADE_OPENED, {
      candidateId,
      symbol: candidate.symbol,
      side: candidate.side,
      lotSize: finalLotSize,
      entryPrice: candidate.entryPrice,
    });

    this.logger.log(
      `Trade executed: ${candidate.side} ${finalLotSize} lots @ ${candidate.entryPrice}`,
    );
  }
}
