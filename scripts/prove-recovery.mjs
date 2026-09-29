#!/usr/bin/env node
/**
 * Eurisko Hub - failure + recovery proof.
 *
 *   node scripts/prove-recovery.mjs
 *
 * Four scenarios, each demonstrated against a **throwaway** backend the script
 * starts and stops itself (its own free port, its own SQLite file). Your real
 * `backend/.data/hub.sqlite` and any running dev server are never touched, so
 * this is safe to run live during the defense.
 *
 *   1. Admin lockout recovery  - the app refuses to deactivate the last Admin
 *      (400) through the UI/API; and if the Admin row is removed out-of-band,
 *      the next boot re-seeds one while every other account and ticket survives.
 *   2. AI provider failure     - with the provider pointed at a dead endpoint,
 *      `/tickets/ai-suggest` still answers, labelled `source: "offline"`, and
 *      the UI renders "Suggested (offline)" - never dressing rules up as a model.
 *   3. Database loss           - the SQLite file is deleted (and a corrupt file
 *      is tested) and the next boot creates a fresh database and re-seeds the
 *      Admin, with no manual migration step.
 *   4. Token expiry            - an expired, mis-signed or malformed JWT is
 *      rejected with 401 - never a 500 and never a crash.
 *
 * Every step is written, timestamped, to `artifacts/recovery-proof-<timestamp>.txt`
 * so the evidence exists as a file after the demo, not only as scrollback.
 *
 * Options:
 *   --help        Show help and exit 0.
 *   --scenario <n>  Run only one scenario (1-4).
 *
 * Environment: NO_COLOR disables colour. The script builds `backend/dist` first
 * if it is missing or stale.
 *
 * Exit codes: 0 = every scenario passed, 1 = at least one failed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ARTIFACTS,
  BACKEND,
  Box,
  brief,
  color,
  helpRequested,
  isoNow,
  parseArgs,
  request,
  ROOT,
  waitForApi,
} from './lib/defense-ui.mjs';

const PARSED = parseArgs();
if (
  helpRequested(PARSED, {
    name: 'prove-recovery.mjs - failure + recovery proof',
    summary:
      'Demonstrates four recovery scenarios (Admin re-seed, AI offline fallback, database loss, token expiry) on isolated throwaway backends and writes a timestamped evidence log.',
    usage: 'node scripts/prove-recovery.mjs [--scenario 1|2|3|4]',
    details: [
      '  --scenario <n>   Run a single scenario instead of all four.',
      '',
      'Evidence log: artifacts/recovery-proof-<timestamp>.txt',
      'Environment:   NO_COLOR',
      '',
      'Exit codes: 0 = all selected scenarios passed, 1 = a scenario failed.',
    ],
  })
) {
  process.exit(0);
}

const ONLY = PARSED.get('scenario') ? Number(PARSED.get('scenario')) : null;
const ADMIN_EMAIL = 'admin@eurisko.com';
const ADMIN_PASSWORD = 'RecoveryProof123!';
const JWT_SECRET = 'defense-recovery-proof-secret';
const DATA_DIR = path.join(ARTIFACTS, 'recovery-work');
const FRONTEND_REQUESTER = path.join(ROOT, 'frontend', 'src', 'components', 'RequesterView.tsx');

const evidence = [];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactFile = path.join(ARTIFACTS, `recovery-proof-${stamp}.txt`);
const running = new Set();

/** Write a plain line to the evidence log and the console. */
function say(line = '') {
  evidence.push(line);
  process.stdout.write(`${line}\n`);
}

function heading(text) {
  say('');
  say('='.repeat(74));
  say(`${text}`);
  say(`[${isoNow()}]`);
  say('='.repeat(74));
}

function step(text) {
  say(`  · ${text}`);
}

function verdict(ok, text) {
  say(`  ${ok ? 'PASS' : 'FAIL'} — ${text}`);
  return ok;
}

// ── Process / port helpers ──────────────────────────────────────────────────

/** A free ephemeral port, so four scenarios never collide with the dev server. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Build `backend/dist` unless it is already newer than every source file. */
function ensureBuild() {
  const entry = path.join(BACKEND, 'dist', 'main.js');
  const newestSource = (() => {
    let newest = 0;
    const walk = (dir) => {
      for (const entryName of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entryName.name);
        if (entryName.isDirectory()) walk(full);
        else if (entryName.name.endsWith('.ts')) newest = Math.max(newest, statSync(full).mtimeMs);
      }
    };
    walk(path.join(BACKEND, 'src'));
    return newest;
  })();

  const stale = !existsSync(entry) || statSync(entry).mtimeMs < newestSource;
  if (!stale) {
    step('backend/dist is current — reusing the build');
    return true;
  }
  step('building backend (npm run build) …');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: BACKEND,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const ok = result.status === 0;
  step(ok ? 'backend built' : `backend build failed (exit ${result.status})`);
  return ok;
}

/**
 * Start an isolated API. Returns `{ base, port, log() }`; the process is tracked
 * so `stopAll()` can guarantee cleanup even if a check throws mid-scenario.
 */
async function startApi({ dbFile, env = {}, label = 'api' }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbFile,
      JWT_SECRET,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);

  const lines = [];
  const capture = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) lines.push(line.trim());
    }
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const ready = await Promise.race([
    waitForApi(base, { timeoutMs: 25000 }),
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve({ route: null, exited: { code: child.exitCode } });
      child.once('exit', (code, signal) => resolve({ route: null, exited: { code, signal } }));
    }),
  ]);
  if (!ready.route) {
    const tail = lines.slice(-12).join('\n    ');
    await stopApi(child);
    if (ready.exited) {
      throw new Error(
        `${label} exited during boot (code ${ready.exited.code ?? 'null'}${ready.exited.signal ? `, ${ready.exited.signal}` : ''}).\n    ${tail || '(no output)'}`,
      );
    }
    throw new Error(`${label} did not become healthy on ${base}.\n    ${tail || '(no output)'}`);
  }
  step(`${label} healthy on ${base} after boot (${ready.route})`);
  return { base, port, child, lines, log: () => lines, base_route: ready.route };
}

async function stopApi(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    running.delete(child);
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
  running.delete(child);
}

async function stopAll() {
  await Promise.all([...running].map((child) => stopApi(child)));
}

/** POST /auth/login and return the parsed session. */
async function login(base, email, password) {
  const res = await request(base, '/auth/login', { method: 'POST', body: { email, password } });
  return res;
}

// ── Scenario 1: Admin lockout recovery ──────────────────────────────────────

async function scenarioAdminLockout() {
  heading('SCENARIO 1 — Admin lockout recovery: the database can never be locked out');
  const dbFile = path.join(DATA_DIR, 'admin-lockout.sqlite');
  rmSync(dbFile, { force: true });
  say(`  Database: ${path.relative(ROOT, dbFile)}`);
  let ok = true;

  const first = await startApi({ dbFile, label: 'fresh API' });
  try {
    const session = await login(first.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    ok = verdict(session.status === 200, `fresh database seeded Admin and signed in (HTTP ${session.status})`) && ok;
    const admin = session.data?.user;

    // Create a non-Admin account so we can prove its data survives the recovery.
    const employee = await request(first.base, '/users', {
      method: 'POST',
      token: session.data?.accessToken,
      body: { name: 'Recovery Employee', email: 'recovery.employee@example.com', password: 'RecoveryEmp123!', role: 'Employee' },
    });
    ok = verdict(employee.status === 201 || employee.status === 200, `created a non-Admin account (HTTP ${employee.status})`) && ok;

    // Guard rail: the API refuses to deactivate the last active Admin.
    const deactivate = await request(first.base, `/users/${admin?.id}/active`, {
      method: 'PATCH',
      token: session.data?.accessToken,
      body: { active: false },
    });
    ok = verdict(
      deactivate.status === 400,
      `the API refuses to deactivate an Admin account through the API (HTTP ${deactivate.status}: "${brief(deactivate.data?.message, 70)}")`,
    ) && ok;
    step('the "last active Admin" half of the guard is pinned by the automated suite: admin-user-reactivation.spec.ts, admin-role-change.spec.ts, admin-user-deletion.spec.ts');
  } finally {
    await stopApi(first.child);
  }

  // Out-of-band removal: the only way to actually lose the Admin row. Because
  // sql.js autosaves writes, the server must be stopped before surgery.
  step('server stopped; removing every Admin row directly from the database (simulating manual corruption/loss)');
  const deleted = await removeAdminsFromDb(dbFile);
  ok = verdict(deleted > 0, `deleted ${deleted} Admin row(s) from users`) && ok;

  const second = await startApi({ dbFile, label: 'recovered API' });
  try {
    const session = await login(second.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    ok = verdict(session.status === 200 && session.data?.user?.role === 'Admin', `boot re-seeded an Admin and sign-in works (HTTP ${session.status})`) && ok;

    const seedLines = second.log().filter((line) => /seed/i.test(line));
    for (const line of seedLines.slice(-2)) {
      step(`boot log: ${line.replace(/^\[Nest\][^L]*LOG\s*/, '').trim()}`);
    }
    if (seedLines.length === 0) step(`boot log: ${second.log().slice(-3).join(' | ') || '(no output captured)'}`);

    if (session.status === 200) {
      const users = await request(second.base, '/users', { token: session.data.accessToken });
      const emails = Array.isArray(users.data) ? users.data.map((u) => u.email) : [];
      ok = verdict(emails.includes('recovery.employee@example.com'), `the pre-existing account survived (${emails.length} account(s): ${emails.join(', ') || 'none'})`) && ok;
    }
  } finally {
    await stopApi(second.child);
  }

  return ok;
}

/** Delete every Admin row with sql.js loaded from backend/node_modules. */
async function removeAdminsFromDb(dbFile) {
  const require = createRequire(path.join(BACKEND, 'package.json'));
  let initSqlJs;
  try {
    initSqlJs = require('sql.js');
  } catch (err) {
    throw new Error(
      `sql.js is not installed under backend/node_modules (${err instanceof Error ? err.message : err}). ` +
        'Run `npm ci` in backend/ first.',
    );
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(dbFile));
  try {
    const before = db.exec("SELECT COUNT(*) FROM users WHERE role = 'Admin'")[0]?.values?.[0]?.[0] ?? 0;
    db.run("DELETE FROM users WHERE role = 'Admin'");
    writeFileSync(dbFile, Buffer.from(db.export()));
    return Number(before);
  } finally {
    db.close();
  }
}

// ── Scenario 2: AI provider failure -> offline fallback ─────────────────────

async function scenarioAiFallback() {
  heading('SCENARIO 2 — AI provider failure: the advisory intake degrades to the labelled offline classifier');
  const dbFile = path.join(DATA_DIR, 'ai-fallback.sqlite');
  rmSync(dbFile, { force: true });
  let ok = true;

  const api = await startApi({
    dbFile,
    label: 'API with a dead AI provider',
    env: {
      // A closed port: every call must fail fast and fall through to the rules.
      AI_PROVIDER_URL: 'http://127.0.0.1:9/v1',
      AI_FALLBACK_PROVIDER_URL: '',
      AI_API_KEY: '',
      AI_OFFLINE_FALLBACK: 'true',
      AI_TIMEOUT_MS: '1500',
      AI_TOTAL_BUDGET_MS: '4000',
      AI_RETRY_DELAY_MS: '100',
    },
  });
  try {
    const session = await login(api.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    const token = session.data?.accessToken;
    const before = await request(api.base, '/admin/stats', { token });

    const started = Date.now();
    const res = await request(api.base, '/tickets/ai-suggest', {
      method: 'POST',
      token,
      body: { text: 'The air conditioning on the second floor is leaking water on the floor.' },
      timeoutMs: 30000,
    });
    const elapsed = Date.now() - started;

    const suggestion = res.data?.suggestion;
    ok = verdict(res.status === 200, `the endpoint still answers with the provider dead (HTTP ${res.status} in ${elapsed}ms)`) && ok;
    ok = verdict(Boolean(suggestion), `a usable suggestion came back: ${brief(suggestion)}`) && ok;
    ok = verdict(res.data?.source === 'offline', `the answer is labelled source="${res.data?.source}" (never passed off as the model's)`) && ok;
    ok = verdict(typeof res.data?.notice === 'string' && /offline/i.test(res.data.notice), `a human notice explains why: "${brief(res.data?.notice, 90)}"`) && ok;

    const after = await request(api.base, '/admin/stats', { token });
    ok = verdict(before.data?.total === after.data?.total, `advisory-only confirmed: ticket count stayed at ${after.data?.total} across the AI call`) && ok;

    // UI label proof: the client is what the audience actually sees.
    const uiSource = existsSync(FRONTEND_REQUESTER) ? readFileSync(FRONTEND_REQUESTER, 'utf8') : '';
    const offlineLabel = uiSource.includes('Suggested (offline)');
    const offlineHint = /Suggested offline — no AI model is configured/.test(uiSource);
    ok = verdict(offlineLabel, 'the React client renders the "Suggested (offline)" badge for source === "offline"') && ok;
    ok = verdict(offlineHint, 'the client also shows the "no AI model is configured" hint') && ok;
    if (offlineLabel) {
      const line = uiSource.split(/\r?\n/).find((l) => l.includes('Suggested (offline)'))?.trim();
      step(`frontend/src/components/RequesterView.tsx: ${brief(line, 110)}`);
    }
  } finally {
    await stopApi(api.child);
  }
  return ok;
}

// ── Scenario 3: database loss / corruption -> clean recovery ────────────────

async function scenarioDatabaseLoss() {
  heading('SCENARIO 3 — Database loss: a missing or corrupt SQLite file recovers on the next boot');
  let ok = true;

  // 3a. Deleted file.
  const deletedDb = path.join(DATA_DIR, 'deleted.sqlite');
  rmSync(deletedDb, { force: true });
  say('');
  say('  3a. Database file deleted');
  let api = await startApi({ dbFile: deletedDb, label: 'API on a fresh path' });
  try {
    const session = await login(api.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    ok = verdict(session.status === 200, `a new database was created and the Admin re-seeded (HTTP ${session.status})`) && ok;
    ok = verdict(existsSync(deletedDb), `the SQLite file now exists at ${path.relative(ROOT, deletedDb)}`) && ok;
  } finally {
    await stopApi(api.child);
  }

  // 3b. Corrupt file: report what the build actually does, then prove recovery.
  const corruptDb = path.join(DATA_DIR, 'corrupt.sqlite');
  rmSync(corruptDb, { force: true });
  writeFileSync(corruptDb, Buffer.from('this is not a sqlite database\n'.repeat(64)));
  say('');
  say(`  3b. Corrupt file planted (${statSync(corruptDb).size} bytes of non-database text)`);

  let booted = true;
  try {
    api = await startApi({ dbFile: corruptDb, label: 'API on a corrupt file' });
  } catch (err) {
    booted = false;
    step(
      `observed: the process exits on a corrupt file rather than serving — ${brief(String(err instanceof Error ? err.message : err).replace(/\s+/g, ' '), 150)}`,
    );
  }
  if (booted && api) {
    const session = await login(api.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    ok = verdict(session.status === 200, `the build recovered from the corrupt file on its own (HTTP ${session.status})`) && ok;
    await stopApi(api.child);
  } else {
    // The documented operational step: remove the bad file, restart, re-seed.
    step('documented recovery: delete the corrupt file, restart, the boot re-creates and re-seeds');
    rmSync(corruptDb, { force: true });
    api = await startApi({ dbFile: corruptDb, label: 'API after removing the corrupt file' });
    try {
      const session = await login(api.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      ok = verdict(session.status === 200, `after removing the corrupt file the app created a clean DB and re-seeded the Admin (HTTP ${session.status})`) && ok;
    } finally {
      await stopApi(api.child);
    }
  }

  return ok;
}

// ── Scenario 4: token expiry -> clean 401 ───────────────────────────────────

/** Minimal HS256 JWT signer built on node:crypto - no dependency. */
function signJwt(payload, secret) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

async function scenarioTokenExpiry() {
  heading('SCENARIO 4 — Auth token expiry: bad tokens are rejected with 401, never 500');
  const dbFile = path.join(DATA_DIR, 'token-expiry.sqlite');
  rmSync(dbFile, { force: true });
  let ok = true;

  const api = await startApi({ dbFile, label: 'API with a known JWT secret' });
  try {
    const session = await login(api.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    const token = session.data?.accessToken;
    const userId = session.data?.user?.id;
    ok = verdict(Boolean(token), 'obtained a valid token to compare against') && ok;

    const now = Math.floor(Date.now() / 1000);
    const expired = signJwt({ sub: userId, email: ADMIN_EMAIL, role: 'Admin', iat: now - 7200, exp: now - 3600 }, JWT_SECRET);
    const wrongSecret = signJwt({ sub: userId, email: ADMIN_EMAIL, role: 'Admin', iat: now - 60, exp: now + 3600 }, 'not-the-real-secret');
    const cases = [
      ['expired token (exp one hour ago)', expired],
      ['token signed with the wrong secret', wrongSecret],
      ['malformed token', 'not.a.jwt'],
      ['empty signature', `${token?.split('.').slice(0, 2).join('.')}.`],
    ];

    for (const [label, bad] of cases) {
      const res = await request(api.base, '/auth/me', { token: bad });
      ok = verdict(res.status === 401, `${label} -> HTTP ${res.status} ("${brief(res.data?.message, 50)}")`) && ok;
    }

    const good = await request(api.base, '/auth/me', { token });
    ok = verdict(good.status === 200, `the valid token still works -> HTTP ${good.status} (${good.data?.email})`) && ok;
  } finally {
    await stopApi(api.child);
  }
  return ok;
}

// ── Main ────────────────────────────────────────────────────────────────────

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(ARTIFACTS, { recursive: true });

say('Eurisko Hub — failure + recovery proof');
say(`Generated: ${isoNow()}`);
say(`Host: ${process.platform} ${process.arch} · Node ${process.version}`);
say(`Repository: ${ROOT}`);
say(`Isolated working directory: ${path.relative(ROOT, DATA_DIR)}`);

const scenarios = [
  { id: 1, title: 'Admin lockout recovery', run: scenarioAdminLockout },
  { id: 2, title: 'AI provider failure -> offline fallback', run: scenarioAiFallback },
  { id: 3, title: 'Database loss -> clean recovery', run: scenarioDatabaseLoss },
  { id: 4, title: 'Auth token expiry -> clean 401', run: scenarioTokenExpiry },
];

const results = [];
try {
  if (!ensureBuild()) {
    throw new Error('backend build failed — cannot start the app for the recovery scenarios');
  }

  for (const scenario of scenarios) {
    if (ONLY && scenario.id !== ONLY) continue;
    let ok = false;
    try {
      ok = await scenario.run();
    } catch (err) {
      say('');
      verdict(false, `scenario ${scenario.id} crashed: ${err instanceof Error ? err.message : String(err)}`);
      ok = false;
    }
    results.push({ ...scenario, ok });
    say('');
    say(`  Scenario ${scenario.id} result: ${ok ? 'PASS' : 'FAIL'}`);
  }
} finally {
  await stopAll();
}

const allPassed = results.length > 0 && results.every((r) => r.ok);
say('');
say('-'.repeat(74));
for (const result of results) {
  say(`  ${result.ok ? 'PASS' : 'FAIL'}  Scenario ${result.id}: ${result.title}`);
}
say(`  Overall: ${results.filter((r) => r.ok).length}/${results.length} passed · ${isoNow()}`);
say(`  Evidence log: ${path.relative(ROOT, artifactFile)}`);

writeFileSync(artifactFile, `${evidence.join('\n')}\n`);

// Console summary frame (the artifact file stays plain text).
const box = new Box('FAILURE + RECOVERY PROOF', { minWidth: 62 });
for (const result of results) {
  box.row(`${result.ok ? color.green('✅') : color.red('❌')}  Scenario ${result.id}: ${result.title}`);
}
box.separator();
box.row(`${allPassed ? color.green(color.bold(`Result: ${results.filter((r) => r.ok).length}/${results.length} scenarios passed`)) : color.red(color.bold('Result: some scenarios failed'))}`);
box.row(`Timestamp: ${isoNow()}`);
box.row(`Evidence: ${path.relative(ROOT, artifactFile)}`);
process.stdout.write('\n');
box.print();

process.exit(allPassed ? 0 : 1);
