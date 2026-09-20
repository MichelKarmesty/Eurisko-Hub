import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';

/**
 * `POST /users/:id/reset-password` — Admin-initiated password recovery
 * (ADR-007, docs/api.md §Admin, docs/security.md).
 *
 * Why it lives in the auth module rather than UsersModule: it is a credential
 * operation and reuses `AuthService`'s token machinery (hash, TTL, reset URL).
 * The route keeps the `/users` prefix so it sits with the other account actions
 * the Admin already has, without making UsersModule depend on AuthModule (which
 * would be circular — AuthModule already imports UsersModule).
 *
 * Authorization is the global `RolesGuard` reading the class-level
 * `@Roles('Admin')`; an unauthenticated caller is rejected 401 by the global
 * `JwtAuthGuard` first. An Admin may reset any account, including another Admin
 * and themselves — the link is single-use and expires (docs/security.md).
 */
@Controller('users')
@Roles('Admin')
export class AdminResetController {
  private readonly logger = new Logger('AdminReset');

  constructor(private readonly auth: AuthService) {}

  /** POST /users/:id/reset-password -> `{ resetToken, resetUrl, expiresAt, … }`. */
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ) {
    const result = await this.auth.issuePasswordReset(id);
    if (!result) throw new NotFoundException(`User ${id} not found.`);

    // An Admin can hand out a live credential link, so who acted and for whom
    // is recorded. There is no user-action audit table (only tickets carry
    // events), so the log is the trace — see docs/security.md §"Admin reset".
    this.logger.log(
      `Admin ${actor.email} issued a password reset link for ${result.email} ` +
        `(user ${result.id}); expires in ${result.expiresInMinutes} min.`,
    );

    return result;
  }
}
