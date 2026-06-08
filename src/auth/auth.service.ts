import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, UserRole } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { PrismaService } from '@app/prisma';
import { MailService } from '../mail/mail.service';
import { RefreshTokenService } from './refresh-token.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;       // 1 hour
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;     // 60s between requests per email

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async validateCredentials(email: string, password: string): Promise<User> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  signAccessToken(user: Pick<User, 'id' | 'email' | 'role'>): string {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return this.jwt.sign(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: (process.env.JWT_ACCESS_TTL || '15m') as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });
  }

  async login(email: string, password: string, userAgent?: string) {
    const user = await this.validateCredentials(email, password);
    await this.users.recordLogin(user.id);
    const { token: refreshToken } = await this.refreshTokens.issue(user.id, userAgent);
    return {
      user: { id: user.id, email: user.email, role: user.role },
      accessToken: this.signAccessToken(user),
      refreshToken,
    };
  }

  async refresh(presentedRefreshToken: string, userAgent?: string) {
    const rotated = await this.refreshTokens.rotate(presentedRefreshToken, userAgent);
    const user = await this.users.findById(rotated.userId);
    if (!user || !user.isActive) {
      await this.refreshTokens.revokeAllForUser(rotated.userId);
      throw new UnauthorizedException('User no longer valid');
    }
    return {
      user: { id: user.id, email: user.email, role: user.role },
      accessToken: this.signAccessToken(user),
      refreshToken: rotated.token,
    };
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.refreshTokens.revoke(refreshToken);
    }
  }

  /**
   * Send a password-reset email. Always returns silently (regardless of
   * whether the email exists) to prevent account-enumeration attacks.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const normalized = email.toLowerCase().trim();
    const user = await this.users.findByEmail(normalized);
    if (!user || !user.isActive) {
      this.logger.log(`Reset requested for non-existent/inactive email: ${normalized}`);
      return;
    }

    // Cooldown: refuse if a reset was issued within the last 60s for this user
    const recent = await this.prisma.passwordResetToken.findFirst({
      where: { userId: user.id, createdAt: { gte: new Date(Date.now() - RESET_REQUEST_COOLDOWN_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      this.logger.log(`Reset cooldown active for ${normalized}`);
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt },
    });

    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const resetUrl = `${webUrl}/reset-password?token=${token}`;

    await this.mail.sendPasswordReset(user.email, resetUrl);
  }

  /**
   * Validate a reset token without consuming it. For frontend pre-check
   * before showing the password form.
   */
  async validateResetToken(token: string): Promise<{ valid: boolean; reason?: string }> {
    const row = await this.prisma.passwordResetToken.findUnique({ where: { token } });
    if (!row) return { valid: false, reason: 'not_found' };
    if (row.isUsed) return { valid: false, reason: 'used' };
    if (row.expiresAt < new Date()) return { valid: false, reason: 'expired' };
    return { valid: true };
  }

  /**
   * Consume a reset token and set the user's new password.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const row = await this.prisma.passwordResetToken.findUnique({ where: { token } });
    if (!row) throw new BadRequestException('Invalid or expired reset link');
    if (row.isUsed) throw new BadRequestException('This reset link has already been used');
    if (row.expiresAt < new Date()) throw new BadRequestException('This reset link has expired');

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({ where: { id: row.id }, data: { isUsed: true } }),
    ]);
    this.logger.log(`Password reset successful for userId=${row.userId}`);
  }
}
