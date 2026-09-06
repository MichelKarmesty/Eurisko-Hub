import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from './domain';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as accessible without a JWT (e.g. register / login). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restricts a route to the given roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** Current authenticated user ({ id, email, role }) attached by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}
