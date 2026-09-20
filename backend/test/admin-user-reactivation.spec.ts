/**
 * ACCOUNT REACTIVATION (Admin) — `GET /users?includeInactive=true` and
 * `PATCH /users/:id/active`.
 *
 * Why this exists: deleting an account that ticket history references does not
 * remove the row — it **deactivates** it, and the row keeps the email address.
 * `POST /users` therefore (correctly) refuses that address with `409`, which
 * used to be a dead end because deactivated rows were invisible in the Users
 * tab. These tests pin the way out:
 *
 *   ALLOWED  Admin sees deactivated accounts with ?includeInactive=true
 *   ALLOWED  Admin reactivates one          -> 200, the address can sign in again
 *   ALLOWED  Admin deactivates an active one -> 200, the login is revoked at once
 *   REFUSED  the 409 for a deactivated address names reactivation as the fix
 *   DENIED   a non-Admin caller              -> 403
 *   DENIED   deactivating your own account   -> 400
 *   DENIED   deactivating the last active Admin -> 400
 *   INVALID  a non-boolean `active`          -> 400
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Role } from '../src/common/domain';

const PASSWORD = 'password123';
const run = Date.now().toString(36);
let userSeq = 0;

describe('Account reactivation — PATCH /users/:id/active', () => {
  let app: INestApplication;
  let http: any;
  let adminToken: string;
  let adminId: number;

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

  const listEmails = async (includeInactive = false) => {
    const url = includeInactive ? '/users?includeInactive=true' : '/users';
    const res = await request(http).get(url).set(auth(adminToken));
    expect(res.status).toBe(200);
    return res.body.map((u: any) => u.email);
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule], // in-memory sqljs DB + seeded admin (test/setup.ts)
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = app.getHttpServer();

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

  it('hides a deactivated account by default, shows it with ?includeInactive=true, and reactivates it', async () => {
    const agent = await provision('IT_Agent', 'Reactivate');

    // Give the account history, so deleting it deactivates instead of removing.
    const ticket = await request(http)
      .post('/tickets')
      .set(auth(agent.token))
      .send({
        title: 'Needs a record',
        description: 'This ticket keeps the account referenced.',
        category: 'IT',
        priority: 'Low',
      });
    expect(ticket.status).toBe(201);

    const removed = await request(http).delete(`/users/${agent.id}`).set(auth(adminToken));
    expect(removed.status).toBe(200);
    expect(removed.body.mode).toBe('deactivated');

    // Hidden by default, visible on request — and still holding its email.
    expect(await listEmails()).not.toContain(agent.email);
    expect(await listEmails(true)).toContain(agent.email);
    expect((await request(http).post('/auth/login').send({ email: agent.email, password: PASSWORD })).status).toBe(401);

    // Re-creating it is refused, and the message says what to do instead.
    const duplicate = await request(http)
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'Duplicate', email: agent.email, password: PASSWORD, role: 'Employee' });
    expect(duplicate.status).toBe(409);
    expect(String(duplicate.body.message)).toMatch(/deactivated account.*reactivate it/i);

    // Reactivate: the same row (same id) comes back and can sign in again.
    const reactivated = await request(http)
      .patch(`/users/${agent.id}/active`)
      .set(auth(adminToken))
      .send({ active: true });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ id: agent.id, email: agent.email, isActive: true });
    expect(await listEmails()).toContain(agent.email);
    const relogin = await request(http).post('/auth/login').send({ email: agent.email, password: PASSWORD });
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.id).toBe(agent.id); // history stays attached to the same account

    // Its old link is still refused while the (now active) row owns the address.
    const stillTaken = await request(http)
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'Duplicate', email: agent.email, password: PASSWORD, role: 'Employee' });
    expect(stillTaken.status).toBe(409);
    expect(String(stillTaken.body.message)).toMatch(/already exists/i);
  });

  it('deactivates an active account (login revoked at once) and is idempotent', async () => {
    const employee = await provision('Employee', 'Deactivate');

    const off = await request(http)
      .patch(`/users/${employee.id}/active`)
      .set(auth(adminToken))
      .send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    expect((await request(http).post('/auth/login').send({ email: employee.email, password: PASSWORD })).status).toBe(401);
    expect(await listEmails()).not.toContain(employee.email);
    expect(await listEmails(true)).toContain(employee.email);

    // Repeating the same state is a no-op that still returns the account.
    const again = await request(http)
      .patch(`/users/${employee.id}/active`)
      .set(auth(adminToken))
      .send({ active: false });
    expect(again.status).toBe(200);
    expect(again.body.isActive).toBe(false);

    const back = await request(http)
      .patch(`/users/${employee.id}/active`)
      .set(auth(adminToken))
      .send({ active: true });
    expect(back.status).toBe(200);
    expect((await request(http).post('/auth/login').send({ email: employee.email, password: PASSWORD })).status).toBe(200);
  });

  it('refuses the dangerous cases: non-Admin caller, own account, unknown id, bad body', async () => {
    const employee = await provision('Employee', 'Guards');

    // Authorization: only an Admin may flip this switch.
    const asEmployee = await request(http)
      .patch(`/users/${employee.id}/active`)
      .set(auth(employee.token))
      .send({ active: true });
    expect(asEmployee.status).toBe(403);
    expect((await request(http).patch(`/users/${employee.id}/active`).send({ active: true })).status).toBe(401);

    // A session cannot deactivate itself…
    const own = await request(http)
      .patch(`/users/${adminId}/active`)
      .set(auth(adminToken))
      .send({ active: false });
    expect(own.status).toBe(400);
    expect(String(own.body.message)).toMatch(/your own account/i);

    // …which is what makes a lock-out impossible: with a second Admin in place
    // one Admin can be deactivated, and the remaining one still cannot release
    // its own access. (The service's "last active Admin" branch is defensive —
    // an Admin acting on somebody else implies at least two active Admins, and
    // acting on itself is already refused above.)
    const secondAdmin = await provision('Admin', 'SecondAdmin');
    const offSecond = await request(http)
      .patch(`/users/${secondAdmin.id}/active`)
      .set(auth(adminToken))
      .send({ active: false });
    expect(offSecond.status).toBe(200);
    expect(offSecond.body.isActive).toBe(false);
    const stillCannotSelf = await request(http)
      .patch(`/users/${adminId}/active`)
      .set(auth(adminToken))
      .send({ active: false });
    expect(stillCannotSelf.status).toBe(400);
    expect(String(stillCannotSelf.body.message)).toMatch(/your own account/i);
    // The deactivated second Admin cannot sign in, and reactivating restores it.
    expect(
      (await request(http).post('/auth/login').send({ email: secondAdmin.email, password: PASSWORD })).status,
    ).toBe(401);
    const back = await request(http)
      .patch(`/users/${secondAdmin.id}/active`)
      .set(auth(adminToken))
      .send({ active: true });
    expect(back.status).toBe(200);
    expect(
      (await request(http).post('/auth/login').send({ email: secondAdmin.email, password: PASSWORD })).status,
    ).toBe(200);

    // Unknown id / invalid body.
    expect(
      (await request(http).patch('/users/999999/active').set(auth(adminToken)).send({ active: true })).status,
    ).toBe(404);
    expect(
      (await request(http).patch(`/users/${employee.id}/active`).set(auth(adminToken)).send({ active: 'yes' })).status,
    ).toBe(400);
    // The Admin is still active after all the refusals.
    expect((await request(http).post('/auth/login').send({ email: 'admin@eurisko.com', password: 'Admin123!' })).status).toBe(200);
  });
});
