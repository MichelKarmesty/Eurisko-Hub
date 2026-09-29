#!/usr/bin/env node
/**
 * Eurisko Hub - production entrypoint for a single container.
 *
 *   node deploy/server.mjs
 *
 * Why this exists: in development the browser talks to Vite on :5173 and Vite
 * proxies `/api` to the NestJS API on :3000 (see `frontend/vite.config.ts`), so
 * the client can use relative URLs and never needs a hardcoded host or CORS.
 * A container has no Vite, so this file takes its place and keeps the exact same
 * public shape:
 *
 *   GET /            -> the built React app (frontend/dist), with SPA fallback
 *   GET /api/...     -> proxied to the API (the /api prefix is stripped, because
 *                       NestJS routes have no global prefix - ADR-001)
 *   GET /api/health  -> the API readiness route, proxied; use it as the
 *                       platform health check
 *
 * It also supervises the API as a child process, so the image is ONE container
 * running ONE command - no process manager, no second service to wire up, and
 * no nginx config to keep in step. If the API exits unexpectedly this process
 * exits too, which is what a container platform expects so it can restart it.
 *
 * Node built-ins only - no dependencies, matching the rest of `scripts/`.
 *
 * Environment:
 *   PORT            public port to bind                    (default 8080)
 *   API_PORT        internal port for the API child        (default 3000)
 *   FRONTEND_DIST   built SPA directory   (default frontend/dist)
 *   API_ENTRY       compiled API entry    (default backend/dist/main.js)
 *   NO_COLOR        disable ANSI color in the log
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.PORT ?? 8080);
const API_PORT = Number(process.env.API_PORT ?? 3000);
const API_HOST = '127.0.0.1';
const FRONTEND_DIST = path.resolve(process.env.FRONTEND_DIST ?? path.join(ROOT, 'frontend', 'dist'));
const API_ENTRY = path.resolve(process.env.API_ENTRY ?? path.join(ROOT, 'backend', 'dist', 'main.js'));

const HELP = `
Eurisko Hub - production entrypoint (single container)

  node deploy/server.mjs

Serves the built React app and proxies /api to the NestJS API, which it starts
and supervises as a child process.

Environment:
  PORT=${PORT}                 public port this server binds
  API_PORT=${API_PORT}             internal port the API child binds
  FRONTEND_DIST=${path.relative(ROOT, FRONTEND_DIST)}
  API_ENTRY=${path.relative(ROOT, API_ENTRY)}

Required by the API in production (it refuses to start without them):
  JWT_SECRET, APP_BASE_URL
Also set DB_FILE to a path on a persistent volume, and TYPEORM_SYNCHRONIZE=true
so SQLite tables are created (this project ships no migrations).
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Logging - ISO 8601, color only when a human is watching
// ---------------------------------------------------------------------------

const color =
  !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' && Boolean(process.stdout.isTTY);
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const stamp = () => new Date().toISOString();
const log = (message) => process.stdout.write(`${stamp()}  ${message}\n`);
const warn = (message) => process.stderr.write(`${stamp()}  ${paint(33, 'WARN')}  ${message}\n`);

// ---------------------------------------------------------------------------
// Fail fast, with a message that says what to do
// ---------------------------------------------------------------------------

if (!fs.existsSync(FRONTEND_DIST)) {
  warn(`the built web client is missing at ${FRONTEND_DIST}`);
  warn('build it first:  cd frontend && npm ci && npm run build');
  process.exit(1);
}
if (!fs.existsSync(API_ENTRY)) {
  warn(`the compiled API is missing at ${API_ENTRY}`);
  warn('build it first:  cd backend && npm ci && npm run build');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The API child process
// ---------------------------------------------------------------------------

// The API reads PORT from its own environment, so hand it the internal port -
// otherwise it would fight this server for the public one.
const api = spawn(process.execPath, [API_ENTRY], {
  cwd: path.dirname(API_ENTRY),
  env: { ...process.env, PORT: String(API_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const relay = (stream, sink) => {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) sink(`[api] ${line}`);
  });
};
relay(api.stdout, (line) => process.stdout.write(`${line}\n`));
relay(api.stderr, (line) => process.stderr.write(`${line}\n`));

let shuttingDown = false;
api.on('exit', (code, signal) => {
  if (shuttingDown) return;
  warn(`the API exited unexpectedly (code ${code}, signal ${signal}) - stopping so the platform can restart the container`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Static files for the SPA
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const INDEX = path.join(FRONTEND_DIST, 'index.html');

/** Resolve a URL path inside FRONTEND_DIST, or null if it escapes (traversal). */
function resolveStatic(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = path.resolve(FRONTEND_DIST, `.${path.posix.normalize(decoded)}`);
  if (candidate !== FRONTEND_DIST && !candidate.startsWith(FRONTEND_DIST + path.sep)) return null;
  return candidate;
}

function sendFile(res, file, status = 200) {
  const body = fs.readFileSync(file);
  res.writeHead(status, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    // Hashed asset filenames are immutable; index.html must never be cached, or
    // a redeploy keeps serving the old app.
    'cache-control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// The proxy: /api/* -> the API, with the prefix stripped
// ---------------------------------------------------------------------------

function proxy(req, res) {
  const target = (req.url ?? '/').replace(/^\/api/, '') || '/';

  const headers = { ...req.headers, host: `${API_HOST}:${API_PORT}` };
  // Ask the API for an uncompressed body so the bytes we pass through always
  // match the headers we pass through.
  delete headers['accept-encoding'];

  const upstream = http.request(
    { host: API_HOST, port: API_PORT, method: req.method, path: target, headers },
    (apiRes) => {
      res.writeHead(apiRes.statusCode ?? 502, apiRes.headers);
      apiRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    warn(`proxy to the API failed for ${req.method} ${target}: ${error.code ?? error.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'The API is not answering yet. It may still be starting.',
      }),
    );
  });

  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];

  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    proxy(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
    res.end(JSON.stringify({ statusCode: 405, message: 'Method Not Allowed' }));
    return;
  }

  const file = resolveStatic(req.url ?? '/');
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    sendFile(res, file);
    return;
  }

  // SPA fallback: client-side routes (e.g. /tickets/12) are not files; hand the
  // app shell back and let the router resolve them. /api is handled above and
  // never reaches this branch, so an unknown API route stays a JSON 404.
  sendFile(res, INDEX, 200);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`${paint(32, 'Eurisko Hub')} listening on http://0.0.0.0:${PORT}`);
  log(`  web client   ${FRONTEND_DIST}`);
  log(`  api          ${API_HOST}:${API_PORT} (child pid ${api.pid})`);
  log(`  health       http://0.0.0.0:${PORT}/api/health`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown - platforms send SIGTERM, then SIGKILL shortly after
// ---------------------------------------------------------------------------

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal} - shutting down`);
  server.close();
  api.kill('SIGTERM');
  const force = setTimeout(() => {
    warn('the API did not stop in time - killing it');
    api.kill('SIGKILL');
    process.exit(0);
  }, 8000);
  force.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
