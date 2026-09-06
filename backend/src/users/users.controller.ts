import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { Roles } from '../common/auth.decorators';
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
    const all = await this.users.findAll();
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
}
