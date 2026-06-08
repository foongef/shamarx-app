import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BrokerAccountsService } from './broker-accounts.service';
import { CreateBrokerAccountDto } from './dto/create-broker-account.dto';
import { UpdateBrokerAccountDto } from './dto/update-broker-account.dto';

@ApiTags('Broker Accounts')
@Controller('api/accounts')
@UseGuards(JwtAuthGuard)
export class BrokerAccountsController {
  constructor(private readonly accounts: BrokerAccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List broker accounts for the current user' })
  list(@Req() req: any) {
    return this.accounts.findAllForUser(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new broker account (creds encrypted at rest)' })
  create(@Req() req: any, @Body() body: CreateBrokerAccountDto) {
    return this.accounts.create(req.user.id, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single broker account' })
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.accounts.findOneForUser(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update name / isEnabled / mode / sortIndex' })
  update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateBrokerAccountDto) {
    return this.accounts.update(req.user.id, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete. Returns 409 if open trades exist unless ?force=true.' })
  @ApiQuery({ name: 'force', required: false, type: Boolean })
  delete(@Req() req: any, @Param('id') id: string, @Query('force') force?: string) {
    return this.accounts.delete(req.user.id, id, force === 'true');
  }
}
