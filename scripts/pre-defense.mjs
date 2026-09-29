#!/usr/bin/env node
/**
 * Eurisko Hub - pre-defense automated checklist.
 *
 *   node scripts/pre-defense.mjs
 *
 * Run this ~30 minutes before the defense. It validates the whole "have ready"
 * list from the slides in one pass and prints a single READY / NOT READY frame:
 *
 *   1. the git working tree is clean;
 *   2. HEAD matches the SHA you submitted (when SUBMITTED_SHA is provided);
 *   3. `npm test` (the backend vitest suites) passes;
 *   4. `scripts/final-smoke.mjs` reports 20/20 - against your running API when
 *      one answers, otherwise against an isolated backend this script starts
 *      and stops on a throwaway database;
 *   5. LIVE_URL is reachable, when provided;
 *   6. no real secrets are committed (high-entropy API-key patterns, with
 *      documented placeholders and dev defaults allowed);
 *   7. `.gitignore` covers node_modules, the database, .env and dist;
 *   8. all 11 ADRs are present;
 *   9. README.md exists and is larger than 5 KB;
 *  10. the backend builds clean.
 *
 * Options:
 *   --help          Show help and exit 0.
 *   --sha <sha>     The submitted commit SHA to compare against HEAD.
 *   --live <url>    The deployed app URL to reachability-check.
 *   --api <url>     The API to smoke-test (default: a running localhost:3000, else isolated).
 *   --skip-tests    Skip the (slow) test run.
 *   --skip-smoke    Skip the smoke test.
 *
 * Environment: SUBMITTED_SHA, LIVE_URL, API_BASE, PORT, NO_COLOR.
 *
 * Exit codes: 0 = ready (every check passed), 1 = at least one failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  BACKEND,
  Box,
  brief,
  color,
  fileSize,
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
    name: 'pre-defense.mjs - automated pre-defense checklist',
    summary:
      'Validates git state, SHA, tests, the live smoke test, the deployed URL, secret hygiene, .gitignore, ADRs, README and the backend build, then prints READY or NOT READY.',
    usage: 'node scripts/pre-defense.mjs [--sha <submitted-sha>] [--live <url>] [--api <url>] [--skip-tests] [--skip-smoke]',
    details: [
      '  --sha <sha>     Submitted commit SHA (else SUBMITTED_SHA).',
      '  --live <url>    Deployed app URL to check (else LIVE_URL).',
      '  --api <url>     API to smoke-test (else API_BASE, else localhost:3000, else isolated).',
      '  --skip-tests    Skip npm test.',
      '  --skip-smoke    Skip the final smoke test.',
      '',
      'Exit codes: 0 = ready for defense, 1 = at least one failure.',
    ],
  })
) {
  process.exit(0);
}

const SUBMITTED_SHA = (PARSED.get('sha') || process.env.SUBMITTED_SHA || '').trim();
const LIVE_URL = (PARSED.get('live') || process.env.LIVE_URL || '').trim().replace(/\/+$/, '');
const EXPLICIT_API = (PARSED.get('api') || process.env.API_BASE || '').trim().replace(/\/+$/, '');
const LOCAL_API = `http://127.0.0.1:${Number(process.env.PORT ?? 3000)}`;

const results = [];
/** Record + print one check. `ok: null` renders as a warning, not a failure. */
function record(label, ok, detail, { warnOnly = false } = {}) {
  const state = ok === null || warnOnly ? 'warn' : ok ? 'pass' : 'fail';
  results.push({ label, state, detail });
  const icon = state === 'pass' ? color.green('✅') : state === 'warn' ? color.yellow('⚠️ ') : color.red('❌');
  process.stdout.write(`  ${icon}  ${label}${detail ? `  ${color.dim(`— ${detail}`)}` : ''}\n`);
  return state !== 'fail';
}

function run(command, args, { cwd = ROOT, timeout = 0, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: timeout || undefined,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

const git = (...args) => run('git', args);
const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '');

/** ISO 8601 with the machine's local offset, e.g. 2026-09-29T22:00:00+03:00. */
function localIso(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

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

/** Cached `npm run build` result, shared by the build check and the smoke test. */
let buildCache = null;
function ensureBuild() {
  if (buildCache !== null) return buildCache;
  const result = run('npm', ['run', 'build'], { cwd: BACKEND, timeout: 5 * 60 * 1000 });
  const firstError =
    (result.stderr || result.stdout)
      .split(/\r?\n/)
      .find((line) => /error TS\d+/.test(line)) ?? '';
  buildCache = { ok: result.ok, status: result.status, firstError };
  return buildCache;
}

process.stdout.write(`\n${color.bold('Eurisko Hub — pre-defense checklist')}\n\n`);

// ── 1. Working tree clean ───────────────────────────────────────────────────
{
  const status = git('status', '--porcelain');
  const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
  record(
    'Git working tree clean',
    status.ok && dirty.length === 0,
    dirty.length === 0 ? 'no uncommitted changes' : `${dirty.length} changed path(s): ${dirty.slice(0, 4).join(', ')}${dirty.length > 4 ? '…' : ''}`,
  );
}

// ── 2. Submitted SHA matches HEAD ───────────────────────────────────────────
{
  const head = git('rev-parse', 'HEAD').stdout.trim();
  if (!SUBMITTED_SHA) {
    record('SHA matches submission', null, `HEAD is ${head.slice(0, 7)} — set SUBMITTED_SHA (or --sha) to compare`);
  } else {
    const matches = head === SUBMITTED_SHA || head.startsWith(SUBMITTED_SHA) || SUBMITTED_SHA.startsWith(head);
    record('SHA matches submission', matches, matches ? head.slice(0, 7) : `HEAD ${head.slice(0, 7)} ≠ submitted ${SUBMITTED_SHA.slice(0, 7)}`);
  }
}

// ── 3. Tests ────────────────────────────────────────────────────────────────
if (PARSED.has('skip-tests')) {
  record('All tests pass', null, 'skipped (--skip-tests)');
} else {
  process.stdout.write(`  ${color.dim('running npm test (backend vitest suites) …')}\n`);
  const result = run('npm', ['test'], { cwd: BACKEND, timeout: 15 * 60 * 1000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const filesPassed = /Test Files\s+(\d+)\s+passed/.exec(output)?.[1] ?? '?';
  const filesFailed = /Test Files\s+.*?(\d+)\s+failed/.exec(output)?.[1] ?? '0';
  const testsPassed = /Tests\s+(\d+)\s+passed/.exec(output)?.[1] ?? '?';
  const testsFailed = /Tests\s+.*?(\d+)\s+failed/.exec(output)?.[1] ?? '0';
  record(
    'All tests pass',
    result.ok && filesFailed === '0' && testsFailed === '0',
    `${filesPassed} suites, ${testsFailed} failures · ${testsPassed} tests passed`,
  );
}

// ── 4. Final smoke test (against the running API, or an isolated one) ───────
let isolated = null;
if (PARSED.has('skip-smoke')) {
  record('Final smoke test', null, 'skipped (--skip-smoke)');
} else {
  let apiBase = EXPLICIT_API;
  if (!apiBase) {
    const probe = await request(LOCAL_API, '/health', { timeoutMs: 1500 });
    const probeRoot = probe.status === 200 ? probe : await request(LOCAL_API, '/', { timeoutMs: 1500 });
    if (probeRoot.status === 200) {
      apiBase = LOCAL_API;
      process.stdout.write(`  ${color.dim(`found a running API at ${LOCAL_API}`)}\n`);
    }
  }

  if (!apiBase) {
    const built = ensureBuild();
    if (!built.ok) {
      record('Final smoke test', false, 'cannot run: the backend does not build');
    } else {
      const port = await freePort();
      apiBase = `http://127.0.0.1:${port}`;
      const dataDir = path.join(ROOT, 'artifacts', 'pre-defense-work');
      mkdirSync(dataDir, { recursive: true });
      const dbFile = path.join(dataDir, `pre-defense-${Date.now()}.sqlite`);
      isolated = spawn(process.execPath, ['dist/main.js'], {
        cwd: BACKEND,
        env: { ...process.env, PORT: String(port), DB_FILE: dbFile, JWT_SECRET: 'pre-defense-check-secret' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      isolated.stdout.resume();
      isolated.stderr.resume();
      const ready = await waitForApi(apiBase, { timeoutMs: 25000 });
      if (!ready.route) {
        record('Final smoke test', false, 'could not start an isolated backend for the smoke test');
        isolated.kill('SIGTERM');
        isolated = null;
        rmSync(dbFile, { force: true });
      } else {
        process.stdout.write(`  ${color.dim(`no running API found — started an isolated one at ${apiBase}`)}\n`);
      }
    }
  }

  if (apiBase) {
    const smoke = run(process.execPath, [path.join(ROOT, 'scripts', 'final-smoke.mjs')], {
      env: { API_BASE: apiBase, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? '', NO_COLOR: '1' },
      timeout: 10 * 60 * 1000,
    });
    const output = stripAnsi(`${smoke.stdout}${smoke.stderr}`);
    const match = /Result:\s*(\d+)\/(\d+)\s+passed/.exec(output);
    const passed = match?.[1] ?? '0';
    const total = match?.[2] ?? '20';
    record('Final smoke test', smoke.ok && passed === total, `${passed}/${total} checks passed (${apiBase})`);
  }
}

// ── 5. Live app reachable ───────────────────────────────────────────────────
if (!LIVE_URL) {
  record('Live app reachable', null, 'LIVE_URL not set (or --live <url>) — remember to check it before the defense');
} else {
  const health = await request(LIVE_URL, '/health', { timeoutMs: 10000 });
  const response = health.status === 200 ? health : await request(LIVE_URL, '/', { timeoutMs: 10000 });
  const ok = response.status === 200;
  record('Live app reachable', ok, ok ? `${LIVE_URL} → HTTP 200 (${response.ms.toFixed(0)}ms)` : `${LIVE_URL} → ${response.status === 0 ? `unreachable (${response.error})` : `HTTP ${response.status}`}`);
}

// ── 6. No secrets in committed files ────────────────────────────────────────
{
  const SECRET_PATTERNS = [
    ['Groq API key', /\bgsk_[A-Za-z0-9]{20,}\b/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ['Resend key', /\bre_[A-Za-z0-9]{20,}\b/],
    ['assigned AI key', /AI_(?:FALLBACK_)?API_KEY\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/],
    // A quoted literal SMTP password with a digit. Requiring a quote and a digit
    // keeps `process.env.SMTP_PASS = 'app-password'` and `SMTP_PASS: first.appPassword`
    // (identifiers and documented fixtures) out of the results - a false alarm
    // here would train me to ignore the check.
    ['assigned SMTP password', /SMTP(?:_ALT)?_PASS\s*[:=]\s*["'][A-Za-z0-9._-]*\d[A-Za-z0-9._-]{11,}["']/],
  ];
  const ALLOWED = /(change[_-]?me|placeholder|your[_-]|example|dummy|app-password|backup-app-password|xxxx|<[^>]+>|\$\{|\bnot[_-]?(?:a[_-]?)?real)/i;
  const BINARY = /\.(png|jpe?g|gif|webp|ico|zip|docx|xlsx|pdf|sqlite|woff2?|ttf)$/i;
  // Files whose whole purpose is to hold placeholders or fixture credentials.
  const FIXTURE = /(\.example$|\.spec\.ts$|\/setup-mail\.mjs$|\/mail-smtp\.spec\.ts$)/i;

  const files = git('ls-files').stdout.split(/\r?\n/).filter(Boolean);
  const findings = [];
  for (const file of files) {
    if (BINARY.test(file)) continue;
    let text;
    try {
      text = readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const [name, pattern] of SECRET_PATTERNS) {
      if (FIXTURE.test(file) && name === 'assigned SMTP password') continue;
      const match = pattern.exec(text);
      if (match && !ALLOWED.test(match[0])) {
        findings.push(`${file}: ${name}`);
      }
    }
  }
  record('No secrets in committed code', findings.length === 0, findings.length === 0 ? `${files.length} tracked files scanned` : findings.slice(0, 3).join(' · '));
}

// ── 7. .gitignore covers sensitive paths ────────────────────────────────────
{
  const gitignorePath = path.join(ROOT, '.gitignore');
  const text = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const checks = [
    ['node_modules', /(^|\n)\s*node_modules\/?/],
    ['database/.data', /\.data|\*\.sqlite|\*\.db\b/],
    ['.env', /(^|\n)\s*\**\.env/],
    ['dist', /(^|\n)\s*(?:frontend\/)?dist\//],
  ];
  const missing = checks.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  record('.gitignore covers all sensitive paths', missing.length === 0, missing.length === 0 ? 'node_modules, .data, .env, dist all ignored' : `missing: ${missing.join(', ')}`);
}

// ── 8. ADRs present ─────────────────────────────────────────────────────────
{
  const dir = path.join(ROOT, 'docs', 'decisions');
  const present = existsSync(dir) ? readdirSync(dir).filter((f) => /^ADR-\d+\.md$/i.test(f)) : [];
  const missing = [];
  for (let i = 1; i <= 11; i += 1) {
    if (!present.some((f) => new RegExp(`^ADR-0*${i}\\.md$`, 'i').test(f))) missing.push(`ADR-${String(i).padStart(3, '0')}`);
  }
  record('All 11 ADRs present', missing.length === 0, missing.length === 0 ? `${present.length} ADR files in docs/decisions/` : `missing ${missing.join(', ')}`);
}

// ── 9. README exists and is > 5 KB ──────────────────────────────────────────
{
  const bytes = fileSize(path.join(ROOT, 'README.md'));
  const ok = bytes !== null && bytes > 5 * 1024;
  record('README exists', ok, bytes === null ? 'README.md not found' : `${(bytes / 1024).toFixed(0)} KB`);
}

// ── 10. Backend builds clean ────────────────────────────────────────────────
{
  const built = ensureBuild();
  record('Backend builds clean', built.ok, built.ok ? 'tsc completed with no errors' : `build failed (exit ${built.status})${built.firstError ? `: ${brief(built.firstError, 90)}` : ''}`);
}

// ── Cleanup + frame ─────────────────────────────────────────────────────────
if (isolated) {
  isolated.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      isolated.kill('SIGKILL');
      resolve();
    }, 3000);
    isolated.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const failures = results.filter((r) => r.state === 'fail');
const ready = failures.length === 0;
const box = new Box('PRE-DEFENSE CHECKLIST', { minWidth: 62 });
for (const result of results) {
  const icon = result.state === 'pass' ? '✅' : result.state === 'warn' ? '⚠️ ' : '❌';
  box.row(`${icon}  ${result.label}${result.detail ? color.dim(` — ${result.detail}`) : ''}`);
}
box.separator();
box.row(ready ? color.green(color.bold('✅ READY FOR DEFENSE')) : color.red(color.bold(`❌ NOT READY — ${failures.length} check(s) failed`)));
box.row(`Time: ${localIso()}`);
process.stdout.write('\n');
box.print();

if (!ready) {
  process.stdout.write(`\n${color.red(color.bold('Fix these before submitting:'))}\n`);
  for (const failure of failures) process.stdout.write(`  ${color.red('✗')} ${failure.label}: ${failure.detail}\n`);
}

process.exit(ready ? 0 : 1);
