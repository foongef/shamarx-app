import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { CryptoModule } from '../crypto/crypto.module';
import { BrokerAccountsService } from './broker-accounts.service';
import { BrokerAccountsController } from './broker-accounts.controller';

@Module({
  imports: [PrismaModule, CryptoModule],
  controllers: [BrokerAccountsController],
  providers: [BrokerAccountsService],
  exports: [BrokerAccountsService],
})
export class BrokerAccountsModule {}
