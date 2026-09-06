import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { ROLES, Role } from '../common/domain';

/** POST /auth/register — employees register themselves. */
export class RegisterDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  /**
   * Self-registration defaults to Employee. Agent/Admin accounts are created
   * by an Admin via POST /users (RBAC per product-spec.md §3).
   */
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;
}

/** POST /auth/login */
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
