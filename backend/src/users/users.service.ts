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
   * Password recovery (`POST /auth/forgot-password`): store the SHA-256 hash of
   * a fresh one-time reset token with its expiry. The raw token is never stored.
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
}
