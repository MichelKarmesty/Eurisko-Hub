import {
  BadRequestException,
  ForbiddenException,
  Injectable,
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
import { Ticket } from './ticket.entity';
import { TicketEvent } from './ticket-event.entity';

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
  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(TicketEvent)
    private readonly events: Repository<TicketEvent>,
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
      relations: { requester: true, assignedTo: true },
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
      relations: { requester: true, assignedTo: true },
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
   */
  async changeStatus(
    id: number,
    user: AuthUser,
    toStatus: 'In Progress' | 'Resolved',
    resolutionNote?: string,
  ): Promise<Ticket> {
    const ticket = await this.getById(id, user);

    const isAssignedAgent =
      isAgentRole(user.role) && ticket.assignedToId === user.id;
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
    }

    ticket.status = toStatus;
    const saved = await this.tickets.save(ticket);
    await this.events.save(
      this.events.create({
        ticketId: saved.id,
        actorId: user.id,
        action: toStatus === 'Resolved' ? 'RESOLVED' : 'STATUS_CHANGED',
        fromStatus,
        toStatus,
        note: toStatus === 'Resolved' ? resolutionNote!.trim() : null,
      }),
    );
    return this.getById(id, user);
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
