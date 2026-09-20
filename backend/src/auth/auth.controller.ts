import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
 * Public routes: `POST /auth/login`, `POST /auth/forgot-password` and
 * `POST /auth/reset-password`. Changing a password while signed in
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
   * POST /auth/forgot-password — public. "I forgot my password": starts the
   * reset by email. Always returns the same generic message so the endpoint
   * cannot reveal which emails are registered.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  /**
   * POST /auth/reset-password — public. Completes the reset with the one-time
   * token from the link plus the new password.
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
