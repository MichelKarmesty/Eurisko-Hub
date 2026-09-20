#!/usr/bin/env node
/**
 * Eurisko Hub — offline password-reset break-glass (ADR-007).
 *
 *     node scripts/reset-password.mjs someone@eurisko.com
 *
 * Why this exists: the normal recovery paths are the **self-service** flow
 * (`POST /auth/forgot-password` mails a link — needs a configured mail
 * provider, ADR-008) and the **Admin-initiated** one
 * (`POST /users/:id/reset-password`, ADR-007), but both need *someone else* or
 * a working mail server. This script is the last resort for a **lone Admin who
 * has locked themselves out** — it mints exactly the same one-time reset token
 * the app would, straight into the SQLite file, and prints the link to hand
 * over / open.
 *
 *   • writes ONLY the two existing reset columns (hash + expiry); nothing else
 *   • the raw token is never stored — only its SHA-256 hash, like the app
 *   • single-use and time-limited (PASSWORD_RESET_TTL_MINUTES, default 30 min)
 *   • the employee sets their own new password afterwards via the app
 *
 * ⚠️ Stop the backend before running this. The API keeps the database in memory
 * (sql.js) and autosaves on writes, so a running server would overwrite this
 * change. Start it again afterwards. The script warns you if the port is open.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend');
const ENV_FILE = join(BACKEND, '.env');

/** Minimal `KEY=value` reader — enough for the handful of vars used here. */
function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const email = process.argv[2]?.trim();
if (!email || email === '--help' || email === '-h') {
  console.log(
    'Usage: node scripts/reset-password.mjs <email>\n\n' +
      'Mints a one-time password-reset link for an existing account and prints it.\n' +
      'Stop the backend first — it would otherwise overwrite the change.\n',
  );
  process.exit(email ? 0 : 1);
}

const fileEnv = readEnvFile();
const env = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback;

const rawDbFile = env('DB_FILE', '.data/hub.sqlite');
const dbFile = isAbsolute(rawDbFile) ? rawDbFile : resolve(BACKEND, rawDbFile);
const baseUrl = (env('APP_BASE_URL', 'http://localhost:5173')).replace(/\/+$/, '');
const ttlMinutes = (() => {
  const value = Number(env('PASSWORD_RESET_TTL_MINUTES', '30'));
  return Number.isFinite(value) && value > 0 ? value : 30;
})();
const port = Number(env('PORT', '3000'));

if (!existsSync(dbFile)) {
  console.error(
    `No database at ${dbFile}.\n` +
      'Set DB_FILE in backend/.env to the file the backend actually writes ' +
      '(without it the app uses an in-memory database, which this script cannot reach).',
  );
  process.exit(1);
}

/** Warn (do not block) when the API appears to be running. */
function portOpen() {
  return new Promise((res) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      res(open);
    };
    socket.setTimeout(600);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const require = createRequire(join(BACKEND, 'package.json'));
const initSqlJs = require('sql.js');

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(dbFile));

const find = db.prepare(
  'SELECT id, name, email, isActive FROM users WHERE lower(email) = lower(?)',
);
find.bind([email]);
const user = find.step() ? find.getAsObject() : null;
find.free();

if (!user) {
  db.close();
  console.error(`No account with the email ${email}.`);
  process.exit(1);
}
if (!Number(user.isActive)) {
  db.close();
  console.error(
    `The account ${user.email} is deactivated — reactivate it in the app first.`,
  );
  process.exit(1);
}

const token = randomBytes(32).toString('hex');
const tokenHash = createHash('sha256').update(token).digest('hex');
const expiresAt = Date.now() + ttlMinutes * 60_000;

db.run(
  'UPDATE users SET passwordResetTokenHash = ?, passwordResetExpiresAt = ? WHERE id = ?',
  [tokenHash, expiresAt, user.id],
);
writeFileSync(dbFile, Buffer.from(db.export()));
db.close();

const resetUrl = `${baseUrl}/?resetToken=${token}`;
console.log(`\nOne-time reset link for ${user.name} <${user.email}>:`);
console.log(`  ${resetUrl}`);
console.log(
  `\nValid for ${ttlMinutes} minutes and works once. Give it to ${user.email}; ` +
    'they choose their own new password.',
);
console.log(`Database updated: ${dbFile}`);

if (await portOpen()) {
  console.log(
    `\n⚠️  Something is listening on 127.0.0.1:${port} — the backend looks like it is ` +
      'running. Stop it (Ctrl+C), rerun this script, then start it again, or the ' +
      'server may overwrite this change.',
  );
} else {
  console.log('\nStart the backend again if you stopped it.');
}
