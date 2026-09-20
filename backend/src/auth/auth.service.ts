import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
} from './dto';

/** Reset links live for 30 minutes unless PASSWORD_RESET_TTL_MINUTES says otherwise. */
const DEFAULT_RESET_TTL_MINUTES = 30;
/** Every public answer for "forgot password" is identical (no account enumeration). */
const GENERIC_FORGOT_MESSAGE =
  'If that email is registered, a password reset link has been sent.';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  /**
   * POST /auth/login — accounts are created by an Admin via `POST /users`
   * (ADR-004); there is no self-registration. A wrong email and a wrong
   * password return the same generic error so the endpoint cannot be used to
   * discover which emails exist. Any valid email domain is accepted, exactly as
   * everywhere else in the app.
   */
  async login(dto: LoginDto) {
    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials.');

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials.');

    // A deleted account that had to be deactivated (it has tickets/history)
    // must not be able to sign in again. Same generic message as a bad
    // password so the endpoint stays non-enumerating.
    if (!user.isActive) throw new UnauthorizedException('Invalid credentials.');

    return this.buildSession(user);
  }

  /**
   * POST /auth/forgot-password — public, step 1 of recovery.
   *
   * Passwords are bcrypt-hashed, so they can never be *retrieved* — the
   * capability is to **reset** one. The answer is always the generic message
   * (registered or not, active or not) so the endpoint cannot enumerate
   * accounts. When the account does exist and is active, a single-use token is
   * generated, stored only as a SHA-256 hash with an expiry, and the reset link
   * is handed to MailService.
   *
   * Outside production the one-time token is also returned in the response
   * (unless `PASSWORD_RESET_RETURN_TOKEN=false`) so the flow is demonstrable
   * with no mail server; in production that switch defaults off.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const generic = { message: GENERIC_FORGOT_MESSAGE };

    const user = await this.users.findByEmail(dto.email);
    if (!user || !user.isActive) return generic;

    const token = randomBytes(32).toString('hex');
    const ttlMinutes = this.resetTtlMinutes;
    await this.users.setPasswordResetToken(
      user.id,
      AuthService.hashToken(token),
      Date.now() + ttlMinutes * 60_000,
    );

    const resetUrl = `${this.baseUrl}/?resetToken=${token}`;
    const delivery = await this.mail.send({
      to: user.email,
      subject: 'Reset your Eurisko Hub password',
      text: [
        `Hi ${user.name},`,
        '',
        'Someone asked to reset the password for this Eurisko Hub account.',
        `Open this link within ${ttlMinutes} minutes to choose a new password:`,
        '',
        resetUrl,
        '',
        'If you did not ask for this, you can ignore this message — your',
        'password has not changed.',
      ].join('\n'),
    });

    return this.exposeResetToken ? { ...generic, resetToken: token, resetUrl, delivery } : generic;
  }

  /**
   * POST /auth/reset-password — public, step 2 of recovery.
   *
   * Accepts the one-time token from the link and the new password. An unknown,
   * already-used or expired token gets one generic 400; on success the password
   * is replaced and the token is consumed, so the same link cannot be replayed.
   */
  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.users.findByResetTokenHash(
      AuthService.hashToken(dto.token),
    );
    if (
      !user ||
      !user.passwordResetExpiresAt ||
      user.passwordResetExpiresAt < Date.now()
    ) {
      throw new BadRequestException(
        'This password reset link is invalid or has expired.',
      );
    }

    await this.users.setPassword(user.id, dto.password);
    return {
      message:
        'Your password has been changed. You can sign in with your new password.',
    };
  }

  /**
   * POST /auth/change-password — authenticated. The signed-in user chooses a
   * new password by proving the current one, so possessing a session token is
   * not by itself enough to take the account over.
   */
  async changePassword(userId: number, dto: ChangePasswordDto) {
    const user = await this.users.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) {
      throw new BadRequestException('Your current password is incorrect.');
    }

    await this.users.setPassword(user.id, dto.newPassword);
    return { message: 'Your password has been changed.' };
  }

  private buildSession(user: {
    id: number;
    email: string;
    name: string;
    role: string;
  }) {
    const { passwordHash: _ph, ...safe } = user as any;
    const accessToken = this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    return { accessToken, user: safe };
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private get resetTtlMinutes(): number {
    const minutes = Number(
      process.env.PASSWORD_RESET_TTL_MINUTES ?? DEFAULT_RESET_TTL_MINUTES,
    );
    return Number.isFinite(minutes) && minutes > 0
      ? minutes
      : DEFAULT_RESET_TTL_MINUTES;
  }

  private get baseUrl(): string {
    return (process.env.APP_BASE_URL ?? 'http://localhost:5173').replace(
      /\/+$/,
      '',
    );
  }

  /**
   * Returning a live reset token in the HTTP response is a development
   * convenience, **never** a production behaviour: `NODE_ENV=production` always
   * suppresses it, and outside production it can be switched off explicitly
   * with `PASSWORD_RESET_RETURN_TOKEN=false`. Real deployments deliver the link
   * by mail (see MailService) and leave this off.
   */
  private get exposeResetToken(): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    return process.env.PASSWORD_RESET_RETURN_TOKEN !== 'false';
  }
}
