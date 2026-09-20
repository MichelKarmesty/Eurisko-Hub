#!/usr/bin/env node
/**
 * Password-reset email check (ADR-005).
 *
 * Answers one question: "will an actual email leave this machine?"
 *
 *     node scripts/verify-mail.mjs [recipient@example.com]
 *
 * It reads `backend/.env`, refuses to run while the placeholders are still in
 * place, then sends a real message through the SAME built-in SMTP client the
 * backend uses (`backend/dist/mail/smtp.client.js`) — so a PASS means the exact
 * production code path authenticated and the server accepted the message.
 *
 * The recipient defaults to `SMTP_USER` (mail to yourself is the simplest smoke
 * test). Exit code is 0 on success, 1 on any failure, so it can gate CI.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// MAIL_ENV_FILE points the check at another file (e.g. a throwaway config in a
// test), which is also how this script's success path can be exercised.
const ENV_FILE = process.env.MAIL_ENV_FILE
  ? process.env.MAIL_ENV_FILE
  : join(ROOT, 'backend', '.env');
const CLIENT = join(ROOT, 'backend', 'dist', 'mail', 'smtp.client.js');

const PLACEHOLDERS = ['YOUR_ADDRESS@gmail.com', 'YOUR_16_CHAR_APP_PASSWORD'];

/** Minimal dotenv reader: KEY=VALUE, `#` comments, optional surrounding quotes. */
function readEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(' #');
    if (hash !== -1) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function fail(message, hint) {
  console.log(`FAIL  ${message}`);
  if (hint) console.log(`      ${hint}`);
  process.exit(1);
}

if (!existsSync(ENV_FILE)) {
  fail(`${ENV_FILE} does not exist.`, 'Copy backend/.env.example to backend/.env and fill in the SMTP block.');
}

const env = readEnvFile(ENV_FILE);

if (!env.SMTP_HOST) {
  fail('SMTP_HOST is empty in backend/.env.', 'Without it the reset link is only printed to the backend console.');
}

for (const key of ['SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) {
  if (!env[key]) fail(`${key} is empty in backend/.env.`);
}

const unresolved = ['SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].filter((key) =>
  PLACEHOLDERS.some((placeholder) => env[key].includes(placeholder)),
);

if (unresolved.length > 0) {
  fail(
    `still using the placeholder value(s): ${unresolved.join(', ')}`,
    'Edit backend/.env and set your real Gmail address and App Password first.',
  );
}

if (!existsSync(CLIENT)) {
  fail(
    `built SMTP client not found at ${CLIENT}`,
    'Build the backend first:  cd backend && npm run build',
  );
}

const port = Number(env.SMTP_PORT ?? 587);
const secure = (env.SMTP_SECURE ?? String(port === 465)).toLowerCase() === 'true';
const to = process.argv[2] ?? env.SMTP_USER;

console.log('Eurisko Hub — password-reset email check');
console.log(`  from:  ${env.MAIL_FROM}`);
console.log(`  to:    ${to}`);
console.log(`  via:   ${env.SMTP_HOST}:${port} (${secure ? 'implicit TLS' : 'STARTTLS'})`);
console.log('Sending…');

const { smtpSend } = await import(CLIENT);

try {
  await smtpSend(
    {
      to,
      subject: 'Eurisko Hub — mail delivery test',
      text: [
        'This is a delivery test from the Eurisko Hub backend.',
        '',
        'If you are reading this, password-reset links will now reach your inbox.',
        `Sent at ${new Date().toISOString()}.`,
      ].join('\n'),
    },
    {
      host: env.SMTP_HOST,
      port,
      secure,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM,
      timeoutMs: 20000,
    },
  );
  console.log('');
  console.log(`PASS  ${env.SMTP_HOST} accepted the message for <${to}>.`);
  console.log('      Check the inbox AND the spam folder, then restart the backend');
  console.log('      so it picks up backend/.env.');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log('');
  fail(`SMTP send failed: ${message}`, hintFor(message));
}

/** Turn the common provider errors into the actual fix. */
function hintFor(message) {
  if (/535|Username and Password not accepted|Authentication failed/i.test(message)) {
    return 'Gmail rejected the login. Use an App Password (not your normal password) with 2-Step Verification on, and remove any spaces from the 16-character value.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return 'The SMTP host could not be resolved — check SMTP_HOST and your internet connection.';
  }
  if (/ETIMEDOUT|timeout/i.test(message)) {
    return 'The connection timed out — a firewall or antivirus may be blocking outbound port 587. Try SMTP_PORT=465 with SMTP_SECURE=true.';
  }
  if (/no supported AUTH mechanism/i.test(message)) {
    return 'The server refused every AUTH method we implement (PLAIN/LOGIN). Check the SMTP_USER value.';
  }
  return 'See backend/src/mail/smtp.client.ts for the conversation this client speaks.';
}
