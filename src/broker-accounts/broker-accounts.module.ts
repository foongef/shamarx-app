import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { CryptoModule } from '../crypto/crypto.module';
import { BrokerAccountsService } from './broker-accounts.service';

@Module({
  imports: [PrismaModule, CryptoModule],
  providers: [BrokerAccountsService],
  exports: [BrokerAccountsService],
})
export class BrokerAccountsModule {}
