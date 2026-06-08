import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard, Public } from '../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { InviteService } from './invite.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';

const ACCESS_COOKIE = 'auth_token';
const REFRESH_COOKIE = 'refresh_token';
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieOpts(maxAge: number) {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
}

@Controller('api')
export class InviteController {
  constructor(private readonly invites: InviteService) {}

  // ---------- ADMIN ----------

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPERADMIN')
  @Post('admin/invites')
  async create(@Body() dto: CreateInviteDto, @CurrentUser() me: AuthenticatedUser) {
    const { invite, token } = await this.invites.create(dto.email, me.id, dto.expiresInDays);
    return {
      id: invite.id,
      email: invite.email,
      expiresAt: invite.expiresAt,
      token,        // returned once for fallback copy
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPERADMIN')
  @Get('admin/invites')
  list() {
    return this.invites.list();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPERADMIN')
  @Delete('admin/invites/:id')
  @HttpCode(204)
  async revoke(@Param('id') id: string) {
    await this.invites.revoke(id);
  }

  // ---------- PUBLIC ----------

  @Public()
  @Get('invites/:token/preview')
  async preview(@Param('token') token: string) {
    const preview = await this.invites.preview(token);
    if (!preview) return { valid: false };
    return { valid: true, ...preview };
  }

  @Public()
  @Post('invites/:token/accept')
  @HttpCode(200)
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ua = req.headers['user-agent'] ?? undefined;
    const result = await this.invites.accept(token, dto.password, dto.presetKey, ua);
    res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts(ACCESS_MAX_AGE_MS));
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts(REFRESH_MAX_AGE_MS));
    return { user: result.user };
  }
}
