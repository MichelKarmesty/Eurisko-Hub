#!/usr/bin/env node
/**
 * Self-contained real-browser E2E for the Service Request slice.
 *
 *   node scripts/run-browser-e2e.mjs
 *
 * No manual setup: it starts an isolated backend (fresh SQLite file, auto-seeded
 * demo accounts), starts the Vite dev server pointed at that backend, makes sure
 * a Chromium can actually launch (CHROME_PATH, a repo-local binary, or
 * `npx playwright install chromium`), drives the real UI with Playwright, then
 * tears everything down.
 *
 * If no browser can launch (e.g. the sandbox lacks Chromium's system libraries)
 * it SKIPS with a clear message and exits 0, unless STRICT_BROWSER_E2E=1.
 * Options:
 *   CHROME_PATH=/path/to/chrome   use a specific browser binary
 *   STRICT_BROWSER_E2E=1          fail instead of skipping when no browser
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const E2E = path.join(ROOT, 'e2e');
const DB_FILE = path.join(BACKEND, '.data', `browser-e2e-${process.pid}.sqlite`);
const REPO_CHROME = path.join(E2E, '.browsers', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const npx = isWindows ? 'npx.cmd' : 'npx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitForUrl(url, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (predicate(res.status)) return true;
    } catch {
      // not up yet
    }
    await sleep(400);
  }
  return false;
}

/** Actually launch a browser to prove it works (existence is not enough). */
function canLaunch(executablePath, label) {
  const opts = executablePath ? `{ executablePath: ${JSON.stringify(executablePath)} }` : '{}';
  const code =
    `import { chromium } from 'playwright';` +
    `try { const b = await chromium.launch(${opts}); await b.close(); }` +
    `catch (e) { console.error(String(e.message).split('\\n')[0]); process.exit(1); }`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: E2E,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  const ok = res.status === 0;
  const detail = res.error
    ? ` (${res.error.message})`
    : res.stderr
      ? ` — ${String(res.stderr).trim().split('\n')[0]}`
      : '';
  console.log(`[browser-e2e] browser probe ${label}: ${ok ? 'OK' : 'failed'}${ok ? '' : detail}`);
  return ok;
}

/**
 * Returns a chrome path, `undefined` (use Playwright's bundled browser), or
 * `null` when nothing can launch.
 */
async function ensureBrowser() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push([process.env.CHROME_PATH, 'CHROME_PATH']);
  if (existsSync(REPO_CHROME)) candidates.push([REPO_CHROME, 'repo chrome-headless-shell']);
  candidates.push([undefined, "Playwright's bundled chromium"]);

  for (const [candidate, label] of candidates) {
    if (canLaunch(candidate, label)) return candidate;
  }

  // Nothing launched — try installing Playwright's own browser. This download
  // can be large; cap it so we never hang forever on a slow network.
  console.log('[browser-e2e] No usable Chromium — trying `npx playwright install chromium` (5 min cap)…');
  const install = spawnSync(npx, ['playwright', 'install', 'chromium'], {
    cwd: E2E,
    stdio: 'inherit',
    shell: isWindows,
    timeout: 5 * 60 * 1000,
    killSignal: 'SIGKILL',
  });
  if (install.status === 0 && canLaunch(undefined, "Playwright's bundled chromium (after install)")) {
    return undefined;
  }
  return null;
}

function killAll(children) {
  for (const child of children) if (child) child.kill('SIGTERM');
}

async function main() {
  const apiPort = await freePort();
  const webPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const appUrl = `http://127.0.0.1:${webPort}`;
  const children = [];

  try {
    if (!existsSync(path.join(BACKEND, 'dist', 'main.js'))) {
      console.log('[browser-e2e] Building backend…');
      const build = spawnSync(npm, ['run', 'build'], { cwd: BACKEND, stdio: 'inherit', shell: isWindows });
      if (build.status !== 0) throw new Error('backend build failed');
    }

    rmSync(DB_FILE, { force: true });
    console.log(`[browser-e2e] API  -> ${apiBase}`);
    const api = spawn(process.execPath, [path.join(BACKEND, 'dist', 'main.js')], {
      cwd: BACKEND,
      env: { ...process.env, DB_FILE, PORT: String(apiPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(api);
    api.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
    api.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
    if (!(await waitForUrl(`${apiBase}/auth/me`, (s) => s === 401 || s === 200, 30_000))) {
      throw new Error('isolated API did not become ready');
    }

    console.log(`[browser-e2e] Web  -> ${appUrl}`);
    const web = spawn(npm, ['run', 'dev', '--', '--port', String(webPort), '--strictPort'], {
      cwd: FRONTEND,
      env: { ...process.env, API_PROXY_TARGET: apiBase },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    });
    children.push(web);
    web.stdout.on('data', (d) => process.stdout.write(`[web] ${d}`));
    web.stderr.on('data', (d) => process.stderr.write(`[web] ${d}`));
    if (!(await waitForUrl(appUrl, (s) => s === 200, 45_000))) {
      throw new Error('Vite dev server did not become ready');
    }

    const chrome = await ensureBrowser();
    if (chrome === null) {
      console.warn('[browser-e2e] SKIPPED: no Chromium can launch (missing system libraries?).');
      process.exitCode = process.env.STRICT_BROWSER_E2E === '1' ? 1 : 0;
      return;
    }

    const env = { ...process.env, APP_URL: appUrl };
    if (chrome) env.CHROME_PATH = chrome;
    else env.PLAYWRIGHT_BUNDLED = '1';
    // Hard cap: a hung browser launch (e.g. a constrained container) must never
    // hang the whole suite. The child is killed on timeout.
    const run = spawnSync(process.execPath, [path.join(E2E, 'scripts', 'resolve-slice.e2e.mjs')], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      timeout: 3 * 60 * 1000,
      killSignal: 'SIGKILL',
    });
    if (run.error) {
      console.error(`[browser-e2e] ${run.error.message}`);
    }
    process.exitCode = run.status ?? 1;
  } catch (err) {
    console.error(`[browser-e2e] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    killAll(children);
    await sleep(600);
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(DB_FILE, { force: true });
  }

  // Force exit: the spawned servers' stdio pipes can otherwise keep the event
  // loop alive even after the children are killed.
  process.exit(process.exitCode ?? 0);
}

main();
