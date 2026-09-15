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
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ROLES, Role } from '../common/domain';

class CreateUserDto {
  @IsString()
  @MinLength(2)
  name: string;

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
    const { passwordHash: _ph, ...safe } = user;
    return safe;
  }

  @Patch(':id/role')
  async updateRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserRoleDto,
  ) {
    const user = await this.users.updateRole(id, dto.role);
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    const { passwordHash: _ph, ...safe } = user;
    return safe;
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
