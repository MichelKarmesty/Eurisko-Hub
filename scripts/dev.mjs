#!/usr/bin/env node
/**
 * Eurisko Hub — run the whole app with one command.
 *
 *   node scripts/dev.mjs
 *
 * It starts the API (backend, :3000) and the web client (frontend, :5173),
 * prefixes each one's output so you can tell them apart, and stops both when
 * you press Ctrl+C — instead of you babysitting two terminals.
 *
 * It also removes the things that make a clean checkout awkward:
 *
 *   1. both folders' dependencies are installed first if they are missing or
 *      stale, so a fresh `git clone` needs no separate install step (scripts/lib/deps.mjs);
 *   2. the backend is compiled first when `dist/` is missing or older than
 *      `src/` (`npm start` runs the compiled server; `npm run build` alone
 *      never starts anything);
 *   3. the frontend is told which API to proxy to, so moving the API is
 *      `PORT=3001 node scripts/dev.mjs` and nothing else has to change.
 *
 * Options (all optional, as env vars):
 *   PORT=3001        API port          (default 3000)
 *   WEB_PORT=5174    web client port   (default 5173)
 *   SKIP_BUILD=1     never compile the backend, even if it looks stale
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, ensureDependenciesFor } from './lib/deps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const API_PORT = Number(process.env.PORT ?? 3000);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is the port free to bind? (Used only to fail with a useful message.) */
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitForHttp(url, ok, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (ok(res.status)) return true;
    } catch {
      // not listening yet
    }
    await sleep(300);
  }
  return false;
}

/**
 * Kill the whole process tree, not just the direct child: on POSIX `npm run dev`
 * leaves a Vite grandchild behind, and an orphaned Vite holds the port (which is
 * what makes the next start look like "port already in use").
 */
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!isWindows && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to a direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/** Newest mtime under a directory, so we can tell a stale build from a fresh one. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

function buildIfStale() {
  const distMain = path.join(BACKEND, 'dist', 'main.js');
  const reason = !existsSync(distMain)
    ? 'dist/ is missing'
    : newestMtime(path.join(BACKEND, 'src')) > statSync(distMain).mtimeMs
      ? 'src/ is newer than dist/'
      : null;

  if (process.env.SKIP_BUILD === '1') {
    console.log('[dev] SKIP_BUILD=1 — not compiling the backend.');
    return true;
  }
  if (!reason) {
    console.log('[dev] backend build is up to date.');
    return true;
  }

  console.log(`[dev] compiling the backend (${reason})…`);
  const build = spawnSync(npm, ['run', 'build'], {
    cwd: BACKEND,
    stdio: 'inherit',
    shell: isWindows,
  });
  return build.status === 0;
}

function banner(apiBase, appUrl) {
  console.log(
    [
      '',
      '─'.repeat(64),
      `  API   ${apiBase}`,
      `  Web   ${appUrl}`,
      '',
      '  Sign in as the Admin:  admin@eurisko.com / Admin123!',
      '  Then create the accounts you want under  👥 Users  (no public signup).',
      '',
      '  Ctrl+C stops both.',
      '─'.repeat(64),
      '',
    ].join('\n'),
  );
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

async function main() {
  // Before anything else: can this Node run the project at all?
  assertNodeVersion();

  if (!(await portIsFree(API_PORT))) {
    throw new Error(
      `port ${API_PORT} is already in use — free it, or run: PORT=${API_PORT + 1} node scripts/dev.mjs`,
    );
  }
  if (!(await portIsFree(WEB_PORT))) {
    throw new Error(
      `port ${WEB_PORT} is already in use — free it, or run: WEB_PORT=${WEB_PORT + 1} node scripts/dev.mjs`,
    );
  }

  // A clean clone has no node_modules; this is what makes one command enough.
  // It is a no-op on every later run (the install stamp is newer than the manifests).
  ensureDependenciesFor([BACKEND, FRONTEND]);

  if (!buildIfStale()) throw new Error('the backend build failed — fix the errors above and retry');

  // The app creates the folder too; doing it here keeps `mkdir` out of the
  // instructions entirely, and costs nothing.
  mkdirSync(path.join(BACKEND, '.data'), { recursive: true });

  // With no backend/.env there is no DB_FILE, and the app would quietly keep the
  // database in memory. Give the one-command path a persistent file instead, but
  // never override a DB_FILE the developer set deliberately.
  const envFile = path.join(BACKEND, '.env');
  const apiEnv = { ...process.env, PORT: String(API_PORT) };
  if (!apiEnv.DB_FILE && !existsSync(envFile)) {
    apiEnv.DB_FILE = path.join(BACKEND, '.data', 'hub.sqlite');
    console.log(`[dev] no backend/.env — using a persistent database at ${path.relative(ROOT, apiEnv.DB_FILE)}.`);
  }

  const apiBase = `http://127.0.0.1:${API_PORT}`;
  const appUrl = `http://127.0.0.1:${WEB_PORT}`;

  console.log(`[dev] starting the API on ${apiBase}…`);
  const api = spawn(process.execPath, [path.join(BACKEND, 'dist', 'main.js')], {
    cwd: BACKEND,
    env: apiEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
  });
  children.push(api);
  api.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  api.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  api.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] the API exited (code ${code ?? 'signal'}).`);
      shutdown(code ?? 1);
    }
  });

  // /auth/me is behind the auth guard, so 401 means "up and serving".
  if (!(await waitForHttp(`${apiBase}/auth/me`, (s) => s === 401 || s === 200, 30_000))) {
    throw new Error(`the API did not become ready at ${apiBase}`);
  }

  console.log(`[dev] starting the web client on ${appUrl}…`);
  const web = spawn(
    npm,
    ['run', 'dev', '--', '--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: FRONTEND,
      env: { ...process.env, API_PROXY_TARGET: apiBase },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      detached: !isWindows,
    },
  );
  children.push(web);
  web.stdout.on('data', (d) => process.stdout.write(`[web] ${d}`));
  web.stderr.on('data', (d) => process.stderr.write(`[web] ${d}`));
  web.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] the web client exited (code ${code ?? 'signal'}).`);
      shutdown(code ?? 1);
    }
  });

  if (!(await waitForHttp(appUrl, (s) => s === 200, 45_000))) {
    throw new Error(`the web client did not become ready at ${appUrl}`);
  }

  banner(apiBase, appUrl);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(`\n[dev] ${err instanceof Error ? err.message : String(err)}\n`);
  shutdown(1);
});
