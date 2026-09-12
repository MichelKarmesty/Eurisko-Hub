/**
 * INTEGRATION TEST — BACKEND ↔ DATABASE (Week 3 requirement).
 *
 * Unlike the pure business-rule test, this suite boots the real NestJS
 * `TicketsModule` + `UsersModule` against a real SQL database (TypeORM's sqljs
 * driver, the same driver the app uses locally) and asserts through the
 * TypeORM repositories, so a passing test proves that:
 *
 *   ticket state and ticket history are actually written to, and read from,
 *   the database — not merely returned from in-memory objects.
 *
 * The suite also exercises the slice's authorization rule at the service
 * boundary (allowed case: the assigned agent; denied case: the requester and a
 * different agent) and the deliberate rejection of an invalid request
 * (resolving without a resolution note).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../src/common/auth.decorators';
import { TicketsModule } from '../src/tickets/tickets.module';
import { TicketsService } from '../src/tickets/tickets.service';
import { TicketEvent } from '../src/tickets/ticket-event.entity';
import { Ticket } from '../src/tickets/ticket.entity';
import { User } from '../src/users/user.entity';
import { UsersModule } from '../src/users/users.module';
import { UsersService } from '../src/users/users.service';

/** Give each fixture user a unique email so repeated runs stay isolated. */
const run = Date.now().toString(36);

describe('Integration — ticket lifecycle is persisted in the database', () => {
  let moduleRef: TestingModule;
  let tickets: TicketsService;
  let users: UsersService;
  let ticketRepo: Repository<Ticket>;
  let eventRepo: Repository<TicketEvent>;

  let alice: AuthUser; // Requester (Employee)
  let bob: AuthUser; // IT_Agent — the assigned agent
  let dave: AuthUser; // IT_Agent — a colleague, not assigned
  let carol: AuthUser; // HR_Agent — different department
  let admin: AuthUser;

  let seq = 0;

  const asUser = (u: User): AuthUser => ({ id: u.id, email: u.email, role: u.role });

  async function openTicket() {
    seq += 1;
    return tickets.create(alice, {
      title: `Integration ticket ${seq}`,
      description: 'Fixture used by the backend/database integration test.',
      category: 'IT',
      priority: 'High',
    });
  }

  /** A ticket already claimed by Bob (In Progress). */
  async function openAndClaim() {
    const ticket = await openTicket();
    return tickets.claim(ticket.id, bob);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs', // same driver as the app; no external DB server
          autoSave: false,
          dropSchema: true,
          synchronize: true, // create the real tables
          entities: [User, Ticket, TicketEvent],
        }),
        UsersModule,
        TicketsModule,
      ],
    }).compile();

    tickets = moduleRef.get(TicketsService);
    users = moduleRef.get(UsersService);
    ticketRepo = moduleRef.get(getRepositoryToken(Ticket));
    eventRepo = moduleRef.get(getRepositoryToken(TicketEvent));

    alice = asUser(
      await users.create({ name: 'Alice', email: `alice-${run}@corp.com`, password: 'password123', role: 'Employee' }),
    );
    bob = asUser(
      await users.create({ name: 'Bob', email: `bob-${run}@corp.com`, password: 'password123', role: 'IT_Agent' }),
    );
    dave = asUser(
      await users.create({ name: 'Dave', email: `dave-${run}@corp.com`, password: 'password123', role: 'IT_Agent' }),
    );
    carol = asUser(
      await users.create({ name: 'Carol', email: `carol-${run}@corp.com`, password: 'password123', role: 'HR_Agent' }),
    );
    admin = asUser(
      await users.create({ name: 'Root', email: `admin-${run}@corp.com`, password: 'password123', role: 'Admin' }),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('writes a new ticket and its CREATED history row to the database', async () => {
    const created = await openTicket();

    const row = await ticketRepo.findOneByOrFail({ id: created.id });
    expect(row.status).toBe('Open');
    expect(row.requesterId).toBe(alice.id);
    expect(row.assignedToId).toBeNull();
    expect(row.resolutionNote).toBeNull();

    const events = await eventRepo.find({ where: { ticketId: created.id } });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('CREATED');
    expect(events[0].actorId).toBe(alice.id);
  });

  it('persists a claim: status In Progress, assignment, and CLAIMED event', async () => {
    const claimed = await openAndClaim();

    const row = await ticketRepo.findOneByOrFail({ id: claimed.id });
    expect(row.status).toBe('In Progress');
    expect(row.assignedToId).toBe(bob.id);

    const event = await eventRepo.findOneByOrFail({ ticketId: claimed.id, action: 'CLAIMED' });
    expect(event.actorId).toBe(bob.id);
    expect(event.fromStatus).toBe('Open');
    expect(event.toStatus).toBe('In Progress');
  });

  it('persists the resolution: Resolved status, note, and RESOLVED event', async () => {
    const ticket = await openAndClaim();
    const note = 'Reseated the RAM and ran a memory test.';

    const resolved = await tickets.changeStatus(ticket.id, bob, 'Resolved', note);
    expect(resolved.status).toBe('Resolved');

    // Read it back from the database through a fresh query.
    const row = await ticketRepo.findOneByOrFail({ id: ticket.id });
    expect(row.status).toBe('Resolved');
    expect(row.resolutionNote).toBe(note);
    expect(row.assignedToId).toBe(bob.id);

    const event = await eventRepo.findOneByOrFail({ ticketId: ticket.id, action: 'RESOLVED' });
    expect(event.actorId).toBe(bob.id);
    expect(event.note).toBe(note);
  });

  it('rejects an invalid request: resolving without a resolution note (400) and writes nothing', async () => {
    const ticket = await openAndClaim();

    await expect(tickets.changeStatus(ticket.id, bob, 'Resolved', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // The failed request must not corrupt the stored ticket.
    const row = await ticketRepo.findOneByOrFail({ id: ticket.id });
    expect(row.status).toBe('In Progress');
    expect(row.resolutionNote).toBeNull();
    await expect(
      eventRepo.findOneByOrFail({ ticketId: ticket.id, action: 'RESOLVED' }),
    ).rejects.toBeDefined();
  });

  describe('authorization rule: only the assigned agent (or Admin) may change status', () => {
    it('ALLOWED — the assigned agent resolves the ticket', async () => {
      const ticket = await openAndClaim();
      const resolved = await tickets.changeStatus(ticket.id, bob, 'Resolved', 'Fixed by the assigned agent.');
      expect(resolved.status).toBe('Resolved');
    });

    it('DENIED — the requester who opened the ticket cannot resolve it (403)', async () => {
      const ticket = await openAndClaim();
      await expect(
        tickets.changeStatus(ticket.id, alice, 'Resolved', 'I fixed my own ticket.'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const row = await ticketRepo.findOneByOrFail({ id: ticket.id });
      expect(row.status).toBe('In Progress');
    });

    it('DENIED — a different IT agent cannot resolve someone else’s ticket (403)', async () => {
      const ticket = await openAndClaim();
      await expect(
        tickets.changeStatus(ticket.id, dave, 'Resolved', 'Not mine.'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('DENIED — an HR agent cannot even read an IT ticket (403)', async () => {
      const ticket = await openTicket();
      await expect(tickets.getById(ticket.id, carol)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('regression protection — behaviour that already worked', () => {
    it('requester listing stays scoped to their own tickets', async () => {
      const mine = await openTicket();
      await openTicket(); // another ticket, also Alice's — scope is still Alice only

      const list = await tickets.list(alice, {});
      const ids = list.map((t) => t.id);
      expect(ids).toContain(mine.id);
      // Every returned ticket belongs to Alice; never someone else's.
      expect(list.every((t) => t.requesterId === alice.id)).toBe(true);
    });

    it('agent listing stays scoped to their department queue', async () => {
      const itTicket = await openTicket();
      const queue = await tickets.list(bob, {});
      const ids = queue.map((t) => t.id);

      expect(ids).toContain(itTicket.id);
      expect(queue.every((t) => t.category === 'IT')).toBe(true);
    });

    it('admin listing sees tickets from every department', async () => {
      const itTicket = await openTicket();
      const hrTicket = await tickets.create(admin, {
        title: `HR integration ticket ${++seq}`,
        description: 'Fixture for the admin global view.',
        category: 'HR',
        priority: 'Low',
      });

      const all = await tickets.list(admin, {});
      const ids = all.map((t) => t.id);
      expect(ids).toContain(itTicket.id);
      expect(ids).toContain(hrTicket.id);
    });

    it('the lifecycle still cannot be skipped or reversed (Open -> Resolved denied)', async () => {
      const ticket = await openTicket();
      await expect(
        tickets.changeStatus(ticket.id, admin, 'Resolved', 'Skipping the queue.'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
