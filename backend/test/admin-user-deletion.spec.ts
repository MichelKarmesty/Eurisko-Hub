/**
 * ACCOUNT DELETION (Admin) — contract, authorization and audit rules.
 *
 * Boots the whole AppModule over the real HTTP pipeline (like
 * `tickets.api.spec.ts`) and pins the behaviour of `DELETE /users/:id`:
 *
 *   ALLOWED  Admin deletes an account with no history   -> 200 mode "deleted"
 *   ALLOWED  Admin deletes an account with history      -> 200 mode "deactivated"
 *   DENIED   a non-Admin caller                         -> 403
 *   DENIED   an Admin deleting their own account        -> 400
 *   DENIED   deleting the last active Admin             -> 400
 *
 * A removed account must leave `GET /users` and must not be able to sign in,
 * while the tickets/history it is attached to stay intact.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Role } from '../src/common/domain';
import { User } from '../src/users/user.entity';
import { UsersService } from '../src/users/users.service';
import { Ticket } from '../src/tickets/ticket.entity';

const PASSWORD = 'password123';
const run = Date.now().toString(36);
let userSeq = 0;

describe('Admin account deletion — DELETE /users/:id', () => {
  let app: INestApplication;
  let http: any;
  let adminToken: string;
  let adminId: number;
  let users: Repository<User>;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function provision(role: Role, name: string) {
    userSeq += 1;
    const email = `${name.toLowerCase()}-${run}-${userSeq}@eurisko.com`;
    const created = await request(http)
      .post('/users')
      .set(auth(adminToken))
      .send({ name, email, password: PASSWORD, role });
    expect(created.status).toBe(201);
    const login = await request(http).post('/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { email, token: login.body.accessToken as string, id: login.body.user.id as number };
  }

  const listEmails = async () =>
    (await request(http).get('/users').set(auth(adminToken))).body.map((u: any) => u.email);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule], // in-memory sqljs DB + seeded admin (test/setup.ts)
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
    users = app.get<Repository<User>>(getRepositoryToken(User));

    const login = await request(http)
      .post('/auth/login')
      .send({ email: 'admin@eurisko.com', password: 'Admin123!' });
    expect(login.status).toBe(200);
    adminToken = login.body.accessToken;
    adminId = login.body.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated delete (401)', async () => {
    const res = await request(http).delete('/users/999');
    expect(res.status).toBe(401);
  });

  it('refuses a non-Admin caller (403) — authorization boundary', async () => {
    const employee = await provision('Employee', 'Mona');
    const victim = await provision('Employee', 'Sami');

    const res = await request(http).delete(`/users/${victim.id}`).set(auth(employee.token));
    expect(res.status).toBe(403);

    // Nothing changed: the victim can still sign in.
    const stillWorks = await request(http)
      .post('/auth/login')
      .send({ email: victim.email, password: PASSWORD });
    expect(stillWorks.status).toBe(200);
  });

  it('really deletes an account with no tickets or history', async () => {
    const target = await provision('HR_Agent', 'Nour');

    const res = await request(http).delete(`/users/${target.id}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, mode: 'deleted' });

    expect(await listEmails()).not.toContain(target.email);
    const row = await users.findOne({ where: { id: target.id } });
    expect(row).toBeNull(); // the row is genuinely gone

    const login = await request(http)
      .post('/auth/login')
      .send({ email: target.email, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('deactivates (keeps for audit) an account that has tickets/history, and revokes its login', async () => {
    const requester = await provision('Employee', 'Rita');
    const agent = await provision('IT_Agent', 'Ziad');

    // Give the agent history: open -> claim (records a CLAIMED event with actor=agent).
    const opened = await request(http)
      .post('/tickets')
      .set(auth(requester.token))
      .send({ title: 'Deletion audit check', description: 'Printer is jammed', category: 'IT', priority: 'Medium' });
    expect(opened.status).toBe(201);
    const ticketId = opened.body.id as number;

    const claimed = await request(http).patch(`/tickets/${ticketId}/claim`).set(auth(agent.token));
    expect(claimed.status).toBe(200);

    const res = await request(http).delete(`/users/${agent.id}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: agent.id, mode: 'deactivated' });

    expect(await listEmails()).not.toContain(agent.email);
    const row = await users.findOne({ where: { id: agent.id } });
    expect(row).not.toBeNull();
    expect(row!.isActive).toBe(false);

    const login = await request(http)
      .post('/auth/login')
      .send({ email: agent.email, password: PASSWORD });
    expect(login.status).toBe(401);

    // The audit trail survived: the requester still sees the ticket + its history.
    const history = await request(http)
      .get(`/tickets/${ticketId}/history`)
      .set(auth(requester.token));
    expect(history.status).toBe(200);
    expect(history.body.map((e: any) => e.action)).toContain('CLAIMED');
  });

  it('deactivates an assignee who owns no event of their own — the ticket must not lose its owner', async () => {
    const requester = await provision('Employee', 'Rami');
    const agent = await provision('IT_Agent', 'Dana');

    // The Admin assigns the ticket, so the ASSIGNED event is the Admin's: this
    // agent owns no ticket and no event of their own.
    const opened = await request(http)
      .post('/tickets')
      .set(auth(requester.token))
      .send({ title: 'Assignee deletion check', description: 'The screen is black', category: 'IT', priority: 'High' });
    expect(opened.status).toBe(201);
    const ticketId = opened.body.id as number;

    const assigned = await request(http)
      .patch(`/tickets/${ticketId}/assign`)
      .set(auth(adminToken))
      .send({ assigneeId: agent.id });
    expect(assigned.status).toBe(200);

    const res = await request(http).delete(`/users/${agent.id}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: agent.id, mode: 'deactivated' });

    const row = await users.findOne({ where: { id: agent.id } });
    expect(row).not.toBeNull();
    expect(row!.isActive).toBe(false);

    // The live ticket still points at a row that exists, instead of dangling.
    const ticket = await request(http).get(`/tickets/${ticketId}`).set(auth(adminToken));
    expect(ticket.status).toBe(200);
    expect(ticket.body.assignedToId).toBe(agent.id);
  });

  it('enforces the declared foreign keys — a ticket cannot reference a user that does not exist', async () => {
    // The entities declare RESTRICT / SET NULL / CASCADE, but SQLite only
    // honours them while `PRAGMA foreign_keys` is ON; AppModule turns it on at
    // bootstrap (through the driver's own connection — `dataSource.query()`
    // does not persist a PRAGMA on sqljs). Without it these are decorative.
    const tickets = app.get<Repository<Ticket>>(getRepositoryToken(Ticket));

    await expect(
      tickets.insert({
        title: 'Ghost ticket',
        description: 'requester does not exist',
        category: 'IT',
        priority: 'Low',
        status: 'Open',
        requesterId: 999_999,
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('refuses an Admin deleting their own account (400)', async () => {
    const res = await request(http).delete(`/users/${adminId}`).set(auth(adminToken));
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('your own account');
  });

  it('revokes the session at once when an account is deactivated or removed', async () => {
    // A JWT is only proof that a session *was* issued: the guard re-reads the
    // account on every request, so a dead account cannot keep working until the
    // token expires (README: "the login is revoked at once").
    const deactivated = await provision('IT_Agent', 'Sami');
    await users.update(deactivated.id, { isActive: false });

    const me = await request(http).get('/auth/me').set(auth(deactivated.token));
    expect(me.status).toBe(401);

    const open = await request(http)
      .post('/tickets')
      .set(auth(deactivated.token))
      .send({ title: 'Ghost ticket', description: 'opened by a removed account', category: 'IT', priority: 'Low' });
    expect(open.status).toBe(401);

    const removed = await provision('HR_Agent', 'Nada');
    const gone = await request(http).delete(`/users/${removed.id}`).set(auth(adminToken));
    expect(gone.body.mode).toBe('deleted');
    expect((await request(http).get('/auth/me').set(auth(removed.token))).status).toBe(401);
  });

  it('refuses deleting the last active Admin (service guard)', async () => {
    // Two other Admins, both since deactivated, so the seeded one is the only
    // ACTIVE Admin left — the lockout the rule exists for.
    const other = await provision('Admin', 'Hadi');
    await users.update(other.id, { isActive: false });
    const doomedAdmin = await provision('Admin', 'Walid');
    await users.update(doomedAdmin.id, { isActive: false });

    // The guard is exercised on the service directly: now that a deactivated
    // account's token is rejected with 401, the API can no longer reach this
    // branch at all, but it still protects the state it was written for.
    const service = app.get(UsersService);
    await expect(service.deleteAccount(adminId, doomedAdmin.id)).rejects.toThrow(
      /last active Admin/i,
    );
  });
});
