/**
 * ADMIN-INITIATED PASSWORD RESET — `POST /users/:id/reset-password` (ADR-007).
 *
 * Boots the whole AppModule over the real HTTP pipeline (like
 * `admin-role-change.spec.ts`) and pins the Admin recovery path that needs no
 * mail provider — the counterpart to the self-service email flow:
 *
 *   ALLOWED  an Admin mints a one-time link for an Employee        -> 200
 *   ALLOWED  an Admin mints one for another Admin                  -> 200
 *   DENIED   an unauthenticated caller                             -> 401
 *   DENIED   a non-Admin caller                                    -> 403
 *   DENIED   an unknown account                                    -> 404
 *   DENIED   a deactivated account                                 -> 400
 *   ONE-USE  the link sets a new password, then cannot be replayed  -> 400
 *   SECRET   the token hash/expiry never appear on `GET /users`
 *
 * The point of the feature (docs/security.md): the Admin never sees or chooses
 * the password — they hand over a link and the employee sets their own.
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

const PASSWORD = 'password123';
const NEW_PASSWORD = 'brandNewPass456';
const run = Date.now().toString(36);
let userSeq = 0;

describe('Admin-initiated password reset — POST /users/:id/reset-password', () => {
  let app: INestApplication;
  let http: any;
  let adminToken: string;
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
    return { email, id: login.body.user.id as number, token: login.body.accessToken as string };
  }

  /** Mint a link as the Admin and assert the response shape. */
  async function issue(id: number) {
    const res = await request(http).post(`/users/${id}/reset-password`).set(auth(adminToken));
    expect(res.status).toBe(200);
    return res.body as {
      id: number;
      email: string;
      resetToken: string;
      resetUrl: string;
      expiresAt: string;
      expiresInMinutes: number;
    };
  }

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated reset (401)', async () => {
    const res = await request(http).post('/users/1/reset-password');
    expect(res.status).toBe(401);
  });

  it('refuses a non-Admin caller (403) — authorization boundary', async () => {
    const employee = await provision('Employee', 'Rana');

    const res = await request(http)
      .post(`/users/${employee.id}/reset-password`)
      .set(auth(employee.token));

    expect(res.status).toBe(403);
    expect(String(res.body.message)).toContain('Requires one of the roles: Admin.');
  });

  it('returns 404 for an unknown account', async () => {
    const res = await request(http).post('/users/999999/reset-password').set(auth(adminToken));
    expect(res.status).toBe(404);
    expect(String(res.body.message)).toContain('not found');
  });

  it('issues a one-time link for an Employee and never leaks the stored hash', async () => {
    const employee = await provision('Employee', 'Nadim');

    const body = await issue(employee.id);
    expect(body).toMatchObject({ id: employee.id, email: employee.email });
    expect(body.resetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.resetUrl).toContain(`?resetToken=${body.resetToken}`);
    expect(body.resetUrl.startsWith('http://localhost:5173')).toBe(true);
    expect(body.expiresInMinutes).toBeGreaterThan(0);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The database stores only the SHA-256 hash, never the raw token.
    const row = await users.findOneOrFail({ where: { id: employee.id } });
    expect(row.passwordResetTokenHash).toBeTruthy();
    expect(row.passwordResetTokenHash).not.toBe(body.resetToken);

    // …and neither the hash nor the expiry is exposed by the Users list.
    const list = await request(http).get('/users').set(auth(adminToken));
    expect(list.status).toBe(200);
    const listed = list.body.find((u: any) => u.id === employee.id);
    expect(listed).toBeTruthy();
    expect(listed.passwordResetTokenHash).toBeUndefined();
    expect(listed.passwordResetExpiresAt).toBeUndefined();
    expect(listed.passwordHash).toBeUndefined();
  });

  it('lets the employee set their own new password with the link, exactly once', async () => {
    const employee = await provision('Employee', 'Karim');
    const body = await issue(employee.id);

    const reset = await request(http)
      .post('/auth/reset-password')
      .send({ token: body.resetToken, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    // The old password no longer works; the new one does.
    const oldLogin = await request(http)
      .post('/auth/login')
      .send({ email: employee.email, password: PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(http)
      .post('/auth/login')
      .send({ email: employee.email, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.id).toBe(employee.id);

    // The link is consumed: replaying it fails.
    const replay = await request(http)
      .post('/auth/reset-password')
      .send({ token: body.resetToken, password: 'yetAnother789' });
    expect(replay.status).toBe(400);
  });

  it('issuing a new link invalidates the previous one', async () => {
    const employee = await provision('Employee', 'Layla');

    const first = await issue(employee.id);
    const second = await issue(employee.id);
    expect(second.resetToken).not.toBe(first.resetToken);

    const stale = await request(http)
      .post('/auth/reset-password')
      .send({ token: first.resetToken, password: NEW_PASSWORD });
    expect(stale.status).toBe(400);

    const fresh = await request(http)
      .post('/auth/reset-password')
      .send({ token: second.resetToken, password: NEW_PASSWORD });
    expect(fresh.status).toBe(200);
  });

  it('refuses to issue a link for a deactivated account (400)', async () => {
    const employee = await provision('Employee', 'Hadi');
    await users.update(employee.id, { isActive: false });

    const res = await request(http)
      .post(`/users/${employee.id}/reset-password`)
      .set(auth(adminToken));

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('deactivated');
  });

  it('lets an Admin issue a link for another Admin, and it works', async () => {
    const other = await provision('Admin', 'Walid');

    const body = await issue(other.id);
    const reset = await request(http)
      .post('/auth/reset-password')
      .send({ token: body.resetToken, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    const login = await request(http)
      .post('/auth/login')
      .send({ email: other.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('Admin');
  });
});
