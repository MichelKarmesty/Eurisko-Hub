import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * POST /auth/login — the only public auth entry point. Accounts are created
   * by an Admin via `POST /users` (ADR-004); there is no self-registration.
   * A wrong email and a wrong password return the same generic error so the
   * endpoint cannot be used to discover which emails exist.
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
}
