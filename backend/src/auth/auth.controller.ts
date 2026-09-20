import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
} from './dto';
import { AuthUser, CurrentUser, Public } from '../common/auth.decorators';

/**
 * Authentication. There is deliberately **no public registration**: this is an
 * internal tool and every account is provisioned by an Admin through
 * `POST /users` (ADR-004). Any real email address is accepted (Gmail, Hotmail/
 * Outlook, Yahoo, a company domain…); the app never restricts accounts to one
 * domain.
 *
 * Public routes: `POST /auth/login` and `POST /auth/reset-password` (which
 * completes a reset). **Recovery is Admin-initiated** (ADR-007/ADR-009): the
 * Admin mints a one-time link with `POST /users/:id/reset-password` and hands it
 * over, so the employee sets their own password and the Admin never sees it.
 * `POST /auth/forgot-password` (the self-service, emailed path of ADR-008) is
 * **off by default** and only answers when the operator sets
 * `PASSWORD_RESET_SELF_SERVICE=true`. Changing a password while signed in
 * (`POST /auth/change-password`) requires a bearer token.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** POST /auth/login — public; returns { accessToken, user }. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /**
   * POST /auth/forgot-password — **off by default** (ADR-009).
   *
   * Recovery is Admin-initiated: an Admin mints a one-time link
   * (`POST /users/:id/reset-password`) and hands it over. The public, emailed
   * path exists but is disabled unless the operator sets
   * `PASSWORD_RESET_SELF_SERVICE=true`; while it is off the route answers `404`,
   * exactly as if it did not exist. When enabled it always answers the same
   * generic message so it cannot enumerate accounts, and the reset link is
   * emailed (see MailService for the transports).
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    if (!this.auth.selfServiceResetEnabled) {
      throw new NotFoundException('Cannot POST /auth/forgot-password');
    }
    return this.auth.forgotPassword(dto);
  }

  /**
   * POST /auth/reset-password — public, step 2. Completes the reset with the
   * one-time token from an emailed or Admin-issued link plus the new password.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  /**
   * POST /auth/change-password — signed in. Changes the caller's own password
   * and requires the current one.
   */
  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.auth.changePassword(user.id, dto);
  }

  /** GET /auth/me — current profile for the bearer token. */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, role: user.role };
  }
}
