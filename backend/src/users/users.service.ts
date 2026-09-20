import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './user.entity';
import { Role } from '../common/domain';
import { Ticket } from '../tickets/ticket.entity';
import { TicketEvent } from '../tickets/ticket-event.entity';

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role: Role;
}

/** Outcome of an Admin deleting an account. */
export interface DeleteAccountResult {
  id: number;
  email: string;
  /** `deleted` = the row is gone; `deactivated` = kept for audit, signed out. */
  mode: 'deleted' | 'deactivated';
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(TicketEvent)
    private readonly events: Repository<TicketEvent>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({ where: { email: email.toLowerCase() } });
  }

  async findById(id: number): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  /**
   * Every user holding `role`. The Admin seed uses this to detect a database
   * that has no Admin at all (and would otherwise be locked out).
   */
  findByRole(role: Role): Promise<User[]> {
    return this.users.find({ where: { role }, order: { id: 'ASC' } });
  }

  async create(input: CreateUserInput): Promise<User> {
    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = this.users.create({
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash,
      role: input.role,
    });
    return this.users.save(user);
  }

  /**
   * Re-provision a **deactivated** account in place (ADR-004).
   *
   * A deactivated row still owns its email address, because tickets/history
   * reference it. Rather than forcing the Admin to hunt for the old row, creating
   * an account with that address **revives it**: the same row is renamed,
   * re-roled, re-passwords and switched back on, so every historical reference
   * (`requesterId`, `assignedToId`, `resolvedById`, event actors) still points at
   * the same id instead of dangling.
   *
   * Only ever called for an account that is `isActive === false`; an **active**
   * account keeps the plain 409 — someone still has access with that address, and
   * silently taking it over would be wrong.
   */
  async revive(
    id: number,
    input: CreateUserInput,
  ): Promise<User | null> {
    const user = await this.findById(id);
    if (!user) return null;

    user.name = input.name;
    user.role = input.role;
    user.email = input.email.toLowerCase();
    user.passwordHash = await bcrypt.hash(input.password, 10);
    user.isActive = true;
    // A revived account starts clean: any stale reset link dies with the switch.
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    return this.users.save(user);
  }

  /**
   * Password recovery (ADR-007): store the SHA-256 hash of a fresh one-time
   * reset token with its expiry. Used by the Admin-issued link
   * (`POST /users/:id/reset-password`) and the offline `scripts/reset-password.mjs`
   * break-glass. The raw token is never stored.
   */
  async setPasswordResetToken(
    id: number,
    tokenHash: string,
    expiresAt: number,
  ): Promise<void> {
    await this.users.update(id, {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
    });
  }

  /** Resolve the account a reset token belongs to (lookup by token hash). */
  findByResetTokenHash(tokenHash: string): Promise<User | null> {
    return this.users.findOne({ where: { passwordResetTokenHash: tokenHash } });
  }

  /**
   * Set a new password (bcrypt-hashed) and consume any outstanding reset token.
   * Used by both `POST /auth/reset-password` and `POST /auth/change-password`,
   * so a reset link can never be replayed after the password has moved on.
   */
  async setPassword(id: number, plainPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    await this.users.update(id, {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    });
  }

  /**
   * Admin action: set an account's password **directly**
   * (`PATCH /users/:id/password`, ADR-011).
   *
   * The Admin-issued link (ADR-007) has the employee choose their own password,
   * which is the better shape — but it needs the person to open the link. When
   * the Admin is standing next to them, or resetting a demo/test account, they
   * can set the password here instead. The password is bcrypt-hashed like any
   * other, and setting it **clears any pending reset link** (`setPassword` above),
   * so an old link can never outlive the change.
   *
   * A deactivated account is refused (400): it cannot sign in, so a password
   * would be misleading (same rule as issuing a link).
   */
  async setPasswordFor(id: number, plainPassword: string): Promise<User | null> {
    const user = await this.findById(id);
    if (!user) return null;
    if (!user.isActive) {
      throw new BadRequestException(
        'This account is deactivated — reactivate it before setting a password.',
      );
    }
    await this.setPassword(id, plainPassword);
    return user;
  }

  /**
   * Admin action: change an account's role (`PATCH /users/:id/role`).
   *
   * A demotion can empty the Admin seat just as effectively as a delete, so the
   * same "a database can never be locked out" rule applies (ADR-004,
   * docs/security.md) — and it is enforced here, at the API boundary, not in the
   * Users tab:
   *
   *  - an Admin can never change their **own** Admin role (400): that is how a
   *    session would remove its own ability to manage accounts mid-request;
   *  - the **last remaining active Admin** can never be demoted (400).
   *
   * Promoting somebody to Admin, and any change that leaves at least one active
   * Admin in place, is allowed.
   */
  async updateRole(
    id: number,
    role: Role,
    actingUserId: number,
  ): Promise<User | null> {
    const user = await this.findById(id);
    if (!user) return null;

    const demotesAnActiveAdmin =
      user.role === 'Admin' && user.isActive && role !== 'Admin';

    if (demotesAnActiveAdmin) {
      if (user.id === actingUserId) {
        throw new BadRequestException('You cannot change your own Admin role.');
      }
      if ((await this.countActiveAdmins()) <= 1) {
        throw new BadRequestException(
          'The last active Admin cannot be demoted — the hub would be locked out.',
        );
      }
    }

    user.role = role;
    return this.users.save(user);
  }

  findAll(): Promise<User[]> {
    return this.users.find({ order: { id: 'ASC' } });
  }

  /** The Users list the Admin sees: removed/deactivated accounts are hidden. */
  findActive(): Promise<User[]> {
    return this.users.find({ where: { isActive: true }, order: { id: 'ASC' } });
  }

  count(): Promise<number> {
    return this.users.count();
  }

  countActiveAdmins(): Promise<number> {
    return this.users.count({ where: { role: 'Admin', isActive: true } });
  }

  /**
   * Admin action: remove an account (`DELETE /users/:id`).
   *
   * Rules:
   *  - an Admin can never delete their own account (400) — that is how a
   *    session would lock itself out mid-request;
   *  - the last remaining active Admin can never be deleted (400), matching the
   *    "a database can never be locked out" rule (ADR-004);
   *  - an account with no tickets and no history is hard-deleted;
   *  - an account that is referenced by tickets/history is deactivated instead,
   *    so the audit trail stays intact (returns `mode: 'deactivated'`).
   *
   * "Referenced by tickets" includes being the **assignee** (`assignedToId`) or
   * the **resolver** (`resolvedById`), not only the requester or the actor of an
   * event: an Admin-assigned agent may own no event of their own, and deleting
   * them would leave the live ticket pointing at a row that no longer exists.
   */
  async deleteAccount(
    id: number,
    actingUserId: number,
  ): Promise<DeleteAccountResult | null> {
    const user = await this.findById(id);
    if (!user) return null;

    if (user.id === actingUserId) {
      throw new BadRequestException('You cannot delete your own account.');
    }
    if (
      user.role === 'Admin' &&
      user.isActive &&
      (await this.countActiveAdmins()) <= 1
    ) {
      throw new BadRequestException(
        'The last active Admin cannot be deleted — the hub would be locked out.',
      );
    }

    const [openedTickets, assignedTickets, resolvedTickets, historyEvents] =
      await Promise.all([
        this.tickets.count({ where: { requesterId: id } }),
        this.tickets.count({ where: { assignedToId: id } }),
        this.tickets.count({ where: { resolvedById: id } }),
        this.events.count({ where: { actorId: id } }),
      ]);

    if (
      openedTickets + assignedTickets + resolvedTickets + historyEvents ===
      0
    ) {
      await this.users.delete(id);
      return { id: user.id, email: user.email, mode: 'deleted' };
    }

    user.isActive = false;
    await this.users.save(user);
    return { id: user.id, email: user.email, mode: 'deactivated' };
  }

  /**
   * Admin action: activate or deactivate an account
   * (`PATCH /users/:id/active`).
   *
   * **Reactivating is how an address comes back into use.** A deactivated row
   * keeps its email — its tickets/history still reference it — so `POST /users`
   * rightly refuses the duplicate. Instead of a second row, the Admin restores
   * *that* account (Users → **Reactivate**), which keeps every historical
   * reference pointing at the same person.
   *
   * Deactivating is the revoke half of the same switch and follows the
   * "a database can never be locked out" rule (ADR-004):
   *  - an Admin can never deactivate their **own** account (400) — that is how a
   *    session would revoke itself mid-request;
   *  - the last remaining active Admin can never be deactivated (400).
   *
   * The call is idempotent: setting the state an account already has is a no-op
   * that returns the account.
   */
  async setActive(
    id: number,
    active: boolean,
    actingUserId: number,
  ): Promise<User | null> {
    const user = await this.findById(id);
    if (!user) return null;

    if (!active && user.isActive) {
      if (user.id === actingUserId) {
        throw new BadRequestException('You cannot deactivate your own account.');
      }
      if (user.role === 'Admin' && (await this.countActiveAdmins()) <= 1) {
        throw new BadRequestException(
          'The last active Admin cannot be deactivated — the hub would be locked out.',
        );
      }
    }

    if (user.isActive !== active) {
      user.isActive = active;
      await this.users.save(user);
    }
    return user;
  }
}
