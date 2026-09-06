import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto';
import { AuthUser, CurrentUser, Public } from '../common/auth.decorators';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** POST /auth/register — public; creates an Employee account. */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

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
