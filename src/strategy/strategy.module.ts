import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MarketDataModule } from '../market-data/market-data.module';
import { RiskModule } from '../risk/risk.module';
import { LlmFilterModule } from '../llm-filter/llm-filter.module';
import { MailModule } from '../mail/mail.module';
import { JournalModule } from '../journal/journal.module';
import { BrokerAccountsModule } from '../broker-accounts/broker-accounts.module';
import { CryptoModule } from '../crypto/crypto.module';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { PatternDetector } from './pattern-detector';
import { StructureAnalyzer } from './structure-analyzer';
import { LiveStrategyService } from './live/live-strategy.service';
import { PositionMonitorService } from './live/position-monitor.service';
import { LivePositionManagerService } from './live/live-position-manager.service';
import { SmcLiveEvaluator } from './live/smc-live-evaluator';
import { LiveSmcOrchestrator } from './live/live-smc-orchestrator';
import { LiveControlService } from './live/live-control.service';
import { EquitySnapshotService } from './live/equity-snapshot.service';
import { LiveAnalyticsService } from './live/live-analytics.service';
import { BrokerHttpClient } from './live/broker-http-client';
import { LiveSmcOrchestratorRegistry } from './live/live-smc-orchestrator-registry';

@Module({
  imports: [HttpModule, MarketDataModule, RiskModule, LlmFilterModule, MailModule, JournalModule, BrokerAccountsModule, CryptoModule],
  controllers: [StrategyController],
  providers: [
    StrategyService,
    PatternDetector,
    StructureAnalyzer,
    SmcLiveEvaluator,
    LiveSmcOrchestrator,
    LiveControlService,
    LiveStrategyService,
    PositionMonitorService,
    LivePositionManagerService,
    EquitySnapshotService,
    LiveAnalyticsService,
    BrokerHttpClient,
    LiveSmcOrchestratorRegistry,
    {
      provide: 'ORCHESTRATOR_FACTORY',
      useFactory: () => () => new LiveSmcOrchestrator(),
    },
  ],
  exports: [
    LiveStrategyService,
    LiveSmcOrchestrator,
    PositionMonitorService,
    LivePositionManagerService,
    LiveControlService,
    LiveAnalyticsService,
  ],
})
export class StrategyModule {}
