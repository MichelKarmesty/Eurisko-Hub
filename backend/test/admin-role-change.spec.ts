/**
 * ROLE CHANGES (Admin) — `PATCH /users/:id/role`.
 *
 * Boots the whole AppModule over the real HTTP pipeline (like
 * `admin-user-deletion.spec.ts`) and pins the rule that a demotion can never
 * empty the Admin seat — the same "a database can never be locked out"
 * guarantee that deletion already had (ADR-004, docs/security.md):
 *
 *   ALLOWED  Employee -> IT_Agent, or Employee -> Admin      -> 200
 *   ALLOWED  Admin demotes ANOTHER Admin (one remains)       -> 200
 *   DENIED   a non-Admin caller                              -> 403
 *   DENIED   an Admin changing their own Admin role          -> 400
 *   DENIED   demoting the last active Admin                  -> 400
 *   DENIED   an unknown account                              -> 404
 *
 * The guarded checks live in `UsersService.updateRole`, so they hold for any
 * caller, not only for the Users tab.
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

const PASSWORD = 'password123';
const run = Date.now().toString(36);
let userSeq = 0;

describe('Admin role changes — PATCH /users/:id/role', () => {
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

  const roleInDb = async (id: number) => (await users.findOneOrFail({ where: { id } })).role;

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

  it('rejects an unauthenticated role change (401)', async () => {
    const res = await request(http).patch('/users/999/role').send({ role: 'Employee' });
    expect(res.status).toBe(401);
  });

  it('refuses a non-Admin caller (403) — authorization boundary', async () => {
    const employee = await provision('Employee', 'Rana');
    const target = await provision('Employee', 'Nadim');

    const res = await request(http)
      .patch(`/users/${target.id}/role`)
      .set(auth(employee.token))
      .send({ role: 'IT_Agent' });

    expect(res.status).toBe(403);
    expect(String(res.body.message)).toContain('Requires one of the roles: Admin.');
    expect(await roleInDb(target.id)).toBe('Employee');
  });

  it('changes an Employee role to an agent role (200) and lists the new role', async () => {
    const employee = await provision('Employee', 'Karim');

    const res = await request(http)
      .patch(`/users/${employee.id}/role`)
      .set(auth(adminToken))
      .send({ role: 'IT_Agent' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: employee.id, role: 'IT_Agent' });
    expect(res.body.passwordHash).toBeUndefined();
    expect(await roleInDb(employee.id)).toBe('IT_Agent');

    const list = await request(http).get('/users').set(auth(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.find((u: any) => u.id === employee.id).role).toBe('IT_Agent');
  });

  it('promotes an Employee to Admin (200) and the new Admin can manage users', async () => {
    const employee = await provision('Employee', 'Layla');

    const promoted = await request(http)
      .patch(`/users/${employee.id}/role`)
      .set(auth(adminToken))
      .send({ role: 'Admin' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('Admin');

    // The change is effective for the next sign-in: a fresh token carries Admin.
    const login = await request(http)
      .post('/auth/login')
      .send({ email: employee.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('Admin');

    const list = await request(http).get('/users').set(auth(login.body.accessToken));
    expect(list.status).toBe(200);
  });

  it('lets an Admin demote a different Admin while another active Admin remains (200)', async () => {
    const other = await provision('Admin', 'Walid');

    const res = await request(http)
      .patch(`/users/${other.id}/role`)
      .set(auth(adminToken))
      .send({ role: 'Employee' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('Employee');
    expect(await roleInDb(other.id)).toBe('Employee');

    // The demotion is durable and applies to the next sign-in. (A token already
    // issued keeps its old claim until it expires — JWT is not DB-checked; see
    // docs/security.md.)
    const login = await request(http)
      .post('/auth/login')
      .send({ email: other.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('Employee');
  });

  it('refuses an Admin changing their own Admin role (400)', async () => {
    const res = await request(http)
      .patch(`/users/${adminId}/role`)
      .set(auth(adminToken))
      .send({ role: 'Employee' });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('your own Admin role');
    expect(await roleInDb(adminId)).toBe('Admin');
  });

  it('refuses demoting the last active Admin, and a deactivated Admin session is already dead', async () => {
    // Make the seeded Admin the only ACTIVE Admin, whatever earlier tests left
    // behind, so the lockout edge is the one under test.
    const others = (await users.find()).filter(
      (u) => u.role === 'Admin' && u.isActive && u.id !== adminId,
    );
    for (const other of others) await users.update(other.id, { isActive: false });

    // A second Admin, deactivated behind their back.
    const doomed = await provision('Admin', 'Hadi');
    const staleToken = doomed.token;
    await users.update(doomed.id, { isActive: false });

    // The guard re-reads the account, so that session is dead at once.
    const me = await request(http).get('/auth/me').set(auth(staleToken));
    expect(me.status).toBe(401);

    // The API can therefore no longer reach the service guard with a dead
    // session, so the rule is exercised directly — this is what actually
    // protects the Admin seat.
    const service = app.get(UsersService);
    await expect(service.updateRole(adminId, 'Employee', doomed.id)).rejects.toThrow(
      /last active Admin/i,
    );
    expect(await roleInDb(adminId)).toBe('Admin');
  });

  it('returns 404 for an unknown account (404)', async () => {
    const res = await request(http)
      .patch('/users/999999/role')
      .set(auth(adminToken))
      .send({ role: 'Employee' });

    expect(res.status).toBe(404);
    expect(String(res.body.message)).toContain('not found');
  });

  it('still rejects an invalid role value (400, DTO validation)', async () => {
    const employee = await provision('Employee', 'Elias');

    const res = await request(http)
      .patch(`/users/${employee.id}/role`)
      .set(auth(adminToken))
      .send({ role: 'Finance' });

    expect(res.status).toBe(400);
    expect(await roleInDb(employee.id)).toBe('Employee');
  });
});
