import { Body, Controller, Get, Post } from '@nestjs/common';
import { Public } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { BrokerOAuthService } from './broker-oauth.service';
import { CallbackDto } from './dto/callback.dto';
import { FinalizeOAuthDto } from './dto/finalize-oauth.dto';

@Controller('api/broker-accounts/ctrader')
export class BrokerOAuthController {
  constructor(private readonly oauth: BrokerOAuthService) {}

  @Get('oauth/start')
  start(@CurrentUser() user: AuthenticatedUser) {
    return this.oauth.startOAuth(user.id);
  }

  /** Public — state is validated by Redis lookup, so JWT isn't required.
   *  This must be public because the Spotware redirect lands here without our auth cookie. */
  @Post('callback')
  @Public()
  callback(@Body() dto: CallbackDto) {
    return this.oauth.handleCallback(dto.code, dto.state);
  }

  @Post('finalize')
  finalize(@CurrentUser() user: AuthenticatedUser, @Body() dto: FinalizeOAuthDto) {
    return this.oauth.finalize(
      user.id,
      dto.oauthSessionId,
      dto.ctidTraderAccountId,
      dto.name,
      dto.isEnabled ?? false,
    );
  }
}
