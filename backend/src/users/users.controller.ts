import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
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
  // company domain) - no domain restriction anywhere (ADR-005).
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
   * `?includeInactive=true` - the Users tab asks for every row, so an account
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

class SetUserPasswordDto {
  /** The new password, hashed before it is stored - never echoed back. */
  @IsString()
  @MinLength(8)
  password: string;
}

/** Admin-only user management (RBAC: agents/admin are provisioned by Admin). */
@Controller('users')
@Roles('Admin')
export class UsersController {
  /** Trace for the one action where an Admin handles a credential (ADR-011). */
  private readonly logger = new Logger('AdminPassword');

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
      if (!existing.isActive) {
        // A deactivated row still owns the address (tickets/history reference it).
        // Creating the account again re-provisions **that** row, so history keeps
        // pointing at the same id instead of the address being unusable forever.
        const revived = await this.users.revive(existing.id, dto);
        if (!revived) throw new NotFoundException(`User ${existing.id} not found.`);
        return publicUser(revived);
      }
      // An active account genuinely holds the address - do not silently take it over.
      throw new ConflictException(
        'A user with this email already exists and is active — deactivate that account first (Users → Deactivate), then create it again, or sign in with it.',
      );
    }
    const user = await this.users.create(dto);
    return publicUser(user);
  }

  /**
   * `PATCH /users/:id/active` - Admin reactivates or deactivates an account.
   *
   * Reactivating restores a deactivated account (the supported way to bring an
   * address back, because the row keeps the email). Deactivating revokes the
   * login at once; like deletion and demotion it refuses your own account (400)
   * and the last active Admin (400) - see UsersService.setActive.
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
   * `PATCH /users/:id/role` - Admin changes an account's role.
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
   * `PATCH /users/:id/password` - Admin sets an account's password **directly**
   * (ADR-011), as an alternative to handing over the one-time link.
   *
   * The password is hashed and any pending reset link is cleared, so the Admin
   * can tell the person the password and let them change it (top-bar **Change
   * password**). The action is logged: the Admin now knows a credential, so the
   * `AdminPassword` logger records who set a password for whom.
   */
  @Patch(':id/password')
  @HttpCode(HttpStatus.OK)
  async setPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetUserPasswordDto,
    @CurrentUser() actor: AuthUser,
  ) {
    const user = await this.users.setPasswordFor(id, dto.password);
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    this.logger.log(
      `Admin ${actor.email} set a new password for ${user.email} (user ${user.id}).`,
    );
    return { id: user.id, email: user.email };
  }

  /**
   * `DELETE /users/:id` - Admin deletes any account (Employee, IT/HR/
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
