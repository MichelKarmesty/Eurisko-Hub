import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto';
import { AuthUser, CurrentUser, Public } from '../common/auth.decorators';

/**
 * Authentication. There is deliberately **no public registration**: this is an
 * internal tool and every account is provisioned by an Admin through
 * `POST /users` (ADR-004). `POST /auth/login` is the only public auth entry.
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

  /** GET /auth/me — current profile for the bearer token. */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, role: user.role };
  }
}
