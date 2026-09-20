import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { publicUser } from './user.entity';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ROLES, Role } from '../common/domain';

class CreateUserDto {
  @IsString()
  @MinLength(2)
  name: string;

  // Any real email address is accepted (Gmail, Hotmail/Outlook, Yahoo, a
  // company domain) — no domain restriction anywhere (ADR-005).
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsIn(ROLES)
  role: Role;
}

class UpdateUserRoleDto {
  @IsIn(ROLES)
  role: Role;
}

class ListUsersQuery {
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;

  /**
   * `?includeInactive=true` — the Users tab asks for every row, so an account
   * that was deactivated (because ticket history references it) stays visible
   * and can be **reactivated** instead of blocking its email address forever.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  includeInactive?: string;
}

class SetUserActiveDto {
  /** `true` reactivates a deactivated account; `false` revokes the login. */
  @IsBoolean()
  active: boolean;
}

/** Admin-only user management (RBAC: agents/admin are provisioned by Admin). */
@Controller('users')
@Roles('Admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@Query() query: ListUsersQuery) {
    // The Admin's Users tab asks for everything, so deactivated accounts stay
    // visible and can be reactivated (default: active accounts only).
    const all =
      query.includeInactive === 'true'
        ? await this.users.findAll()
        : await this.users.findActive();
    return query.role ? all.filter((u) => u.role === query.role) : all;
  }

  @Post()
  async create(@Body() dto: CreateUserDto) {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      // A deactivated account still holds its address (its history references
      // it), so re-creating it is refused — reactivating is the way back.
      throw new ConflictException(
        existing.isActive
          ? 'A user with this email already exists.'
          : 'That email belongs to a deactivated account kept for audit — reactivate it instead of creating a new one.',
      );
    }
    const user = await this.users.create(dto);
    return publicUser(user);
  }

  /**
   * `PATCH /users/:id/active` — Admin reactivates or deactivates an account.
   *
   * Reactivating restores a deactivated account (the supported way to bring an
   * address back, because the row keeps the email). Deactivating revokes the
   * login at once; like deletion and demotion it refuses your own account (400)
   * and the last active Admin (400) — see UsersService.setActive.
   */
  @Patch(':id/active')
  async setActive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetUserActiveDto,
    @CurrentUser() actor: AuthUser,
  ) {
    const user = await this.users.setActive(id, dto.active, actor.id);
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    return publicUser(user);
  }

  /**
   * `PATCH /users/:id/role` — Admin changes an account's role.
   *
   * The same "a database can never be locked out" rule as deletion applies to
   * demotions (ADR-004): an Admin cannot change their own Admin role (400) and
   * the last active Admin cannot be demoted (400). See UsersService.updateRole.
   */
  @Patch(':id/role')
  async updateRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() actor: AuthUser,
  ) {
    const user = await this.users.updateRole(id, dto.role, actor.id);
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    return publicUser(user);
  }

  /**
   * `DELETE /users/:id` — Admin deletes any account (Employee, IT/HR/
   * Maintenance agent, or another Admin).
   *
   * An account with no tickets/history is really deleted; one that appears in
   * tickets/history is deactivated instead so the audit trail survives. Either
   * way the account disappears from the Users list and can no longer sign in.
   * Deleting yourself (400) and deleting the last active Admin (400) are
   * refused.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ) {
    const result = await this.users.deleteAccount(id, actor.id);
    if (!result) throw new NotFoundException(`User ${id} not found.`);
    return result;
  }
}
