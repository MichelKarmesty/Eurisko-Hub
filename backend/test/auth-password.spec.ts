/**
 * PASSWORD RECOVERY + CHANGE — HTTP contract tests.
 *
 * Boots the whole application over the same HTTP pipeline as `main.ts` and
 * drives it with supertest, pinning the behaviour of the two recovery paths
 * added on top of login:
 *
 *   FORGOT   POST /auth/forgot-password  -> always the same generic 200 answer
 *   RESET    POST /auth/reset-password   -> one-time token, then new password
 *   CHANGE   POST /auth/change-password  -> signed in, current password required
 *
 * It also proves the "any real email" rule: accounts are created (by the Admin)
 * and recovered under gmail.com / hotmail.com / outlook.com addresses, and a
 * malformed address is the only thing the API rejects.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

// The reset token may only be echoed back outside production; the tests run
// with NODE_ENV=test and rely on that development behaviour to complete the
// flow without a mail server. Make it explicit rather than implicit.
process.env.PASSWORD_RESET_RETURN_TOKEN = 'true';

const PASSWORD = 'password123';
const NEW_PASSWORD = 'brand-new-pass-456';
const run = Date.now().toString(36);
let userSeq = 0;

describe('Password recovery and change over HTTP', () => {
  let app: INestApplication;
  let http: any;
  let adminToken: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Create an account through the Admin API and return its credentials. */
  async function provision(email: string, password = PASSWORD) {
    userSeq += 1;
    const name = `Recovery User ${userSeq}`;
    const created = await request(http)
      .post('/users')
      .set(auth(adminToken))
      .send({ name, email, password, role: 'Employee' });
    return { email, password, status: created.status, body: created.body };
  }

  async function login(email: string, password: string) {
    return request(http).post('/auth/login').send({ email, password });
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule], // in-memory sqljs DB + seeded admin (test/setup.ts)
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = app.getHttpServer();

    const loginRes = await login('admin@eurisko.com', 'Admin123!');
    expect(loginRes.status).toBe(200);
    adminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Any real email domain is accepted ---------------------------------

  it('accepts personal-provider and corporate email addresses (gmail/hotmail/outlook/company)', async () => {
    for (const domain of ['gmail.com', 'hotmail.com', 'outlook.com']) {
      const email = `person.${userSeq}.${run}@${domain}`;
      const created = await provision(email);
      expect(created.status).toBe(201);
      expect(created.body.email).toBe(email);
    }
    const corporate = await provision(`engineer.${run}@acme-corp.com`);
    expect(corporate.status).toBe(201);
  });

  it('rejects a malformed address and an unknown DTO field (400)', async () => {
    const badEmail = await request(http)
      .post('/auth/forgot-password')
      .send({ email: 'not-an-email' });
    expect(badEmail.status).toBe(400);

    const unknownField = await request(http)
      .post('/auth/forgot-password')
      .send({ email: `x.${run}@gmail.com`, role: 'Admin' });
    expect(unknownField.status).toBe(400);
  });

  // --- Forgot password: step 1 -------------------------------------------

  it('answers generically for an unknown email and never leaks a token', async () => {
    const res = await request(http)
      .post('/auth/forgot-password')
      .send({ email: `nobody.${run}@gmail.com` });
    expect(res.status).toBe(200);
    expect(String(res.body.message)).toMatch(/if that email is registered/i);
    expect(res.body.resetToken).toBeUndefined();
  });

  // --- The stored reset secret never rides along on a user payload --------

  it('never exposes the stored reset hash/expiry on login or on any user payload', async () => {
    const email = `leak.check.${run}@gmail.com`;
    const created = await provision(email);
    expect(created.status).toBe(201);

    // Put a live reset token on the account, so both fields are non-null...
    const forgot = await request(http).post('/auth/forgot-password').send({ email });
    expect(forgot.status).toBe(200);

    // ...then check every endpoint that returns a user object.
    const signIn = await login(email, PASSWORD);
    expect(signIn.status).toBe(200);
    expect(Object.keys(signIn.body.user)).not.toContain('passwordResetTokenHash');
    expect(Object.keys(signIn.body.user)).not.toContain('passwordResetExpiresAt');

    const listed = await request(http).get('/users').set(auth(adminToken));
    expect(listed.status).toBe(200);
    for (const row of listed.body) {
      expect(Object.keys(row)).not.toContain('passwordResetTokenHash');
      expect(Object.keys(row)).not.toContain('passwordResetExpiresAt');
      expect(Object.keys(row)).not.toContain('passwordHash');
    }

    const fresh = await provision(`leak.check.2.${run}@gmail.com`);
    expect(fresh.status).toBe(201);
    expect(Object.keys(fresh.body)).not.toContain('passwordResetTokenHash');
    expect(Object.keys(fresh.body)).not.toContain('passwordHash');

    const target = listed.body.find((u: any) => u.email === email);
    const role = await request(http)
      .patch(`/users/${target.id}/role`)
      .set(auth(adminToken))
      .send({ role: 'IT_Agent' });
    expect(role.status).toBe(200);
    expect(Object.keys(role.body)).not.toContain('passwordResetTokenHash');
    expect(Object.keys(role.body)).not.toContain('passwordResetExpiresAt');
    expect(Object.keys(role.body)).not.toContain('passwordHash');
  });

  // --- Full recovery: forgot -> reset -> sign in --------------------------

  it('resets a forgotten password with the one-time token, then consumes the token', async () => {
    const email = `forgetful.${run}@gmail.com`;
    expect((await provision(email)).status).toBe(201);

    const forgot = await request(http)
      .post('/auth/forgot-password')
      .send({ email });
    expect(forgot.status).toBe(200);
    expect(String(forgot.body.message)).toMatch(/if that email is registered/i);
    const token = forgot.body.resetToken as string;
    expect(token).toBeTruthy();
    expect(token).toHaveLength(64); // randomBytes(32).toString('hex')

    // The old password still works until the reset completes.
    expect((await login(email, PASSWORD)).status).toBe(200);

    const reset = await request(http)
      .post('/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    expect(String(reset.body.message)).toMatch(/password has been changed/i);

    // The old password is gone; the new one works.
    expect((await login(email, PASSWORD)).status).toBe(401);
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);

    // A one-time token cannot be replayed.
    const replay = await request(http)
      .post('/auth/reset-password')
      .send({ token, password: 'yet-another-pass-789' });
    expect(replay.status).toBe(400);
    expect(String(replay.body.message)).toMatch(/invalid or has expired/i);
  });

  it('rejects an unknown or malformed reset token (400)', async () => {
    const unknown = await request(http)
      .post('/auth/reset-password')
      .send({ token: 'a'.repeat(64), password: NEW_PASSWORD });
    expect(unknown.status).toBe(400);

    const tooShort = await request(http)
      .post('/auth/reset-password')
      .send({ token: 'short', password: NEW_PASSWORD });
    expect(tooShort.status).toBe(400);

    const weakPassword = await request(http)
      .post('/auth/reset-password')
      .send({ token: 'a'.repeat(64), password: 'short' });
    expect(weakPassword.status).toBe(400);
  });

  // --- Change password: signed in ----------------------------------------

  it('changes a password while signed in only when the current one is correct', async () => {
    const email = `changer.${userSeq}.${run}@hotmail.com`;
    expect((await provision(email)).status).toBe(201);
    const session = await login(email, PASSWORD);
    expect(session.status).toBe(200);
    const token = session.body.accessToken as string;

    // No bearer token -> 401 (the route is not public).
    const anonymous = await request(http)
      .post('/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(anonymous.status).toBe(401);

    // Wrong current password -> 400, and nothing changes.
    const wrong = await request(http)
      .post('/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: 'not-my-password', newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.message)).toMatch(/current password is incorrect/i);
    expect((await login(email, PASSWORD)).status).toBe(200);

    // Correct current password -> 200, and the new password takes over.
    const changed = await request(http)
      .post('/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    expect((await login(email, PASSWORD)).status).toBe(401);
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  it('a change of password invalidates an outstanding reset link', async () => {
    const email = `both-paths.${userSeq}.${run}@outlook.com`;
    expect((await provision(email)).status).toBe(201);

    const forgot = await request(http)
      .post('/auth/forgot-password')
      .send({ email });
    const token = forgot.body.resetToken as string;
    expect(token).toBeTruthy();

    const session = await login(email, PASSWORD);
    const change = await request(http)
      .post('/auth/change-password')
      .set(auth(session.body.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(change.status).toBe(200);

    // The earlier reset link must no longer work.
    const reset = await request(http)
      .post('/auth/reset-password')
      .send({ token, password: 'linked-pass-9999' });
    expect(reset.status).toBe(400);
  });
});
