#!/usr/bin/env node
/**
 * Eurisko Hub - live health & logs monitor (run this during the defense).
 *
 *   node scripts/defense-health-check.mjs
 *
 * Leave it in a visible terminal next to the demo: every 10 seconds it proves,
 * on screen, that the API is answering, how fast, that the SQLite file is still
 * growing, how long the process has been up, and - when a request log is
 * available - what the server just handled. It is the "the app is alive" pane of
 * the operations story, and it keeps the running count itself, so the audience
 * sees `Checks: 47 passed, 0 failed` rather than a claim.
 *
 * It never mutates anything: one read-only `GET /health` per tick (falling back
 * to `GET /`). Ctrl+C stops it cleanly and prints the final tally.
 *
 * Options:
 *   --once              Print exactly one snapshot and exit (0 = healthy).
 *   --interval <sec>    Seconds between checks (default 10).
 *   --api <url>         API base URL (default API_BASE or http://127.0.0.1:3000).
 *   --help
 *
 * Environment:
 *   API_BASE, PORT      API location.
 *   DB_FILE             Database file to size (default backend/.env, then backend/.data/hub.sqlite).
 *   LOG_FILE            A server log to tail for the last requests.
 *   NO_COLOR            Disable ANSI colour.
 *
 * Exit codes: 0 = last check healthy (or --once healthy); 1 = the API was not
 * answering.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BACKEND,
  color,
  fileSize,
  formatBytes,
  helpRequested,
  humanDuration,
  isoNow,
  parseArgs,
  request,
  resolveApiBase,
  resolveDbFile,
  ROOT,
  stripAnsi,
  waitForApi,
} from './lib/defense-ui.mjs';

const PARSED = parseArgs();
if (
  helpRequested(PARSED, {
    name: 'defense-health-check.mjs - live API health monitor',
    summary:
      'Pings the API every 10s and shows response time, database file size, uptime and the last requests, with a running pass/fail count.',
    usage: 'node scripts/defense-health-check.mjs [--once] [--interval 10] [--api http://host:port]',
    details: [
      '  --once            One snapshot, then exit (0 healthy / 1 unreachable).',
      '  --interval <sec>  Seconds between snapshots (default 10).',
      '  --api <url>       API base URL.',
      '',
      'Environment: API_BASE, PORT, DB_FILE, LOG_FILE, NO_COLOR.',
    ],
  })
) {
  process.exit(0);
}

const API = (PARSED.get('api') || resolveApiBase(3000)).replace(/\/+$/, '');
const INTERVAL_MS = Math.max(1, Number(PARSED.get('interval', 10)) || 10) * 1000;
const ONCE = PARSED.has('once');
const DB_FILE = resolveDbFile();
const LOG_FILE =
  process.env.LOG_FILE ||
  [path.join(ROOT, 'artifacts', 'api.log'), path.join(BACKEND, '.data', 'api.log'), path.join(BACKEND, 'api.log')].find(
    (candidate) => existsSync(candidate),
  ) ||
  null;

const RULE_WIDTH = 58;
const startedAt = Date.now();
let passed = 0;
let failed = 0;
let lastHealthy = false;

const rule = (label) => {
  const text = `─── ${label} `;
  return color.cyan(text + '─'.repeat(Math.max(0, RULE_WIDTH - stripAnsi(text).length)));
};

/** `19:30:05` in the operator's local time - matches the slide format. */
const clock = (date = new Date()) =>
  [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');

/**
 * Read the last few request lines out of a server log, if one is configured.
 * NestJS does not log requests by default, so this is best-effort and clearly
 * labelled when it has nothing to show - it never fabricates traffic.
 */
function lastRequests(count = 5) {
  if (!LOG_FILE) return null;
  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines = content
      .split(/\r?\n/)
      .filter((line) =>
        /(?:^|\s)(?:GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\s+\//.test(line) || /HTTP\/1\.[01]" /.test(line),
      )
      .slice(-count);
    return lines.length > 0 ? lines : [];
  } catch {
    return null;
  }
}

async function snapshot() {
  const check = await request(API, '/health', { timeoutMs: 5000 });
  let route = '/health';
  let response = check;
  if (check.status !== 200) {
    // A build without /health still proves liveness through the root route.
    response = await request(API, '/', { timeoutMs: 5000 });
    route = '/';
  }
  const healthy = response.status === 200;
  if (healthy) passed += 1;
  else failed += 1;
  lastHealthy = healthy;

  // `GET /health` carries the ops block (db + request counters + last requests),
  // so prefer it; fall back to sizing the file and parsing a log ourselves so
  // the monitor still works against a build without the ops payload.
  const dbInfo = check.data?.db ?? null;
  const dbBytes = dbInfo && typeof dbInfo.sizeBytes === 'number' ? dbInfo.sizeBytes : fileSize(DB_FILE);
  const dbMissing = dbInfo ? dbInfo.exists === false || dbInfo.mode === 'memory' : dbBytes === null;
  const dbLabel = path.relative(ROOT, dbInfo?.file || DB_FILE);
  const uptimeSeconds =
    typeof check.data?.uptimeSeconds === 'number'
      ? check.data.uptimeSeconds
      : Math.floor((Date.now() - startedAt) / 1000);
  const database = check.data?.database;

  const statusText = healthy
    ? `${color.green('✅ 200 OK')} ${color.dim(`(${response.ms.toFixed(0)}ms)`)}`
    : response.status === 0
      ? color.red(`❌ unreachable — ${response.error ?? 'no response'}`)
      : color.red(`❌ HTTP ${response.status} ${color.dim(`(${response.ms.toFixed(0)}ms)`)}`);

  const dbText = dbMissing
    ? color.yellow(`${dbLabel} (${dbInfo?.mode === 'memory' ? 'in-memory database' : 'not found'})`)
    : `${color.dim(dbLabel)} ${color.bold(`(${formatBytes(dbBytes)})`)}`;

  process.stdout.write(`\n${rule(`Health Check @ ${clock()}`)}\n`);
  process.stdout.write(`  API:        ${statusText}\n`);
  process.stdout.write(`  Route:      ${color.dim(`GET ${route}`)}${healthy && database ? color.dim(`  ·  database ${database}`) : ''}\n`);
  process.stdout.write(`  DB file:    ${dbText}\n`);
  process.stdout.write(`  Uptime:     ${humanDuration(uptimeSeconds)}\n`);
  process.stdout.write(
    `  Checks:     ${color.green(`${passed} passed`)}, ${failed > 0 ? color.red(`${failed} failed`) : '0 failed'}\n`,
  );

  // Prefer the server's own ring buffer (real traffic, no log configuration);
  // fall back to tailing a file only when the payload has no requests block.
  const serverRequests = Array.isArray(check.data?.requests?.last5) ? check.data.requests.last5 : null;
  const logged = serverRequests === null ? lastRequests(5) : null;
  if (serverRequests !== null) {
    const total = check.data?.requests?.total ?? serverRequests.length;
    if (serverRequests.length === 0) {
      process.stdout.write(`  Requests:   ${color.dim(`0 served since boot (${check.data?.uptime ?? 'just started'})`)}\n`);
    } else {
      process.stdout.write(`  Requests:   ${color.dim(`${total} served · last ${serverRequests.length}:`)}\n`);
      for (const entry of serverRequests) {
        const code = entry.status >= 400 ? color.yellow(entry.status) : color.green(entry.status);
        process.stdout.write(`    ${color.dim(`${entry.method} ${entry.path}`)} ${code} ${color.dim(`${entry.ms}ms`)}\n`);
      }
    }
  } else if (logged === null) {
    process.stdout.write(`  Log:        ${color.dim('no request log — set LOG_FILE=... to include one')}\n`);
  } else if (logged.length === 0) {
    process.stdout.write(`  Log:        ${color.dim(`${path.relative(ROOT, LOG_FILE)} — no request lines yet`)}\n`);
  } else {
    process.stdout.write(`  ${color.dim(`Last ${logged.length} request(s):`)}\n`);
    for (const line of logged) {
      process.stdout.write(`    ${color.dim(line.trim().slice(0, 96))}\n`);
    }
  }
  process.stdout.write(`${color.cyan('─'.repeat(RULE_WIDTH))}\n`);

  return healthy;
}

function shutdown() {
  process.stdout.write(`\n${color.bold('Health monitor stopped')}  ${color.dim(isoNow())}\n`);
  process.stdout.write(
    `  ${failed === 0 ? color.green('✅') : color.red('❌')} Checks: ${passed} passed, ${failed} failed\n\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

process.stdout.write(
  `${color.bold('Eurisko Hub — live health monitor')}\n` +
    `  API:      ${API}\n` +
    `  DB file:  ${path.relative(ROOT, DB_FILE)} ${color.dim('(fallback; the server-reported path is shown below)')}\n` +
    `  Interval: ${INTERVAL_MS / 1000}s${ONCE ? ' (single snapshot)' : ''}\n` +
    `  ${color.dim('Ctrl+C to stop and print the final tally.')}\n`,
);

if (ONCE) {
  const healthy = await snapshot();
  process.exit(healthy ? 0 : 1);
}

// Wait for the API to come up once (useful when this is started together with
// `npm run dev`), then report steadily. A slow first boot is not a failure.
const ready = await waitForApi(API, { timeoutMs: 30000 });
if (!ready.route) {
  process.stdout.write(
    `\n${color.yellow('⚠️ ')} ${API} did not answer within 30s — reporting every ${INTERVAL_MS / 1000}s anyway.\n`,
  );
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await snapshot();
if (!ONCE) {
  // `setInterval` keeps the process alive between checks without a busy loop.
  setInterval(() => {
    snapshot().catch((err) => {
      failed += 1;
      process.stdout.write(`  ${color.red('❌')} health check crashed: ${err instanceof Error ? err.message : err}\n`);
    });
  }, INTERVAL_MS);
}
