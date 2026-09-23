import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from './domain';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as accessible without a JWT (e.g. login). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restricts a route to the given roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** Current authenticated user (the public profile) attached by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

/**
 * The authenticated caller, exactly as the guard attaches it: the account's
 * **public profile** (`publicUser`), not the token's claims.
 *
 * It must stay a complete profile, because `GET /auth/me` answers with this
 * object verbatim and the UI renders the top bar (name, role) from it. Returning
 * only `{ id, email, role }` here is what made a restored session crash the
 * client with "Cannot read properties of undefined (reading 'split')".
 */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  isActive?: boolean;
  createdAt?: string | Date;
}
