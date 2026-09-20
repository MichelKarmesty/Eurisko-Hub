import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ROLE_DEPARTMENT,
  STATUS_ORDER,
  isAdminRole,
  isAgentRole,
  statusCanTransition,
  TicketStatus,
} from '../common/domain';
import { AuthUser } from '../common/auth.decorators';
import { UsersService } from '../users/users.service';
import { Ticket } from './ticket.entity';
import { TicketAction, TicketEvent } from './ticket-event.entity';

export interface CreateTicketInput {
  title: string;
  description: string;
  category: 'IT' | 'HR' | 'Maintenance';
  priority: 'Low' | 'Medium' | 'High';
}

export interface TicketListQuery {
  category?: string;
  status?: string;
  priority?: string;
  mine?: string; // "true" -> only tickets claimed by the current agent
}

/**
 * Ticket lifecycle (docs/data-model.md §2, docs/api.md):
 *   Open -> In Progress -> Resolved
 *
 * - Open:        created by the requester and sitting in the department
 *                queue, waiting for an agent to claim it (ADR-001)
 * - In Progress: an agent claimed it and is working on it
 * - Resolved:    done; requires a resolution note (data-model.md §2)
 *
 * A ticket never skips a step: claim moves Open -> In Progress; the status
 * endpoint moves In Progress -> Resolved.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger('Tickets');

  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(TicketEvent)
    private readonly events: Repository<TicketEvent>,
    private readonly users: UsersService,
  ) {}

  /**
   * POST /tickets — any authenticated user opens a ticket in their name.
   * The ticket is created OPEN and immediately joins its department queue
   * (ADR-001: status remains Open until an agent explicitly claims it).
   */
  async create(user: AuthUser, input: CreateTicketInput): Promise<Ticket> {
    const ticket = this.tickets.create({
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      status: 'Open',
      requesterId: user.id,
      assignedToId: null,
      resolvedById: null,
      resolutionNote: null,
    });
    const saved = await this.tickets.save(ticket);
    await this.events.save(
      this.events.create({
        ticketId: saved.id,
        actorId: user.id,
        action: 'CREATED',
        fromStatus: null,
        toStatus: 'Open',
        note: null,
      }),
    );
    return this.getById(saved.id, user); // attach requester relation
  }

  /**
   * RBAC-scoped listing (docs/data-model.md §4 Access Patterns):
   *  - Employee (Requester): SELECT * FROM tickets WHERE requester_id = me
   *  - Agent:                OPEN tickets in their department queue
   *                          (+ ?mine=true -> tickets they claimed)
   *  - Admin:                all tickets, optional filters
   */
  async list(user: AuthUser, query: TicketListQuery): Promise<Ticket[]> {
    const where: Record<string, unknown> = {};

    if (isAdminRole(user.role)) {
      // Global view (Admin Pattern) — filters allowed below.
    } else if (isAgentRole(user.role)) {
      // Agents are confined to their department (architecture.md §3, api.md).
      const department =
        ROLE_DEPARTMENT[user.role as keyof typeof ROLE_DEPARTMENT];
      if (query.category && query.category !== department) {
        throw new ForbiddenException(
          `Agents can only view the ${department} queue, not "${query.category}".`,
        );
      }
      where.category = department;
      if (query.mine === 'true') {
        // Tickets this agent has claimed (any status).
        where.assignedToId = user.id;
      } else {
        // Department queue: OPEN tickets waiting to be claimed (ADR-001).
        where.status = query.status ?? 'Open';
      }
    } else {
      // Requester Pattern: own tickets only.
      where.requesterId = user.id;
    }

    if (query.status && !where.status) where.status = query.status;
    if (query.category && !where.category) where.category = query.category;
    if (query.priority) where.priority = query.priority;

    return this.tickets.find({
      where,
      relations: { requester: true, assignedTo: true, resolvedBy: true },
      // Sequential, predictable order (oldest ticket number first) so lists
      // read 1,2,3,… instead of newest-first.
      order: { id: 'ASC' },
    });
  }

  /**
   * Access rule (data-model.md §2): requester owns it, an agent can read only
   * tickets of their department, Admin reads everything.
   */
  async getById(id: number, user: AuthUser): Promise<Ticket> {
    const ticket = await this.tickets.findOne({
      where: { id },
      relations: { requester: true, assignedTo: true, resolvedBy: true },
    });
    if (!ticket) throw new NotFoundException(`Ticket ${id} not found.`);

    const canRead =
      isAdminRole(user.role) ||
      ticket.requesterId === user.id ||
      (isAgentRole(user.role) &&
        ROLE_DEPARTMENT[user.role as keyof typeof ROLE_DEPARTMENT] ===
          ticket.category);
    if (!canRead) {
      throw new ForbiddenException('You are not allowed to view this ticket.');
    }
    return ticket;
  }

  /**
   * ADR-001: PATCH /tickets/:id/claim — an agent claims an OPEN, unclaimed
   * ticket from their own department queue. Sets assignedToId and moves the
   * status to In Progress. Already-claimed or non-Open tickets are rejected.
   */
  async claim(id: number, user: AuthUser): Promise<Ticket> {
    if (!isAgentRole(user.role)) {
      throw new ForbiddenException('Only agents can claim tickets.');
    }
    // getById also enforces that the agent belongs to the ticket's department.
    const ticket = await this.getById(id, user);
    if (ticket.status !== 'Open') {
      throw new ForbiddenException(
        `Only OPEN tickets can be claimed (current status: ${ticket.status}).`,
      );
    }
    if (ticket.assignedToId != null) {
      throw new ForbiddenException('This ticket is already claimed.');
    }
    // Conflict of interest: an agent must not handle a ticket they submitted
    // themselves — a colleague from the same department queue takes it.
    if (ticket.requesterId === user.id) {
      throw new ForbiddenException(
        'You cannot claim a ticket you submitted yourself — leave it for a colleague in the queue.',
      );
    }

    ticket.assignedToId = user.id;
    ticket.status = 'In Progress';
    const saved = await this.tickets.save(ticket);
    await this.events.save(
      this.events.create({
        ticketId: saved.id,
        actorId: user.id,
        action: 'CLAIMED',
        fromStatus: 'Open',
        toStatus: 'In Progress',
        note: `Claimed by ${user.email}`,
      }),
    );
    return this.getById(id, user);
  }

  /**
   * PATCH /tickets/:id/status — advance the ticket one step along the
   * documented lifecycle (Open -> In Progress -> Resolved). Only the
   * assigned agent (or an Admin) may change status, and moving to Resolved
   * requires a non-empty resolution note (data-model.md §2).
   *
   * ADR-002 (Admin override): an Admin may still act on a ticket that is not
   * assigned to them, but that is an explicit override — a non-empty
   * `overrideReason` is required and the change is recorded as an
   * ADMIN_OVERRIDE history event, so no ticket is ever silently closed
   * without an agent (or a stated reason).
   */
  async changeStatus(
    id: number,
    user: AuthUser,
    toStatus: 'In Progress' | 'Resolved',
    resolutionNote?: string,
    overrideReason?: string,
  ): Promise<Ticket> {
    const ticket = await this.getById(id, user);

    const isAssignedAgent =
      isAgentRole(user.role) && ticket.assignedToId === user.id;
    const isOverride =
      isAdminRole(user.role) && ticket.assignedToId !== user.id;
    const canAct = isAdminRole(user.role) || isAssignedAgent;
    if (!canAct) {
      throw new ForbiddenException(
        'Only the assigned agent (or an Admin) can change ticket status.',
      );
    }

    const fromStatus = ticket.status as TicketStatus;
    if (!statusCanTransition(fromStatus, toStatus)) {
      throw new ForbiddenException(
        `Invalid transition: ${fromStatus} -> ${toStatus}. Allowed transitions: ${fromStatus} -> ${
          STATUS_ORDER[STATUS_ORDER.indexOf(fromStatus) + 1]
        }.`,
      );
    }

    let overrideNote: string | null = null;
    if (isOverride) {
      overrideNote = (overrideReason ?? '').trim();
      if (!overrideNote) {
        // Governance rule (ADR-002): the override must be justified. A missing
        // body field is a client error (400), not an authorization problem.
        throw new BadRequestException(
          'An override reason is required when an Admin changes a ticket that is not assigned to them.',
        );
      }
    }

    if (toStatus === 'Resolved') {
      const note = (resolutionNote ?? '').trim();
      if (!note) {
        // Data-model.md §2: a ticket cannot move to Resolved without a
        // resolution note. A missing/invalid body field is a client error
        // (400), not an authorization problem (403).
        throw new BadRequestException(
          'A resolution note is required before resolving a ticket.',
        );
      }
      ticket.resolutionNote = note;
      // Name the real resolver (assigned agent, or Admin on an override).
      ticket.resolvedById = user.id;
    }

    ticket.status = toStatus;
    const saved = await this.tickets.save(ticket);

    const action: TicketAction = isOverride
      ? 'ADMIN_OVERRIDE'
      : toStatus === 'Resolved'
        ? 'RESOLVED'
        : 'STATUS_CHANGED';
    const note = isOverride
      ? [
          overrideNote,
          toStatus === 'Resolved' ? `Resolution: ${resolutionNote!.trim()}` : null,
        ]
          .filter(Boolean)
          .join(' — ')
      : toStatus === 'Resolved'
        ? resolutionNote!.trim()
        : null;

    await this.events.save(
      this.events.create({
        ticketId: saved.id,
        actorId: user.id,
        action,
        fromStatus,
        toStatus,
        note,
      }),
    );
    return this.getById(id, user);
  }

  /**
   * ADR-003: PATCH /tickets/:id/assign — an Admin gives an unclaimed ticket an
   * owner by assigning it to an agent of the matching department. Moves the
   * ticket Open -> In Progress (the documented claim transition) and records an
   * ASSIGNED event, so urgent work gets a named owner without an override.
   */
  async assign(
    id: number,
    user: AuthUser,
    assigneeId: number,
    note?: string,
  ): Promise<Ticket> {
    if (!isAdminRole(user.role)) {
      throw new ForbiddenException('Only an Admin can assign tickets.');
    }
    const ticket = await this.getById(id, user);
    if (ticket.status !== 'Open') {
      throw new ForbiddenException(
        `Only OPEN tickets can be assigned (current status: ${ticket.status}).`,
      );
    }
    if (ticket.assignedToId != null) {
      throw new ForbiddenException('This ticket is already assigned.');
    }

    const assignee = await this.users.findById(assigneeId);
    if (!assignee) throw new NotFoundException(`User ${assigneeId} not found.`);
    if (!isAgentRole(assignee.role)) {
      throw new BadRequestException('Tickets can only be assigned to agents.');
    }
    const department =
      ROLE_DEPARTMENT[assignee.role as keyof typeof ROLE_DEPARTMENT];
    if (department !== ticket.category) {
      throw new BadRequestException(
        `${assignee.role} serves ${department}, but this ticket is ${ticket.category}.`,
      );
    }

    ticket.assignedToId = assignee.id;
    ticket.status = 'In Progress';
    const saved = await this.tickets.save(ticket);
    await this.events.save(
      this.events.create({
        ticketId: saved.id,
        actorId: user.id,
        action: 'ASSIGNED',
        fromStatus: 'Open',
        toStatus: 'In Progress',
        note: `Assigned to ${assignee.name}${note?.trim() ? ` — ${note.trim()}` : ''}`,
      }),
    );
    return this.getById(id, user);
  }

  /**
   * ADR-003: PATCH /tickets/:id/cancel — an Admin retires a request that should
   * not be worked (duplicate, obsolete, withdrawn). This is a SOFT cancel: the
   * ticket keeps its row and full history with status `Cancelled`; we never
   * hard-delete tickets, because the audit trail is a core product requirement.
   */
  async cancel(id: number, user: AuthUser, reason: string): Promise<Ticket> {
    if (!isAdminRole(user.role)) {
      throw new ForbiddenException('Only an Admin can cancel tickets.');
    }
    const ticket = await this.getById(id, user);
    if (ticket.status === 'Resolved' || ticket.status === 'Cancelled') {
      throw new ForbiddenException(
        `A ${ticket.status} ticket cannot be cancelled.`,
      );
    }
    const trimmed = (reason ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException('A cancellation reason is required.');
    }

    const fromStatus = ticket.status as TicketStatus;
    ticket.status = 'Cancelled';
    const saved = await this.tickets.save(ticket);
    await this.events.save(
      this.events.create({
        ticketId: saved.id,
        actorId: user.id,
        action: 'CANCELLED',
        fromStatus,
        toStatus: 'Cancelled',
        note: trimmed,
      }),
    );
    return this.getById(id, user);
  }

  /**
   * ADR-010: DELETE /tickets/:id — an Admin **permanently deletes a Resolved
   * ticket**. This is the one deliberate exception to ADR-003's "a ticket is
   * never hard-deleted": the row and its `ticket_events` leave the database
   * together, so the request disappears for the requester, the agents and the
   * dashboard instead of sitting in the audit trail.
   *
   * Only a `Resolved` ticket qualifies. Anything still being worked is retired
   * with the **soft** `cancel` above, and a `Cancelled` ticket stays as the
   * audit record — both are refused here with `409`, so a typo cannot erase
   * work in progress.
   *
   * The deletion removes the ticket's own trace, so the action itself is written
   * to the server log (there is no separate admin-action table).
   */
  async remove(id: number, user: AuthUser): Promise<{ id: number; mode: 'deleted' }> {
    if (!isAdminRole(user.role)) {
      throw new ForbiddenException('Only an Admin can delete tickets.');
    }
    const ticket = await this.getById(id, user); // 404 when unknown

    if (ticket.status === 'Cancelled') {
      throw new ConflictException(
        'A Cancelled ticket is kept for audit and cannot be deleted.',
      );
    }
    if (ticket.status !== 'Resolved') {
      throw new ConflictException(
        `Only a Resolved ticket can be deleted — this one is ${ticket.status}; cancel it instead.`,
      );
    }

    // Both deletes in one transaction: events first (so no orphan rows even
    // where the driver does not enforce the FK cascade), then the ticket.
    await this.tickets.manager.transaction(async (manager) => {
      await manager.delete(TicketEvent, { ticketId: id });
      await manager.delete(Ticket, { id });
    });

    this.logger.log(
      `Admin ${user.email} permanently deleted Resolved ticket #${id} ` +
        `("${ticket.title}", ${ticket.category}) and its history rows.`,
    );
    return { id, mode: 'deleted' };
  }

  /** Durable ticket history (architecture.md: DB stores ticket history). */
  async history(id: number, user: AuthUser): Promise<TicketEvent[]> {
    await this.getById(id, user); // enforces read access
    return this.events.find({
      where: { ticketId: id },
      relations: { actor: true },
      order: { createdAt: 'ASC' },
    });
  }

  /** Admin dashboard numbers (admin sees every ticket company-wide). */
  async adminStats() {
    const all = await this.tickets.find();
    const byStatus = all.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});
    const byCategory = all.reduce<Record<string, number>>((acc, t) => {
      acc[t.category] = (acc[t.category] ?? 0) + 1;
      return acc;
    }, {});
    return {
      total: all.length,
      byStatus,
      byCategory,
      openUnclaimed: all.filter(
        (t) => t.status === 'Open' && t.assignedToId == null,
      ).length,
      highPriorityOpen: all.filter(
        (t) => t.status === 'Open' && t.priority === 'High',
      ).length,
    };
  }
}
