import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RegisterDto, LoginDto } from './dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  /** POST /auth/register — employees self-register (role defaults to Employee). */
  async register(dto: RegisterDto) {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) throw new ConflictException('A user with this email already exists.');

    const role = dto.role ?? 'Employee';
    if (role !== 'Employee') {
      // RBAC: agent/admin accounts are provisioned by an Admin via POST /users.
      throw new ForbiddenException(
        'Self-registration only creates Employee accounts. Ask an Admin to provision agent accounts.',
      );
    }

    const user = await this.users.create({
      name: dto.name,
      email: dto.email,
      password: dto.password,
      role,
    });
    return this.buildSession(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials.');

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials.');

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
