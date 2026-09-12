#!/usr/bin/env node
/**
 * Eurisko Hub — run the whole automated confidence suite with one command.
 *
 *   node scripts/run-tests.mjs
 *
 * What it does:
 *   1. builds the NestJS backend;
 *   2. runs the backend Jest suites (business rule, backend<->database
 *      integration, HTTP contract/authorization/regression);
 *   3. starts an isolated backend on a free port with a throwaway SQLite file;
 *   4. runs scripts/verify-slice.mjs (live HTTP definition-of-done checks);
 *   5. runs the DOM-level UI E2E (real React app -> live API -> SQLite);
 *   6. tears everything down and deletes the throwaway database.
 *
 * Options (env vars):
 *   TEST_PORT=3100     force the API port (default: a free port)
 *   SKIP_BACKEND_TESTS=1   skip step 2
 *   SKIP_E2E=1             skip step 5
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const E2E = path.join(ROOT, 'e2e');
const DB_FILE = path.join(BACKEND, '.data', `test-run-${process.pid}.sqlite`);

const isWindows = process.platform === 'win32';
const failures = [];

function banner(text) {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}

function run(label, command, args, cwd, extraEnv = {}) {
  banner(label);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    failures.push(label);
    console.error(`\n[run-tests] FAILED: ${label} (exit ${result.status ?? 'signal'})`);
  }
  return result.status === 0;
}

function freePort() {
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

async function waitForApi(base) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/auth/me`);
      if (res.status === 401 || res.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  const port = process.env.TEST_PORT ? Number(process.env.TEST_PORT) : await freePort();
  const base = `http://127.0.0.1:${port}`;
  let api = null;

  try {
    // 1. Build the backend so `dist/main.js` exists for the live checks.
    if (!run('Build backend', isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], BACKEND)) {
      throw new Error('backend build failed');
    }

    // 2. Backend Jest suites (self-contained; no server or disk DB needed).
    if (process.env.SKIP_BACKEND_TESTS !== '1') {
      run('Backend tests (business rule + DB integration + HTTP contract)', isWindows ? 'npm.cmd' : 'npm', ['test'], BACKEND);
    } else {
      banner('Backend tests — SKIPPED (SKIP_BACKEND_TESTS=1)');
    }

    // 3. Start an isolated backend for the live HTTP/UI checks.
    rmSync(DB_FILE, { force: true });
    banner(`Start isolated backend on ${base} (DB: ${path.relative(ROOT, DB_FILE)})`);
    api = spawn(process.execPath, [path.join(BACKEND, 'dist', 'main.js')], {
      cwd: BACKEND,
      env: { ...process.env, DB_FILE, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
    api.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));

    if (!(await waitForApi(base))) {
      throw new Error(`isolated backend did not become ready at ${base}`);
    }

    // 4. Live HTTP definition-of-done checks (provisions demo personas).
    run('Live API checks (verify-slice full)', process.execPath, [path.join(ROOT, 'scripts', 'verify-slice.mjs'), 'full'], ROOT, {
      BASE_URL: base,
    });

    // 5. DOM-level UI E2E: real React components -> live API -> SQLite.
    if (process.env.SKIP_E2E !== '1') {
      run('UI E2E (React -> API -> SQLite)', isWindows ? 'npx.cmd' : 'npx', ['vitest', 'run'], E2E, {
        API_URL: base,
      });
    } else {
      banner('UI E2E — SKIPPED (SKIP_E2E=1)');
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    console.error(`\n[run-tests] ${err instanceof Error ? err.message : err}`);
  } finally {
    if (api) {
      api.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      try {
        api.kill('SIGKILL'); // no-op if it already exited
      } catch {
        // already gone
      }
    }
    for (const suffix of ['', '-journal', '.before']) rmSync(`${DB_FILE}${suffix}`, { force: true });
  }

  banner(failures.length === 0 ? 'ALL TESTS PASSED' : `FAILURES (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main();
