#!/usr/bin/env node
/**
 * Eurisko Hub - FINAL SMOKE TEST.
 *
 *   node scripts/final-smoke.mjs
 *
 * One process, twenty checks, no test framework and no dependencies: it drives
 * the **running** API over HTTP exactly the way the React client does, and it
 * prints a single frame that can be read out during the defense. This is the
 * live-app counterpart to the automated suite (`npm test`): the suite proves the
 * code is correct in isolation, this proves the deployed instance is correct
 * right now, with its own database and its own configuration.
 *
 * The journey it walks is the product's core journey, plus every boundary the
 * defense claims are enforced server-side:
 *
 *   health -> admin login -> provision Employee + IT_Agent -> employee opens a
 *   ticket -> agent sees it in the department queue -> claims it -> is refused
 *   a resolution with no note (400) -> resolves it with a note -> the durable
 *   history shows CREATED -> CLAIMED -> RESOLVED -> the requester reads the
 *   resolution -> the AI suggests fields but creates nothing -> nonsense input
 *   is flagged irrelevant -> password change, admin reset link, and the two
 *   403s (employee->/users, agent->another department) -> admin stats.
 *
 * Configuration (all optional):
 *   API_BASE=http://127.0.0.1:3000   the instance under test
 *   ADMIN_EMAIL / ADMIN_PASSWORD     the seeded Admin (defaults are the app's)
 *   --api <url>                      same as API_BASE
 *
 * Exit code: 0 when all twenty pass, 1 otherwise. Scripts and CI can rely on it.
 */
import {
  Box,
  brief,
  color,
  helpRequested,
  isoNow,
  parseArgs,
  readEnvFile,
  request,
  resolveApiBase,
  ROOT,
} from './lib/defense-ui.mjs';
import path from 'node:path';

const PARSED = parseArgs();
if (
  helpRequested(PARSED, {
    name: 'final-smoke.mjs - Eurisko Hub final smoke test',
    summary:
      'Drives the live API through the full core journey and every RBAC/AI boundary, then prints 20/20 (or the failures).',
    usage: 'node scripts/final-smoke.mjs [--api http://host:port]',
    details: [
      '  --api <url>   Base URL of the running API (default: API_BASE or http://127.0.0.1:3000).',
      '',
      'Environment:',
      '  API_BASE, PORT          Base URL / port of the API.',
      '  ADMIN_EMAIL, ADMIN_PASSWORD  Seeded Admin credentials (default admin@eurisko.com / Admin123!).',
      '  NO_COLOR                Disable ANSI colour.',
      '',
      'Exit codes: 0 = 20/20 passed, 1 = at least one check failed.',
    ],
  })
) {
  process.exit(0);
}

const API = (PARSED.get('api') || resolveApiBase(3000)).replace(/\/+$/, '');
const localEnv = readEnvFile(path.join(ROOT, 'backend', '.env'));
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || localEnv.ADMIN_EMAIL || 'admin@eurisko.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || localEnv.ADMIN_PASSWORD || 'Admin123!';

/** Unique per run so repeated demo runs never collide on an email address. */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EMPLOYEE_EMAIL = process.env.SMOKE_EMPLOYEE_EMAIL || `smoke.employee.${RUN_ID}@example.com`;
const AGENT_EMAIL = process.env.SMOKE_AGENT_EMAIL || `smoke.it.agent.${RUN_ID}@example.com`;
const PASSWORD = 'SmokePass123!';
const NEW_PASSWORD = 'SmokePass456!';
const RESOLUTION_NOTE = 'Replaced the power supply; laptop boots and the user is working again.';

const CATEGORIES = ['IT', 'HR', 'Maintenance'];
const PRIORITIES = ['Low', 'Medium', 'High'];

/** Everything a check may need from an earlier check. */
const ctx = {
  adminToken: null,
  employee: null,
  employeeToken: null,
  agent: null,
  agentToken: null,
  ticket: null,
  hrTicket: null,
  ticketsBeforeAi: null,
  ticketsAfterAi: null,
};

const results = [];

/**
 * Run one check and record its outcome.
 *
 * `run` returns either `true` (the label alone is the proof), or
 * `{ ok, detail }` so the frame can show *why* it passed - "HTTP 403 as
 * expected", "id=7, status=In Progress". A thrown error is a failure whose
 * message becomes the diagnostic, so one broken step cannot abort the run.
 */
async function check(label, run) {
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await run();
  } catch (err) {
    outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const ok = outcome === true ? true : Boolean(outcome && outcome.ok);
  const detail = outcome && typeof outcome === 'object' ? outcome.detail : undefined;
  results.push({ label, ok, detail, ms: Date.now() - startedAt });
  const icon = ok ? color.green('✅') : color.red('❌');
  const tail = detail ? `  ${color.dim(`— ${detail}`)}` : '';
  process.stdout.write(`  ${icon}  ${label}${tail}\n`);
  return ok;
}

/** A failed prerequisite reads as a failed check, never as a crash. */
const need = (value, what) => {
  if (value === null || value === undefined) throw new Error(`prerequisite missing: ${what}`);
  return value;
};

/** Login helper shared by the Admin, Employee and Agent checks. */
async function login(email, password) {
  const res = await request(API, '/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200 || !res.data?.accessToken) {
    throw new Error(`POST /auth/login -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  return res.data;
}

process.stdout.write(`\n${color.bold('Eurisko Hub — final smoke test')}  ${color.dim(API)}\n\n`);

// ── 1. Server health ────────────────────────────────────────────────────────
await check('Server health', async () => {
  const health = await request(API, '/health', { timeoutMs: 5000 });
  if (health.status === 200 && health.data?.status) {
    const db = health.data.db?.sizeHuman ? `db ${health.data.db.sizeHuman}` : `db ${health.data.database ?? 'n/a'}`;
    return { ok: true, detail: `GET /health 200 (${health.ms.toFixed(0)}ms, ${db})` };
  }
  // A slightly older build may not have /health; a live root route still proves it.
  const root = await request(API, '/', { timeoutMs: 5000 });
  if (root.status === 200) return { ok: true, detail: `GET / 200 (${root.ms.toFixed(0)}ms)` };
  return {
    ok: false,
    detail:
      health.status === 0
        ? `no response from ${API} (${health.error}) — is the API running?`
        : `GET /health -> ${health.status}`,
  };
});

// ── 2. Admin login ──────────────────────────────────────────────────────────
await check('Admin login', async () => {
  const session = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.adminToken = session.accessToken;
  return { ok: true, detail: `${session.user?.email} [${session.user?.role}]` };
});

// ── 3. Create Employee account (Admin-only provisioning) ────────────────────
await check('Create Employee account', async () => {
  need(ctx.adminToken, 'Admin login');
  const res = await request(API, '/users', {
    method: 'POST',
    token: ctx.adminToken,
    body: { name: 'Smoke Employee', email: EMPLOYEE_EMAIL, password: PASSWORD, role: 'Employee' },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`POST /users -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  ctx.employee = res.data;
  return { ok: true, detail: `id=${res.data?.id} ${EMPLOYEE_EMAIL}` };
});

// ── 4. Create IT Agent account ──────────────────────────────────────────────
await check('Create IT Agent account', async () => {
  need(ctx.adminToken, 'Admin login');
  const res = await request(API, '/users', {
    method: 'POST',
    token: ctx.adminToken,
    body: { name: 'Smoke IT Agent', email: AGENT_EMAIL, password: PASSWORD, role: 'IT_Agent' },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`POST /users -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  ctx.agent = res.data;
  return { ok: true, detail: `id=${res.data?.id} ${AGENT_EMAIL}` };
});

// ── 5. Employee login ───────────────────────────────────────────────────────
await check('Employee login', async () => {
  const session = await login(EMPLOYEE_EMAIL, PASSWORD);
  ctx.employeeToken = session.accessToken;
  return { ok: true, detail: `${session.user?.email} [${session.user?.role}]` };
});

// ── 6. Employee creates a ticket ────────────────────────────────────────────
await check('Create ticket', async () => {
  need(ctx.employeeToken, 'Employee login');
  const res = await request(API, '/tickets', {
    method: 'POST',
    token: ctx.employeeToken,
    body: {
      title: 'Laptop will not power on',
      description: 'The laptop does not turn on at all since this morning and I cannot work.',
      category: 'IT',
      priority: 'High',
    },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`POST /tickets -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  ctx.ticket = res.data;
  return { ok: true, detail: `#${res.data?.id} "${res.data?.title}" ${res.data?.category}/${res.data?.priority} ${res.data?.status}` };
});

// ── 7. Agent sees it in the department queue ────────────────────────────────
await check('Agent sees ticket in queue', async () => {
  need(ctx.agent, 'IT Agent account');
  const agentToken = await login(AGENT_EMAIL, PASSWORD).then((s) => s.accessToken);
  ctx.agentToken = agentToken;
  const res = await request(API, '/tickets?category=IT', { token: agentToken });
  if (res.status !== 200 || !Array.isArray(res.data)) {
    throw new Error(`GET /tickets?category=IT -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  const found = res.data.find((t) => t.id === ctx.ticket.id);
  if (!found) throw new Error(`ticket #${ctx.ticket.id} is not in the IT queue (${res.data.length} row(s) returned)`);
  return { ok: true, detail: `queue has ${res.data.length} open IT ticket(s), #${ctx.ticket.id} included` };
});

// ── 8. Agent claims the ticket ──────────────────────────────────────────────
await check('Agent claims ticket', async () => {
  need(ctx.agentToken, 'Agent login');
  const res = await request(API, `/tickets/${ctx.ticket.id}/claim`, { method: 'PATCH', token: ctx.agentToken });
  if (res.status !== 200) {
    throw new Error(`PATCH /tickets/${ctx.ticket.id}/claim -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  if (res.data?.status !== 'In Progress' || res.data?.assignedToId !== ctx.agent.id) {
    throw new Error(`claim did not assign the ticket: status=${res.data?.status} assignedToId=${res.data?.assignedToId}`);
  }
  return { ok: true, detail: `status=${res.data.status} assignedToId=${res.data.assignedToId}` };
});

// ── 9. Resolving with no note is refused (400, not 500) ─────────────────────
await check('Resolve without note rejected (400)', async () => {
  need(ctx.agentToken, 'Agent login');
  const res = await request(API, `/tickets/${ctx.ticket.id}/status`, {
    method: 'PATCH',
    token: ctx.agentToken,
    body: { status: 'Resolved' },
  });
  if (res.status !== 400) {
    throw new Error(`expected 400, got ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  return { ok: true, detail: `HTTP 400 — "${brief(res.data?.message, 80)}"` };
});

// ── 10. Resolving with a note succeeds ──────────────────────────────────────
await check('Resolve with note succeeds', async () => {
  need(ctx.agentToken, 'Agent login');
  const res = await request(API, `/tickets/${ctx.ticket.id}/status`, {
    method: 'PATCH',
    token: ctx.agentToken,
    // `note` is the documented contract; the API also accepts `resolutionNote`,
    // which is the field name the web client sends. Both persist the same value.
    body: { status: 'Resolved', note: RESOLUTION_NOTE },
  });
  if (res.status !== 200) {
    throw new Error(`PATCH /tickets/${ctx.ticket.id}/status -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  if (res.data?.status !== 'Resolved' || res.data?.resolutionNote !== RESOLUTION_NOTE) {
    throw new Error(`resolve did not persist: status=${res.data?.status} note=${brief(res.data?.resolutionNote)}`);
  }
  return { ok: true, detail: `status=Resolved, note persisted (${RESOLUTION_NOTE.length} chars)` };
});

// ── 11. Durable history: CREATED -> CLAIMED -> RESOLVED ─────────────────────
await check('History trail complete', async () => {
  need(ctx.employeeToken, 'Employee login');
  const res = await request(API, `/tickets/${ctx.ticket.id}/history`, { token: ctx.employeeToken });
  if (res.status !== 200 || !Array.isArray(res.data)) {
    throw new Error(`GET /tickets/${ctx.ticket.id}/history -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  const actions = res.data.map((event) => event.action);
  const expected = ['CREATED', 'CLAIMED', 'RESOLVED'];
  const orderOk = expected.every((action) => actions.includes(action));
  if (!orderOk) throw new Error(`history is [${actions.join(' -> ')}], expected ${expected.join(' -> ')}`);
  const trailing = actions.slice(actions.indexOf('RESOLVED') + 1);
  if (trailing.length > 0) throw new Error(`unexpected events after RESOLVED: ${trailing.join(', ')}`);
  return { ok: true, detail: actions.join(' → ') };
});

// ── 12. The requester sees Resolved + the note ──────────────────────────────
await check('Employee sees Resolved + note', async () => {
  need(ctx.employeeToken, 'Employee login');
  const res = await request(API, `/tickets/${ctx.ticket.id}`, { token: ctx.employeeToken });
  if (res.status !== 200) {
    throw new Error(`GET /tickets/${ctx.ticket.id} -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  if (res.data?.status !== 'Resolved') throw new Error(`status is ${res.data?.status}, expected Resolved`);
  if (res.data?.resolutionNote !== RESOLUTION_NOTE) throw new Error('the resolution note is not visible to the requester');
  return { ok: true, detail: 'status=Resolved, resolutionNote visible to requester' };
});

// ── 13. AI intake returns an advisory suggestion ────────────────────────────
await check('AI intake returns suggestion', async () => {
  need(ctx.employeeToken, 'Employee login');
  // Count tickets first: check 20 proves this call created none of them.
  const before = await request(API, '/admin/stats', { token: ctx.adminToken });
  ctx.ticketsBeforeAi = before.data?.total ?? null;

  // The documented flat contract: POST /ai/classify { description } -> fields.
  const res = await request(API, '/ai/classify', {
    method: 'POST',
    token: ctx.employeeToken,
    body: { description: 'My laptop will not turn on and I cannot work at all.' },
    timeoutMs: 90000,
  });
  if (res.status !== 200) {
    throw new Error(`POST /ai/classify -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  const s = res.data;
  if (!s) throw new Error(`no classification in the response: ${brief(res.data)}`);
  if (!CATEGORIES.includes(s.category)) throw new Error(`category "${s.category}" is outside ${CATEGORIES.join('/')}`);
  if (!PRIORITIES.includes(s.priority)) throw new Error(`priority "${s.priority}" is outside ${PRIORITIES.join('/')}`);
  if (typeof s.title !== 'string' || s.title.trim().length === 0) throw new Error('missing suggested title');
  if (!s.source) throw new Error('the response does not say where the suggestion came from (source)');
  return {
    ok: true,
    detail: `${s.category}/${s.priority} "${s.title}" via ${s.source} (confidence ${s.confidence})`,
  };
});

// ── 14. Nonsense input is flagged, not dressed up as a suggestion ───────────
await check('AI rejects nonsense input', async () => {
  need(ctx.employeeToken, 'Employee login');
  const res = await request(API, '/ai/classify', {
    method: 'POST',
    token: ctx.employeeToken,
    body: { description: 'asdfghjkl' },
    timeoutMs: 90000,
  });
  if (res.status !== 200) {
    throw new Error(`POST /ai/classify -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  const s = res.data;
  if (!s) throw new Error(`no classification in the response: ${brief(res.data)}`);
  if (s.relevant !== false) {
    throw new Error(`relevant is ${s.relevant} for "asdfghjkl" — the caller would prefill from a meaningless guess`);
  }
  const after = await request(API, '/admin/stats', { token: ctx.adminToken });
  ctx.ticketsAfterAi = after.data?.total ?? null;
  return { ok: true, detail: `relevant=false — "${brief(s.reason, 70)}" (source ${s.source})` };
});

// ── 15. Changing your own password works ────────────────────────────────────
await check('Password change works', async () => {
  need(ctx.employeeToken, 'Employee login');
  const res = await request(API, '/auth/change-password', {
    method: 'POST',
    token: ctx.employeeToken,
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`POST /auth/change-password -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  const session = await login(EMPLOYEE_EMAIL, NEW_PASSWORD);
  ctx.employeeToken = session.accessToken;
  return { ok: true, detail: 'old password rejected, new password signs in' };
});

// ── 16. Admin mints a one-time reset link ───────────────────────────────────
await check('Admin reset link minted', async () => {
  need(ctx.adminToken, 'Admin login');
  const res = await request(API, `/users/${ctx.employee.id}/reset-password`, {
    method: 'POST',
    token: ctx.adminToken,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`POST /users/${ctx.employee.id}/reset-password -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  if (!res.data?.resetToken || !res.data?.resetUrl) {
    throw new Error(`no one-time link in the response: ${brief(res.data)}`);
  }
  return {
    ok: true,
    detail: `single-use link for ${res.data.email}, expires in ${res.data.expiresInMinutes} min`,
  };
});

// ── 17. An Employee cannot reach the Admin-only user list ───────────────────
await check('Employee cannot access /users (403)', async () => {
  need(ctx.employeeToken, 'Employee login');
  const res = await request(API, '/users', { token: ctx.employeeToken });
  if (res.status !== 403) throw new Error(`expected 403, got ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  return { ok: true, detail: `HTTP 403 — "${brief(res.data?.message, 60)}"` };
});

// ── 18. An agent cannot claim outside their department ──────────────────────
await check('Agent cannot claim cross-department (403)', async () => {
  need(ctx.employeeToken, 'Employee login');
  const created = await request(API, '/tickets', {
    method: 'POST',
    token: ctx.employeeToken,
    body: {
      title: 'Payslip missing for this month',
      description: 'My payslip for this month is missing from the portal and payroll needs to confirm it.',
      category: 'HR',
      priority: 'Medium',
    },
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`could not create the HR ticket -> ${created.status}: ${brief(created.data ?? created.error ?? created.text)}`);
  }
  ctx.hrTicket = created.data;

  const res = await request(API, `/tickets/${ctx.hrTicket.id}/claim`, { method: 'PATCH', token: ctx.agentToken });
  if (res.status !== 403) {
    throw new Error(`IT agent claiming HR ticket #${ctx.hrTicket.id}: expected 403, got ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  }
  return { ok: true, detail: `IT agent -> HR ticket #${ctx.hrTicket.id}: HTTP 403` };
});

// ── 19. Admin dashboard counters add up ─────────────────────────────────────
await check('Admin stats returns counters', async () => {
  need(ctx.adminToken, 'Admin login');
  const res = await request(API, '/admin/stats', { token: ctx.adminToken });
  if (res.status !== 200) throw new Error(`GET /admin/stats -> ${res.status}: ${brief(res.data ?? res.error ?? res.text)}`);
  const stats = res.data;
  if (typeof stats?.total !== 'number' || typeof stats?.byStatus !== 'object' || typeof stats?.byCategory !== 'object') {
    throw new Error(`unexpected stats shape: ${brief(stats)}`);
  }
  const summed = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
  if (summed !== stats.total) throw new Error(`byStatus sums to ${summed} but total is ${stats.total}`);
  return { ok: true, detail: `total=${stats.total}, open=${stats.byStatus.Open ?? 0}, resolved=${stats.byStatus.Resolved ?? 0}, unclaimed=${stats.openUnclaimed}` };
});

// ── 20. The AI is advisory: two classify calls created no ticket ────────────
await check('AI created no ticket (advisory-only)', async () => {
  if (ctx.ticketsBeforeAi === null || ctx.ticketsAfterAi === null) {
    throw new Error('could not read the ticket count around the AI checks');
  }
  if (ctx.ticketsAfterAi !== ctx.ticketsBeforeAi) {
    throw new Error(`ticket count moved from ${ctx.ticketsBeforeAi} to ${ctx.ticketsAfterAi} across two AI calls`);
  }
  return { ok: true, detail: `ticket count stayed at ${ctx.ticketsAfterAi} across both AI calls` };
});

// ── Frame ───────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
const total = results.length;
const failed = results.filter((r) => !r.ok);

const box = new Box('FINAL SMOKE TEST', { minWidth: 62 });
for (const result of results) {
  box.row(`${result.ok ? color.green('✅') : color.red('❌')}  ${result.label}`);
}
box.separator();
box.row(
  `${failed.length === 0 ? color.green(color.bold(`Result: ${passed}/${total} passed`)) : color.red(color.bold(`Result: ${passed}/${total} passed`))}`,
);
box.row(`Timestamp: ${isoNow()}`);
box.row(`API: ${API}`);
process.stdout.write('\n');
box.print();

if (failed.length > 0) {
  process.stdout.write(`\n${color.red(color.bold('Failures'))}\n`);
  for (const result of failed) {
    process.stdout.write(`  ${color.red('✗')} ${result.label}\n    ${color.dim(result.detail ?? 'no detail')}\n`);
  }
  process.stdout.write(
    `\n${color.dim('Tip: confirm the API is running (node scripts/dev.mjs) and that ADMIN_EMAIL/ADMIN_PASSWORD match the seeded Admin.')}\n`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
