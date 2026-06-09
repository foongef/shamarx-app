import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '@app/prisma';
import { CryptoModule } from '../crypto/crypto.module';
import { BrokerAccountsService } from './broker-accounts.service';
import { BrokerAccountsController } from './broker-accounts.controller';
import { BrokerOAuthService } from './oauth/broker-oauth.service';
import { BrokerOAuthController } from './oauth/broker-oauth.controller';

@Module({
  imports: [PrismaModule, CryptoModule, HttpModule],
  controllers: [BrokerAccountsController, BrokerOAuthController],
  providers: [BrokerAccountsService, BrokerOAuthService],
  exports: [BrokerAccountsService, BrokerOAuthService],
})
export class BrokerAccountsModule {}
