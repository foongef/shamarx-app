import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService, AuthenticatedUser } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/forgot-password.dto';
import { JwtAuthGuard, Public } from './guards/jwt-auth.guard';

const ACCESS_COOKIE = 'auth_token';
const REFRESH_COOKIE = 'refresh_token';

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // 15 min
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

@Controller('api/auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.email, dto.password);
    res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts(ACCESS_MAX_AGE_MS));
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts(REFRESH_MAX_AGE_MS));
    return { user: result.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) return { user: null };
    const result = await this.auth.refresh(token);
    res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts(ACCESS_MAX_AGE_MS));
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts(REFRESH_MAX_AGE_MS));
    return { user: result.user };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: Request) {
    return { user: req.user as AuthenticatedUser };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.requestPasswordReset(dto.email);
    // Always 200 — never disclose whether email exists
    return { ok: true };
  }

  @Public()
  @Get('validate-reset-token')
  async validateResetToken(@Query('token') token: string) {
    if (!token) return { valid: false, reason: 'missing' };
    return this.auth.validateResetToken(token);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.password);
    return { ok: true };
  }
}
