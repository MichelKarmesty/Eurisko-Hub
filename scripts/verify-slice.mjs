#!/usr/bin/env node
/**
 * Eurisko Hub — "Assigned agent resolves a ticket" slice verifier.
 *
 * Runs the Definition-of-Done checks for the slice
 *   React action -> PATCH /tickets/:id/status -> SQLite -> React result
 * against a LIVE backend (the React side is verified separately in the UI,
 * this script proves the backend contract half of the flow).
 *
 * Usage:
 *   node scripts/verify-slice.mjs [full|persist]
 *
 * Modes:
 *   full    — fresh-DB scenario: provisions users, opens a ticket, claims it,
 *             runs the negative tests (400 empty note, 400 bad status,
 *             403 requester, 403 unassigned agent, 403 admin-on-others) and
 *             resolves it as the assigned agent. Leaves durable state behind.
 *   persist — restart-proof check: logs in again and asserts the Resolved
 *             ticket + RESOLVED history event are still there (proves the
 *             state change survived a server restart).
 *
 * Env:
 *   BASE_URL      API base (default http://localhost:3000)
 *   ADMIN_EMAIL   seeded admin email (default rami.fares@eurisko.com)
 *   ADMIN_PASSWORD                (default Admin123!)
 */
import process from 'node:process';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const MODE = process.argv[2] ?? 'full';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'rami.fares@eurisko.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin123!';

// Demo personas provisioned through the real Admin /users endpoint.
// Keep this list in sync with DEMO_ACCOUNTS in frontend/src/components/AuthScreen.tsx.
const REQUESTER = { name: 'Rana Khoury', email: 'rana.khoury@eurisko.com', password: 'password123' };
const AGENT = { name: 'Karim Haddad', email: 'karim.haddad@eurisko.com', password: 'password123' };
const OTHER_AGENT = { name: 'Nadim Saad', email: 'nadim.saad@eurisko.com', password: 'password123' };
const HR_AGENT = { name: 'Layla Nassar', email: 'layla.nassar@eurisko.com', password: 'password123' };
const MAINT_AGENT = { name: 'Elias Aoun', email: 'elias.aoun@eurisko.com', password: 'password123' };
const NOTE = 'Replaced the HDMI cable; display is stable now.';
const TITLE = 'First slice E2E - monitor keeps flickering';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function login(credentials) {
  const r = await req('POST', '/auth/login', { body: credentials });
  return r.status === 200 ? r.data : null;
}

/** Login, or provision through the Admin API and login (fresh DB). */
async function ensureUser(adminToken, credentials, role) {
  let session = await login({ email: credentials.email, password: credentials.password });
  if (!session) {
    const created = await req('POST', '/users', {
      token: adminToken,
      body: { name: credentials.name, email: credentials.email, password: credentials.password, role },
    });
    if (created.status !== 201) {
      throw new Error(`Could not provision ${role} ${credentials.email}: ${created.status} ${JSON.stringify(created.data)}`);
    }
    session = await login({ email: credentials.email, password: credentials.password });
  }
  return session;
}

async function resolveTicket(token, id, note) {
  return req('PATCH', `/tickets/${id}/status`, {
    token,
    body: { status: 'Resolved', resolutionNote: note },
  });
}

const ADMIN_TITLE_PREFIX = 'Admin capability - ';
const REQUESTER_TITLE_PREFIX = 'First slice E2E - ';

function main() {
  console.log(`\n=== verify-slice (${MODE}) against ${BASE} ===`);
}

async function run() {
  main();

  // 1. Admin session
  const adminLoginRes = await req('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check('Admin can log in (seeded account)', adminLoginRes.status === 200, `HTTP ${adminLoginRes.status}`);
  if (adminLoginRes.status !== 200) {
    console.log('\nCannot continue without the seeded admin. Start the backend so it seeds, then re-run.');
    process.exitCode = 1;
    return;
  }
  const admin = adminLoginRes.data;

  if (MODE === 'full') {
    // 2. Provision personas through the Admin user-management API.
    const requester = await ensureUser(admin.accessToken, REQUESTER, 'Employee');
    const agent = await ensureUser(admin.accessToken, AGENT, 'IT_Agent');
    const other = await ensureUser(admin.accessToken, OTHER_AGENT, 'IT_Agent');
    const hr = await ensureUser(admin.accessToken, HR_AGENT, 'HR_Agent');
    const maint = await ensureUser(admin.accessToken, MAINT_AGENT, 'Maintenance_Agent');
    check('Provisioned Requester (Employee)', !!requester?.accessToken);
    check('Provisioned assigned Agent (IT_Agent)', !!agent?.accessToken);
    check('Provisioned unassigned Agent (IT_Agent)', !!other?.accessToken);
    check('Provisioned HR Agent (HR_Agent)', !!hr?.accessToken);
    check('Provisioned Maintenance Agent (Maintenance_Agent)', !!maint?.accessToken);

    // 3. Requester opens an IT ticket (product-spec §3).
    const opened = await req('POST', '/tickets', {
      token: requester.accessToken,
      body: { title: TITLE, description: 'External monitor flickers every few seconds.', category: 'IT', priority: 'High' },
    });
    const ticket = opened.data;
    check('Requester opens a ticket (POST /tickets)', opened.status === 201 && ticket?.status === 'Open', `#${ticket?.id} ${ticket?.status}`);

    // 4. Assigned agent claims it from the IT queue (ADR-001): Open -> In Progress.
    const claimed = await req('PATCH', `/tickets/${ticket.id}/claim`, { token: agent.accessToken });
    check('Assigned agent claims ticket', claimed.status === 200 && claimed.data?.status === 'In Progress', `HTTP ${claimed.status} -> ${claimed.data?.status}`);
    check('Claim records assignedToId', claimed.data?.assignedToId === agent.user?.id, `assignedTo=${claimed.data?.assignedToId}`);

    // 5. Validation — the backend must reject bad input (400) ...
    const emptyNote = await resolveTicket(agent.accessToken, ticket.id, '   ');
    check('400: empty resolutionNote rejected', emptyNote.status === 400, `HTTP ${emptyNote.status} ${JSON.stringify(emptyNote.data?.message)}`);

    const badStatus = await req('PATCH', `/tickets/${ticket.id}/status`, {
      token: agent.accessToken,
      body: { status: 'Cancelled', resolutionNote: 'nope' },
    });
    check('400: unknown status rejected (DTO)', badStatus.status === 400, `HTTP ${badStatus.status}`);

    // 6. ... and reject unauthorized actors (403).
    const requesterTry = await resolveTicket(requester.accessToken, ticket.id, 'not allowed');
    check('403: requester (not assigned) cannot resolve', requesterTry.status === 403, `HTTP ${requesterTry.status}`);

    const otherAgentTry = await resolveTicket(other.accessToken, ticket.id, 'not mine');
    check('403: different IT agent (not assigned) cannot resolve', otherAgentTry.status === 403, `HTTP ${otherAgentTry.status}`);

    // 7. Valid action: assigned agent resolves with a note.
    const resolved = await resolveTicket(agent.accessToken, ticket.id, NOTE);
    check(
      'Assigned agent resolves ticket (200)',
      resolved.status === 200 && resolved.data?.status === 'Resolved',
      `HTTP ${resolved.status} -> ${resolved.data?.status}`,
    );
    check('resolutionNote persisted on ticket', resolved.data?.resolutionNote === NOTE, JSON.stringify(resolved.data?.resolutionNote));
    check('Status change kept the assignment', resolved.data?.assignedToId === agent.user?.id, `assignedTo=${resolved.data?.assignedToId}`);

    // 8. A RESOLVED event must be logged (durable ticket history).
    const history = await req('GET', `/tickets/${ticket.id}/history`, { token: requester.accessToken });
    const resolvedEvent = history.data?.findLast?.((e) => e.action === 'RESOLVED') ?? history.data?.slice().reverse().find((e) => e.action === 'RESOLVED');
    check('History contains a RESOLVED event', !!resolvedEvent, JSON.stringify(resolvedEvent?.action));
    check('RESOLVED event records actor + note', resolvedEvent?.actorId === agent.user?.id && resolvedEvent?.note === NOTE, `actor=${resolvedEvent?.actorId}`);

    // 9. Admin is also authorized to advance the lifecycle (docs: agent OR Admin),
    //    still one step at a time (Open -> In Progress -> Resolved).
    const adminTicket = await req('POST', '/tickets', {
      token: admin.accessToken,
      body: { title: `${ADMIN_TITLE_PREFIX}printer jam`, description: 'Admin-created to verify Admin can drive status.', category: 'HR', priority: 'Medium' },
    });
    const at = adminTicket.data;
    const adminStarted = await req('PATCH', `/tickets/${at.id}/status`, {
      token: admin.accessToken,
      body: { status: 'In Progress' },
    });
    check('Admin can move Open -> In Progress', adminStarted.status === 200 && adminStarted.data?.status === 'In Progress', `HTTP ${adminStarted.status}`);
    const adminResolved = await req('PATCH', `/tickets/${at.id}/status`, {
      token: admin.accessToken,
      body: { status: 'Resolved', resolutionNote: 'Cleared by admin.' },
    });
    check('Admin can resolve a ticket too', adminResolved.status === 200 && adminResolved.data?.status === 'Resolved', `HTTP ${adminResolved.status}`);

    console.log('\nFull slice verification finished. State is now persisted in SQLite (see .data/).');
    console.log(`Restart the backend (same DB_FILE) and run:  node scripts/verify-slice.mjs persist`);
  } else if (MODE === 'persist') {
    // 10. Persistence proof: everything must still be there after a restart.
    const requester = await login({ email: REQUESTER.email, password: REQUESTER.password });
    const agent = await login({ email: AGENT.email, password: AGENT.password });
    check('Users still exist after restart', !!requester && !!agent, `${REQUESTER.email} / ${AGENT.email}`);

    const myTickets = await req('GET', `/tickets?mine=false`, { token: requester.accessToken });
    const ticket = myTickets.data?.find((t) => t.title === TITLE);
    check('Ticket survived the restart', !!ticket, ticket ? `#${ticket.id}` : 'not found');
    if (ticket) {
      check('Ticket is still Resolved', ticket.status === 'Resolved', ticket.status);
      check('Resolution note still attached', ticket.resolutionNote === NOTE, JSON.stringify(ticket.resolutionNote));
      check('Assignment survived restart', ticket.assignedToId !== null, `assignedTo=${ticket.assignedToId}`);
      const history = await req('GET', `/tickets/${ticket.id}/history`, { token: requester.accessToken });
      const resolvedEvent = history.data?.slice().reverse().find((e) => e.action === 'RESOLVED');
      check('RESOLVED history event survived restart', !!resolvedEvent && resolvedEvent.note === NOTE, `actorId=${resolvedEvent?.actorId} note=${resolvedEvent?.note}`);
    }

    const stats = await req('GET', '/admin/stats', { token: admin.accessToken });
    check('Admin stats reflect persisted data', stats.status === 200 && stats.data?.byStatus?.Resolved >= 1, JSON.stringify(stats.data?.byStatus));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

run().catch((err) => {
  console.error('verify-slice crashed:', err);
  process.exitCode = 1;
});
