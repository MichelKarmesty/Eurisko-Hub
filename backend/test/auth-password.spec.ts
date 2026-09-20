/**
 * PASSWORD RECOVERY + CHANGE — HTTP contract tests.
 *
 * Boots the whole application over the same HTTP pipeline as `main.ts` and
 * drives it with supertest, pinning the behaviour of the recovery paths on top
 * of login:
 *
 *   FORGOT   POST /auth/forgot-password  -> always the same generic 200 answer,
 *                                           mails a one-time link when the
 *                                           account exists (ADR-008)
 *   ISSUE    POST /users/:id/reset-password -> Admin mints a one-time link
 *                                           (ADR-007, own spec too)
 *   RESET    POST /auth/reset-password   -> one-time token, then new password
 *   CHANGE   POST /auth/change-password  -> signed in, current password required
 *
 * It also proves the "any real email" rule: accounts are created (by the Admin)
 * under gmail.com / hotmail.com / outlook.com addresses, and a malformed address
 * is the only thing the API rejects.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { UsersService } from '../src/users/users.service';

// The reset token may only be echoed back outside production; the tests run
// with NODE_ENV=test and rely on that development behaviour to complete the
// flow without a mail server. Make it explicit rather than implicit, and turn
// the anti mail-bomb cooldown off so each test can mint freely.
process.env.PASSWORD_RESET_RETURN_TOKEN = 'true';
process.env.PASSWORD_RESET_COOLDOWN_SECONDS = '0';
// The public, self-service route is off by default (ADR-009); this suite covers
// both states, so it switches it on here and flips it off in the test that pins
// the default.
process.env.PASSWORD_RESET_SELF_SERVICE = 'true';

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
    return { email, password, id: created.body?.id as number, status: created.status, body: created.body };
  }

  async function login(email: string, password: string) {
    return request(http).post('/auth/login').send({ email, password });
  }

  /** Mint a one-time reset link for an account the way an Admin would. */
  async function issueReset(id: number): Promise<string> {
    const res = await request(http)
      .post(`/users/${id}/reset-password`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    return res.body.resetToken as string;
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
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'Bad Email', email: 'not-an-email', password: PASSWORD, role: 'Employee' });
    expect(badEmail.status).toBe(400);

    const unknownField = await request(http)
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'Extra', email: `x.${run}@gmail.com`, password: PASSWORD, role: 'Employee', admin: true });
    expect(unknownField.status).toBe(400);

    // The same DTO rules guard the public recovery endpoint.
    const badForgot = await request(http)
      .post('/auth/forgot-password')
      .send({ email: 'not-an-email' });
    expect(badForgot.status).toBe(400);

    const unknownForgotField = await request(http)
      .post('/auth/forgot-password')
      .send({ email: `x.${run}@gmail.com`, role: 'Admin' });
    expect(unknownForgotField.status).toBe(400);
  });

  // --- Forgot password: step 1 (self-service, ADR-008) --------------------

  it('is hidden while the self-service switch is off (ADR-009 default)', async () => {
    const previous = process.env.PASSWORD_RESET_SELF_SERVICE;
    process.env.PASSWORD_RESET_SELF_SERVICE = 'false';
    try {
      const hidden = await request(http)
        .post('/auth/forgot-password')
        .send({ email: `hidden.${run}@gmail.com` });
      expect(hidden.status).toBe(404);
      expect(String(hidden.body.message)).toMatch(/Cannot POST \/auth\/forgot-password/);

      // Completing an Admin-issued link still works — that is the supported route.
      const reset = await request(http)
        .post('/auth/reset-password')
        .send({ token: 'a'.repeat(64), password: NEW_PASSWORD });
      expect(reset.status).toBe(400); // unknown token, but the route is live
    } finally {
      process.env.PASSWORD_RESET_SELF_SERVICE = previous;
    }
  });

  it('answers generically for an unknown email and never leaks a token', async () => {
    const res = await request(http)
      .post('/auth/forgot-password')
      .send({ email: `nobody.${run}@gmail.com` });
    expect(res.status).toBe(200);
    expect(String(res.body.message)).toMatch(/if that email is registered/i);
    expect(res.body.resetToken).toBeUndefined();
    expect(res.body.delivery).toBeUndefined();
  });

  it('answers generically for a deleted account and mints nothing', async () => {
    const email = `gone.${run}@gmail.com`;
    const created = await provision(email);
    expect(created.status).toBe(201);

    // The account has no history, so DELETE really removes it — a forgotten
    // password for a row that no longer exists must stay indistinguishable
    // from a never-registered address.
    const deleted = await request(http)
      .delete(`/users/${created.id}`)
      .set(auth(adminToken));
    expect(deleted.status).toBe(200);

    const res = await request(http).post('/auth/forgot-password').send({ email });
    expect(res.status).toBe(200);
    expect(String(res.body.message)).toMatch(/if that email is registered/i);
    expect(res.body.resetToken).toBeUndefined();
  });

  it('returns the dev token with its URL and delivery channel when allowed', async () => {
    const email = `devtoken.${run}@gmail.com`;
    expect((await provision(email)).status).toBe(201);

    const res = await request(http).post('/auth/forgot-password').send({ email });
    expect(res.status).toBe(200);
    expect(res.body.resetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.resetUrl).toBe(
      `http://localhost:5173/?resetToken=${res.body.resetToken}`,
    );
    // No mail provider is configured in the test environment, so MailService
    // falls through to its console transport — proving the send path ran.
    expect(res.body.delivery).toBe('console');
  });

  it('never returns the dev token in production, even without mail configured', async () => {
    const email = `prodtoken.${run}@gmail.com`;
    expect((await provision(email)).status).toBe(201);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(http)
        .post('/auth/forgot-password')
        .send({ email });
      expect(res.status).toBe(200);
      expect(String(res.body.message)).toMatch(/if that email is registered/i);
      expect(res.body.resetToken).toBeUndefined();
      expect(res.body.resetUrl).toBeUndefined();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('throttles repeated requests for one address (anti mail-bomb)', async () => {
    const email = `spammed.${run}@gmail.com`;
    expect((await provision(email)).status).toBe(201);

    const previous = process.env.PASSWORD_RESET_COOLDOWN_SECONDS;
    process.env.PASSWORD_RESET_COOLDOWN_SECONDS = '3600';
    try {
      const first = await request(http)
        .post('/auth/forgot-password')
        .send({ email });
      expect(first.status).toBe(200);
      expect(first.body.resetToken).toBeTruthy();

      const second = await request(http)
        .post('/auth/forgot-password')
        .send({ email });
      expect(second.status).toBe(200);
      expect(String(second.body.message)).toMatch(/if that email is registered/i);
      // Same generic answer, but no fresh mint inside the cooldown window.
      expect(second.body.resetToken).toBeUndefined();
      expect(second.body.resetUrl).toBeUndefined();
    } finally {
      process.env.PASSWORD_RESET_COOLDOWN_SECONDS = previous;
    }
  });

  it('resets a forgotten password with an emailed one-time token, then consumes it', async () => {
    const email = `forgetful.mail.${run}@gmail.com`;
    expect((await provision(email)).status).toBe(201);

    const forgot = await request(http)
      .post('/auth/forgot-password')
      .send({ email });
    expect(forgot.status).toBe(200);
    expect(String(forgot.body.message)).toMatch(/if that email is registered/i);
    const token = forgot.body.resetToken as string;
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

  // --- The stored reset secret never rides along on a user payload --------

  it('never exposes the stored reset hash/expiry on login or on any user payload', async () => {
    const email = `leak.check.${run}@gmail.com`;
    const created = await provision(email);
    expect(created.status).toBe(201);

    // Put a live reset token on the account, so both fields are non-null...
    await issueReset(created.id);

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

  // --- Reset: Admin-issued link -> new password -> sign in ----------------

  it('completes a reset with an Admin-issued one-time token, then consumes it', async () => {
    const email = `forgetful.${run}@gmail.com`;
    const account = await provision(email);
    expect(account.status).toBe(201);

    const token = await issueReset(account.id);
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

  it('rejects an unknown or malformed reset token, and a too-weak password (400)', async () => {
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
    const account = await provision(email);
    expect(account.status).toBe(201);

    const token = await issueReset(account.id);

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

  it('rejects a token whose expiry has passed (400), leaving the password alone', async () => {
    const email = `expired.${run}@gmail.com`;
    const account = await provision(email);
    expect(account.status).toBe(201);

    // Plant a token that was valid yesterday: same storage the app uses, only
    // the expiry differs — the case ADR-005 documents as "expiry rejection".
    const token = 'e'.repeat(64);
    const users = app.get(UsersService);
    await users.setPasswordResetToken(
      account.id,
      createHash('sha256').update(token).digest('hex'),
      Date.now() - 60_000,
    );

    const res = await request(http)
      .post('/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/invalid or has expired/i);

    // Nothing changed: the old password still works, the new one does not.
    expect((await login(email, PASSWORD)).status).toBe(200);
    expect((await login(email, NEW_PASSWORD)).status).toBe(401);
  });

  it('honours PASSWORD_RESET_RETURN_TOKEN=false and echoes nothing', async () => {
    const email = `noecho.${run}@gmail.com`;
    expect((await provision(email)).status).toBe(201);

    const previous = process.env.PASSWORD_RESET_RETURN_TOKEN;
    process.env.PASSWORD_RESET_RETURN_TOKEN = 'false';
    try {
      const res = await request(http).post('/auth/forgot-password').send({ email });
      expect(res.status).toBe(200);
      expect(String(res.body.message)).toMatch(/if that email is registered/i);
      expect(res.body.resetToken).toBeUndefined();
      expect(res.body.resetUrl).toBeUndefined();
      expect(res.body.delivery).toBeUndefined();
    } finally {
      process.env.PASSWORD_RESET_RETURN_TOKEN = previous;
    }
  });
});
