import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { publicUser, User } from '../users/user.entity';
import { MailService } from '../mail/mail.service';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, ResetPasswordDto } from './dto';

/** Reset links live for 30 minutes unless PASSWORD_RESET_TTL_MINUTES says otherwise. */
const DEFAULT_RESET_TTL_MINUTES = 30;
/** One forgot-password email per address per 60 s unless overridden. */
const DEFAULT_FORGOT_COOLDOWN_SECONDS = 60;
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
   * POST /auth/login - accounts are created by an Admin via `POST /users`
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
   * POST /auth/forgot-password - public, step 1 of recovery (ADR-008).
   *
   * Passwords are bcrypt-hashed, so they can never be *retrieved* - the
   * capability is to **reset** one. The answer is always the generic message
   * (registered or not, active or not) so the endpoint cannot enumerate
   * accounts. When the account does exist and is active, a single-use token is
   * generated, stored only as a SHA-256 hash with an expiry, and the reset link
   * is handed to MailService (SMTP → webhook → Resend → console).
   *
   * A per-email cooldown (`PASSWORD_RESET_COOLDOWN_SECONDS`, default 60) stops
   * the endpoint being used to mail-bomb a victim: a repeat request inside the
   * window gets the same generic answer but mints nothing and sends nothing.
   *
   * Outside production the one-time token is also returned in the response
   * (unless `PASSWORD_RESET_RETURN_TOKEN=false`) so the flow is demonstrable
   * with no mail server; in production that switch defaults off.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const generic = { message: GENERIC_FORGOT_MESSAGE };

    const user = await this.users.findByEmail(dto.email);
    if (!user || !user.isActive) return generic;

    const cooldownKey = dto.email.trim().toLowerCase();
    const now = Date.now();
    const lastSent = this.forgotCooldowns.get(cooldownKey);
    if (lastSent !== undefined && now - lastSent < this.forgotCooldownMs) {
      return generic;
    }
    this.forgotCooldowns.set(cooldownKey, now);

    const token = randomBytes(32).toString('hex');
    const ttlMinutes = this.resetTtlMinutes;
    await this.users.setPasswordResetToken(
      user.id,
      AuthService.hashToken(token),
      now + ttlMinutes * 60_000,
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

    return this.exposeResetToken
      ? { ...generic, resetToken: token, resetUrl, delivery }
      : generic;
  }

  /**
   * POST /auth/reset-password - public, step 2 of recovery.
   *
   * Accepts a one-time token from a reset link - emailed by the self-service
   * flow (ADR-008, `POST /auth/forgot-password`), **Admin-issued** (ADR-007,
   * `POST /users/:id/reset-password`), or minted offline by
   * `scripts/reset-password.mjs` - plus the new password. An unknown,
   * already-used or expired token gets one generic 400; on success the password
   * is replaced and the token is consumed, so the same link cannot be replayed.
   */
  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.users.findByResetTokenHash(
      AuthService.hashToken(dto.token),
    );
    if (
      !user ||
      !user.isActive ||
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
   * POST /auth/change-password - authenticated. The signed-in user chooses a
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

  /**
   * POST /users/:id/reset-password - **Admin-initiated** recovery (ADR-007).
   *
   * Alongside the self-service flow (ADR-008, `POST /auth/forgot-password`), an
   * Admin can mint a single-use, hashed, time-limited token for a colleague who
   * forgot their password and hand them the link, so the Admin never sees or
   * chooses the password - the employee sets their own through the shared
   * `POST /auth/reset-password` (docs/security.md).
   *
   * Returns `null` when the account does not exist (the controller maps that to
   * 404). An **inactive** account is refused (400): it cannot sign in at all, so
   * a reset link would be misleading. The token storage/lookup is shared with the
   * email flow and the offline `scripts/reset-password.mjs` break-glass.
   */
  async issuePasswordReset(targetId: number) {
    const user = await this.users.findById(targetId);
    if (!user) return null;

    if (!user.isActive) {
      throw new BadRequestException(
        'This account is deactivated — reactivate it before issuing a reset link.',
      );
    }

    const token = randomBytes(32).toString('hex');
    const ttlMinutes = this.resetTtlMinutes;
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    await this.users.setPasswordResetToken(
      user.id,
      AuthService.hashToken(token),
      expiresAt,
    );

    // The raw token is returned here by design: handing it to the employee *is*
    // the delivery mechanism (ADR-007). It is single-use and expires; see
    // docs/security.md.
    return {
      id: user.id,
      email: user.email,
      resetToken: token,
      resetUrl: `${this.baseUrl}/?resetToken=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInMinutes: ttlMinutes,
    };
  }

  /**
   * `POST /auth/login` - the token plus the public view of the account.
   *
   * The body is built by `publicUser()`, not by spreading the entity: a spread
   * drops `@Exclude()`, so a pending password reset would put its token hash and
   * expiry into the login response (docs/security.md says it never appears).
   */
  private buildSession(user: User) {
    const accessToken = this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    return { accessToken, user: publicUser(user) };
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Anti mail-bomb cooldown for `POST /auth/forgot-password`: at most one
   * reset email per address per window. In-memory on purpose - a process
   * restart merely resets the window, it can never lock a user out.
   */
  private readonly forgotCooldowns = new Map<string, number>();

  private get forgotCooldownMs(): number {
    const seconds = Number(
      process.env.PASSWORD_RESET_COOLDOWN_SECONDS ?? DEFAULT_FORGOT_COOLDOWN_SECONDS,
    );
    return Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : DEFAULT_FORGOT_COOLDOWN_SECONDS * 1000;
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
    const url = process.env.APP_BASE_URL;
    if (!url && process.env.NODE_ENV === 'production') {
      // Startup already refused to bind if APP_BASE_URL is absent (main.ts).
      // This fallback only fires in tests that set NODE_ENV=production without
      // a full server context; log and fall back so the request doesn't 500.
      console.warn(
        '[AuthService] APP_BASE_URL is not set in production — reset links will point at localhost.',
      );
    }
    return (url ?? 'http://localhost:5173').replace(/\/+$/, '');
  }

  /**
   * Self-service "forgot password" (ADR-008) is **off by default** (ADR-009):
   * recovery is Admin-initiated (ADR-007) and the Admin hands over the one-time
   * link. An operator who wants the public, emailed path back switches it on with
   * `PASSWORD_RESET_SELF_SERVICE=true`; the route then answers 404→200 as usual
   * and MailService delivers the link (see `docs/security.md`).
   */
  get selfServiceResetEnabled(): boolean {
    return (
      (process.env.PASSWORD_RESET_SELF_SERVICE ?? 'false').toLowerCase() === 'true'
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
