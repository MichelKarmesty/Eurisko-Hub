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
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
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
}

/** Admin-only user management (RBAC: agents/admin are provisioned by Admin). */
@Controller('users')
@Roles('Admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@Query() query: ListUsersQuery) {
    // Removed/deactivated accounts are hidden from the Admin's Users list.
    const all = await this.users.findActive();
    return query.role ? all.filter((u) => u.role === query.role) : all;
  }

  @Post()
  async create(@Body() dto: CreateUserDto) {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('A user with this email already exists.');
    }
    const user = await this.users.create(dto);
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
