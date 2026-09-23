import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { IS_PUBLIC_KEY } from './auth.decorators';
import type { AuthUser } from './auth.decorators';
import { Role } from './domain';
import { User, publicUser } from '../users/user.entity';

/**
 * Global guard: requires a valid `Authorization: Bearer <jwt>` on every route
 * except those marked @Public(). Attaches the account's public profile
 * (`{ id, name, email, role, isActive, createdAt }`) as request.user.
 *
 * The token is only proof that a session *was* issued: the account behind it is
 * re-read on every request. That is what makes removing or deactivating an
 * account (`DELETE /users/:id`) revoke its sessions **at once** instead of
 * leaving a dead account able to claim tickets until the JWT expires
 * (docs/security.md; the default `JWT_EXPIRES_IN` is 8h). It also makes a role
 * change take effect on the next request rather than on the next login.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const auth = request.headers?.authorization as string | undefined;
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    let payload: { sub?: number };
    try {
      payload = await this.jwtService.verifyAsync(auth.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    const user = await this.dataSource
      .getRepository(User)
      .findOne({ where: { id: Number(payload.sub) } });

    // A missing row (really deleted) or a deactivated one is the same answer as
    // a bad token: the caller must sign in again, and cannot sign in.
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    // The public profile, not just the token's claims: GET /auth/me answers with
    // this object, and the UI needs the account's name to render its top bar.
    request.user = publicUser(user) as AuthUser;
    return true;
  }
}
