/**
 * HTTP CONTRACT + AUTHORIZATION + REGRESSION TESTS (Week 3 requirement).
 *
 * Boots the whole application (AppModule) over the exact same HTTP pipeline as
 * `main.ts` — same validation pipe, same serializer — and drives it with
 * supertest. These tests pin the explicit request/response contract of the
 * slice and protect the boundaries:
 *
 *   ALLOWED  the assigned agent resolves the ticket              -> 200
 *   DENIED   the requester / another agent / another department  -> 403
 *   INVALID  unknown status, unknown field, empty note           -> 400
 *   NO AUTH  missing bearer token                                -> 401
 *
 * The `regression protection` block locks in behaviour that already worked
 * before this slice (self-registration rules, department scoping, the admin
 * global view, and the fact that password hashes never leave the API).
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Role } from '../src/common/domain';

const PASSWORD = 'password123';
let run = Date.now().toString(36);
let userSeq = 0;

describe('API contract — the resolve-ticket slice over HTTP', () => {
  let app: INestApplication;
  let http: any;
  let adminToken: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Provision an account through the Admin API and return its session. */
  async function provision(role: Role, name: string) {
    userSeq += 1;
    const email = `${name.toLowerCase()}-${run}-${userSeq}@eurisko.com`;
    const created = await request(http)
      .post('/users')
      .set(auth(adminToken))
      .send({ name, email, password: PASSWORD, role });
    expect(created.status).toBe(201);
    expect(created.body.passwordHash).toBeUndefined(); // serializer boundary

    const login = await request(http).post('/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { email, token: login.body.accessToken as string, id: login.body.user.id as number };
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule], // in-memory sqljs DB + seeded admin (test/setup.ts)
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app); // identical boundary to src/main.ts
    await app.init();
    http = app.getHttpServer();

    const login = await request(http)
      .post('/auth/login')
      .send({ email: 'rami.fares@eurisko.com', password: 'Admin123!' });
    expect(login.status).toBe(200);
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated request at the boundary (401)', async () => {
    const res = await request(http).get('/tickets');
    expect(res.status).toBe(401);
  });

  it('runs the whole slice: open -> claim -> resolve -> requester sees Resolved + note', async () => {
    const alice = await provision('Employee', 'Alice');
    const bob = await provision('IT_Agent', 'Bob');
    const carol = await provision('HR_Agent', 'Carol');

    // 1. Requester opens a ticket (request contract: the four documented fields).
    const opened = await request(http)
      .post('/tickets')
      .set(auth(alice.token))
      .send({
        title: 'External monitor flickers',
        description: 'The screen flickers every few seconds.',
        category: 'IT',
        priority: 'High',
      });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({
      status: 'Open',
      category: 'IT',
      priority: 'High',
      requesterId: alice.id,
      assignedToId: null,
      resolutionNote: null,
    });
    const ticketId = opened.body.id as number;

    // 2. Agent claims it from the IT queue -> In Progress.
    const claimed = await request(http).patch(`/tickets/${ticketId}/claim`).set(auth(bob.token));
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ status: 'In Progress', assignedToId: bob.id });

    // 3. INVALID REQUEST — an empty/whitespace resolution note is rejected (400).
    const emptyNote = await request(http)
      .patch(`/tickets/${ticketId}/status`)
      .set(auth(bob.token))
      .send({ status: 'Resolved', resolutionNote: '   ' });
    expect(emptyNote.status).toBe(400);
    expect(String(emptyNote.body.message)).toMatch(/resolution note/i);

    // 3b. INVALID REQUEST — a status outside the contract is rejected (400).
    const badStatus = await request(http)
      .patch(`/tickets/${ticketId}/status`)
      .set(auth(bob.token))
      .send({ status: 'Cancelled', resolutionNote: 'nope' });
    expect(badStatus.status).toBe(400);

    // 3c. INVALID REQUEST — an unknown field is rejected (400, whitelist).
    const unknownField = await request(http)
      .patch(`/tickets/${ticketId}/status`)
      .set(auth(bob.token))
      .send({ status: 'Resolved', resolutionNote: 'ok', sneaky: true });
    expect(unknownField.status).toBe(400);

    // 4. DENIED — the requester who opened the ticket cannot resolve it (403).
    const requesterDenied = await request(http)
      .patch(`/tickets/${ticketId}/status`)
      .set(auth(alice.token))
      .send({ status: 'Resolved', resolutionNote: 'I will do it myself.' });
    expect(requesterDenied.status).toBe(403);

    // 4b. DENIED — an agent from another department cannot touch it (403).
    const otherDeptDenied = await request(http)
      .patch(`/tickets/${ticketId}/status`)
      .set(auth(carol.token))
      .send({ status: 'Resolved', resolutionNote: 'HR owns this now.' });
    expect(otherDeptDenied.status).toBe(403);

    // 5. ALLOWED — the assigned agent resolves with a note (200).
    const note = 'Replaced the display cable; stable for 24h.';
    const resolved = await request(http)
      .patch(`/tickets/${ticketId}/status`)
      .set(auth(bob.token))
      .send({ status: 'Resolved', resolutionNote: note });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      status: 'Resolved',
      resolutionNote: note,
      assignedToId: bob.id,
    });

    // 6. React result source — the requester reads the resolved ticket + note.
    const asRequester = await request(http).get(`/tickets/${ticketId}`).set(auth(alice.token));
    expect(asRequester.status).toBe(200);
    expect(asRequester.body).toMatchObject({ status: 'Resolved', resolutionNote: note });

    // 7. Durable history — CREATED -> CLAIMED -> RESOLVED with actor + note.
    const history = await request(http).get(`/tickets/${ticketId}/history`).set(auth(alice.token));
    expect(history.status).toBe(200);
    const actions = history.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['CREATED', 'CLAIMED', 'RESOLVED']));
    const resolvedEvent = history.body.find((e: { action: string }) => e.action === 'RESOLVED');
    expect(resolvedEvent).toMatchObject({ actorId: bob.id, note });
  });

  describe('regression protection — behaviour that already worked', () => {
    it('requester listing returns only their own tickets', async () => {
      const alice = await provision('Employee', 'RegressAlice');
      const other = await provision('Employee', 'RegressBob');

      const mine = await request(http)
        .post('/tickets')
        .set(auth(alice.token))
        .send({ title: 'Alice regression ticket', description: 'Mine only.', category: 'HR', priority: 'Low' });
      await request(http)
        .post('/tickets')
        .set(auth(other.token))
        .send({ title: 'Other regression ticket', description: 'Not Alice.', category: 'HR', priority: 'Low' });

      const list = await request(http).get('/tickets').set(auth(alice.token));
      expect(list.status).toBe(200);
      const ids = list.body.map((t: { id: number }) => t.id);
      expect(ids).toContain(mine.body.id);
      expect(list.body.every((t: { requesterId: number }) => t.requesterId === alice.id)).toBe(true);
    });

    it('an agent queue is scoped to their department and Open status', async () => {
      const agent = await provision('IT_Agent', 'RegressITAgent');
      const list = await request(http).get('/tickets').set(auth(agent.token));
      expect(list.status).toBe(200);
      expect(list.body.every((t: { category: string; status: string }) => t.category === 'IT' && t.status === 'Open')).toBe(true);
    });

    it('an agent cannot query another department queue (403)', async () => {
      const agent = await provision('IT_Agent', 'RegressITAgent2');
      const res = await request(http).get('/tickets?category=HR').set(auth(agent.token));
      expect(res.status).toBe(403);
    });

    it('the admin global view spans departments and /admin/stats works', async () => {
      const hr = await provision('HR_Agent', 'RegressHRAgent');
      expect(hr.token).toBeTruthy();

      const list = await request(http).get('/tickets').set(auth(adminToken));
      expect(list.status).toBe(200);
      const categories = new Set(list.body.map((t: { category: string }) => t.category));
      expect(categories.size).toBeGreaterThan(1);

      const stats = await request(http).get('/admin/stats').set(auth(adminToken));
      expect(stats.status).toBe(200);
      expect(stats.body.total).toBeGreaterThan(0);
    });

    it('self-registration still creates Employees only', async () => {
      userSeq += 1;
      const email = `self-${run}-${userSeq}@eurisko.com`;
      const employee = await request(http)
        .post('/auth/register')
        .send({ name: 'Self', email, password: PASSWORD });
      expect(employee.status).toBe(201);
      expect(employee.body.user.role).toBe('Employee');
      expect(employee.body.user.passwordHash).toBeUndefined();

      const asAgent = await request(http)
        .post('/auth/register')
        .send({ name: 'Fake Agent', email: `fake-${run}-${userSeq}@eurisko.com`, password: PASSWORD, role: 'IT_Agent' });
      expect(asAgent.status).toBe(403);
    });

    it('rejects a duplicate email and bad credentials', async () => {
      userSeq += 1;
      const email = `dup-${run}-${userSeq}@eurisko.com`;
      const body = { name: 'Dup', email, password: PASSWORD };
      expect((await request(http).post('/auth/register').send(body)).status).toBe(201);
      expect((await request(http).post('/auth/register').send(body)).status).toBe(409);
      expect(
        (await request(http).post('/auth/login').send({ email, password: 'wrong-password' })).status,
      ).toBe(401);
    });
  });
});
