/**
 * HEALTH / OPS SURFACE + THE CANONICAL AI CONTRACT (14th backend suite).
 *
 * Two things the defense depends on are pinned here, because both are evidence
 * the audience is shown live and neither existed before:
 *
 *  1. `GET /` and `GET /health` - unauthenticated liveness/readiness. `200`
 *     without a token, a real `SELECT 1` behind the readiness answer, the
 *     on-disk SQLite proof (path + size), and the last-five-requests ring
 *     buffer that proves the app is serving traffic during the demo.
 *  2. `POST /ai/classify` - the FLAT documented contract
 *     `{ category, priority, title, relevant, reason, source }`, kept in step
 *     with the nested `/tickets/ai-suggest` shape the React form consumes.
 *
 * The AI cases here are deterministic on purpose: they point the provider at a
 * dead port so the **labelled offline classifier** answers, which is exactly the
 * no-API-key path a fresh clone takes. No network, no key, no flakiness - and it
 * doubles as proof that a dead provider degrades instead of breaking.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { CATEGORIES, PRIORITIES } from '../src/common/domain';

const ADMIN_EMAIL = 'admin@eurisko.com';
const ADMIN_PASSWORD = 'Admin123!';

/** A dead endpoint: connecting fails instantly, so the offline path is used. */
const DEAD_PROVIDER = 'http://127.0.0.1:1/v1';

describe('Health / ops surface and the canonical AI contract', () => {
  let app: INestApplication;
  let http: any;

  /** env keys these tests mutate; restored after every test. */
  const AI_KEYS = [
    'AI_PROVIDER_URL',
    'AI_API_KEY',
    'AI_OFFLINE_FALLBACK',
    'AI_TIMEOUT_MS',
    'AI_RETRY_DELAY_MS',
    'AI_ENABLED',
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

  const forceOffline = () => {
    process.env.AI_PROVIDER_URL = DEAD_PROVIDER;
    delete process.env.AI_API_KEY;
    delete process.env.AI_FALLBACK_PROVIDER_URL;
    process.env.AI_OFFLINE_FALLBACK = 'true';
    process.env.AI_TIMEOUT_MS = '500';
    process.env.AI_RETRY_DELAY_MS = '0';
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule], // in-memory sqljs DB + seeded admin (test/setup.ts)
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app); // identical boundary to src/main.ts
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    savedEnv = {};
    for (const key of AI_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of AI_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  async function adminToken(): Promise<string> {
    const login = await request(http)
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    return login.body.accessToken as string;
  }

  describe('GET / - liveness', () => {
    it('answers 200 without a token and identifies the service', async () => {
      const res = await request(http).get('/');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('eurisko-hub-api');
      expect(res.body.health).toBe('/health');
      expect(typeof res.body.uptimeSeconds).toBe('number');
      expect(res.body.timestamp).toBeTruthy();
    });
  });

  describe('GET /health - readiness + ops evidence', () => {
    it('answers 200 without a token, and the database really answers', async () => {
      const res = await request(http).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.database).toBe('connected'); // the SELECT 1 succeeded
      expect(res.body.schemaVersion).toBe(1);
      expect(typeof res.body.uptimeSeconds).toBe('number');
      expect(res.body.uptime).toMatch(/\d/);
    });

    it('reports the database mode and file so persistence is provable', async () => {
      const res = await request(http).get('/health');
      // test/setup.ts deletes DB_FILE, so tests legitimately run in memory.
      expect(['file', 'memory']).toContain(res.body.db.mode);
      expect(typeof res.body.db.sizeBytes).toBe('number');
      expect(typeof res.body.db.sizeHuman).toBe('string');
      if (res.body.db.mode === 'memory') {
        expect(res.body.db.file).toBeNull();
      } else {
        expect(typeof res.body.db.file).toBe('string');
      }
    });

    it('records real traffic in the last-five list, and never logs its own polling', async () => {
      // Provoke two requests that are NOT health checks: a rejected login (401)
      // and a successful one (200).
      await request(http).post('/auth/login').send({ email: ADMIN_EMAIL, password: 'wrong-password' });
      await request(http).post('/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

      const res = await request(http).get('/health');
      expect(res.status).toBe(200);

      const paths = (res.body.requests.last5 as Array<{ path: string }>).map((entry) => entry.path);
      expect(paths).toContain('/auth/login');
      // The monitor polls /health every 10s; if it were logged it would push the
      // real traffic out of the buffer, so this is a real regression guard.
      expect(paths).not.toContain('/health');
      expect(paths).not.toContain('/');

      const login = (res.body.requests.last5 as Array<{ method: string; path: string; status: number; ms: number }>).find(
        (entry) => entry.path === '/auth/login',
      );
      expect(login?.method).toBe('POST');
      expect(typeof login?.status).toBe('number');
      expect(typeof login?.ms).toBe('number');
      expect(res.body.requests.total).toBeGreaterThan(0);
    });

    it('leaks no account data, hash or secret', async () => {
      const token = await adminToken();
      await request(http).get('/users').set({ Authorization: `Bearer ${token}` });
      const res = await request(http).get('/health');
      const body = JSON.stringify(res.body);
      for (const forbidden of ['passwordHash', 'accessToken', ADMIN_PASSWORD, 'admin@eurisko.com']) {
        expect(body).not.toContain(forbidden);
      }
    });
  });

  describe('POST /ai/classify - the flat documented contract', () => {
    it('requires authentication (401 without a token)', async () => {
      const res = await request(http)
        .post('/ai/classify')
        .send({ description: 'my laptop cannot reach the office wifi' });
      expect(res.status).toBe(401);
    });

    it('rejects a missing or too-short description with 400', async () => {
      const token = await adminToken();
      const missing = await request(http).post('/ai/classify').set({ Authorization: `Bearer ${token}` }).send({});
      expect(missing.status).toBe(400);

      const short = await request(http)
        .post('/ai/classify')
        .set({ Authorization: `Bearer ${token}` })
        .send({ description: 'hi' });
      expect(short.status).toBe(400);
    });

    it('returns category, priority, title, relevant and source - from the labelled offline classifier when no provider answers', async () => {
      forceOffline();
      const token = await adminToken();

      const res = await request(http)
        .post('/ai/classify')
        .set({ Authorization: `Bearer ${token}` })
        .send({ description: 'My laptop will not connect to the office wifi and I cannot work' });

      expect(res.status).toBe(200);
      expect(CATEGORIES).toContain(res.body.category);
      expect(PRIORITIES).toContain(res.body.priority);
      expect(typeof res.body.title).toBe('string');
      expect(res.body.title.length).toBeGreaterThan(0);
      expect(typeof res.body.relevant).toBe('boolean');
      expect(res.body.relevant).toBe(true);
      // A dead provider must never be passed off as the model's answer.
      expect(res.body.source).toBe('offline');
      expect(res.body.notice).toBeTruthy();
    });

    it('accepts `text` as an alias for `description` (legacy callers keep working)', async () => {
      forceOffline();
      const token = await adminToken();
      const res = await request(http)
        .post('/ai/classify')
        .set({ Authorization: `Bearer ${token}` })
        .send({ text: 'the printer on the second floor is jammed' });
      expect(res.status).toBe(200);
      expect(CATEGORIES).toContain(res.body.category);
    });

    it('answers relevant:false for nonsense instead of inventing a request', async () => {
      forceOffline();
      const token = await adminToken();
      const res = await request(http)
        .post('/ai/classify')
        .set({ Authorization: `Bearer ${token}` })
        .send({ description: 'asdfghjkl qwertyuiop zxcvbnm' });

      expect(res.status).toBe(200); // a successful call about unusable input
      expect(res.body.relevant).toBe(false);
      expect(typeof res.body.reason).toBe('string');
      expect(res.body.reason.length).toBeGreaterThan(0);
    });

    it('reports 503 when the feature is off and there is no offline fallback', async () => {
      process.env.AI_ENABLED = 'false';
      const token = await adminToken();
      const res = await request(http)
        .post('/ai/classify')
        .set({ Authorization: `Bearer ${token}` })
        .send({ description: 'my laptop is broken and I cannot work' });
      expect(res.status).toBe(503);
    });

    it('never writes to the database: classifying creates no ticket', async () => {
      forceOffline();
      const token = await adminToken();
      const before = await request(http).get('/admin/stats').set({ Authorization: `Bearer ${token}` });
      const beforeTotal = before.body.total as number;

      await request(http)
        .post('/ai/classify')
        .set({ Authorization: `Bearer ${token}` })
        .send({ description: 'my laptop screen is cracked and I cannot work' });

      const after = await request(http).get('/admin/stats').set({ Authorization: `Bearer ${token}` });
      expect(after.body.total).toBe(beforeTotal);
    });
  });

  describe('POST /tickets/ai-suggest - the nested UI shape is unchanged (regression)', () => {
    it('still answers { suggestion: {...}, source } for the React form', async () => {
      forceOffline();
      const token = await adminToken();
      const res = await request(http)
        .post('/tickets/ai-suggest')
        .set({ Authorization: `Bearer ${token}` })
        .send({ text: 'the air conditioning on the third floor is leaking water' });

      expect(res.status).toBe(200);
      expect(res.body.suggestion).toBeTruthy();
      expect(CATEGORIES).toContain(res.body.suggestion.category);
      expect(res.body.source).toBe('offline');
    });
  });
});
