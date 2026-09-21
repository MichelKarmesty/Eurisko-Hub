#!/usr/bin/env node
/**
 * Password-reset email check (ADR-005, ADR-008).
 *
 * Answers one question: "will an actual email leave this machine?"
 *
 *     node scripts/verify-mail.mjs <recipient@example.com>
 *
 * It reads `backend/.env` and tests **every configured transport**, in the same
 * order the backend tries them:
 *
 *   SMTP_*  ->  SMTP_ALT_*  ->  MAIL_WEBHOOK_URL  ->  RESEND_API_KEY
 *
 * SMTP senders go through the SAME built-in client the backend uses
 * (`backend/dist/mail/smtp.client.js`), so a PASS means the exact production
 * code path authenticated and the server accepted the message. The webhook and
 * Resend transports are called exactly as `MailService` calls them.
 *
 * The exit code is 0 when at least one transport delivered (the app can still
 * send), 1 when none did - so it can gate CI.
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
  fail(`${ENV_FILE} does not exist.`, 'Copy backend/.env.example to backend/.env and fill in a transport.');
}

const env = readEnvFile(ENV_FILE);

/** The bare address inside `Eurisko Hub <you@gmail.com>`, when present. */
function fromAddress(from) {
  const match = /<([^>]+)>/.exec(from ?? '');
  return match ? match[1] : (from ?? '').trim();
}

/** One configured SMTP sender, or null when its HOST is unset. */
function readSender(prefix, label) {
  const host = env[`${prefix}_HOST`];
  if (!host) return null;
  const port = Number(env[`${prefix}_PORT`] ?? 587);
  const secure = (env[`${prefix}_SECURE`] ?? String(port === 465)).toLowerCase() === 'true';
  const from = env[`${prefix}_FROM`] ?? env.MAIL_FROM ?? '';
  return {
    kind: 'smtp',
    label,
    host,
    port,
    secure,
    user: env[`${prefix}_USER`],
    pass: env[`${prefix}_PASS`],
    from,
    keys: {
      user: `${prefix}_USER`,
      pass: `${prefix}_PASS`,
      from: env[`${prefix}_FROM`] ? `${prefix}_FROM` : 'MAIL_FROM',
    },
  };
}

const transports = [];
const skipped = [];

for (const sender of [
  readSender('SMTP', 'primary SMTP (SMTP_*)'),
  readSender('SMTP_ALT', 'backup SMTP (SMTP_ALT_*)'),
].filter(Boolean)) {
  // An SMTP block whose values are still empty/placeholders is not configured:
  // skip it with a note instead of failing the whole check (the other
  // transports may be perfectly fine - e.g. a Resend-only setup).
  const incomplete = Object.entries(sender.keys).filter(
    ([field, key]) =>
      !sender[field] ||
      PLACEHOLDERS.some((p) => String(sender[field]).includes(p)) ||
      (key === 'MAIL_FROM' && PLACEHOLDERS.some((p) => String(sender[field]).includes(p))),
  );
  if (incomplete.length > 0) {
    skipped.push(
      `${sender.label}: ${incomplete.map(([, key]) => key).join(', ')} empty or still a placeholder — skipped`,
    );
    continue;
  }
  transports.push(sender);
}

if (env.MAIL_WEBHOOK_URL) {
  transports.push({
    kind: 'webhook',
    label: 'webhook (MAIL_WEBHOOK_URL)',
    url: env.MAIL_WEBHOOK_URL,
    token: env.MAIL_WEBHOOK_TOKEN,
  });
}

if (env.RESEND_API_KEY) {
  transports.push({
    kind: 'resend',
    label: 'Resend (RESEND_API_KEY)',
    apiKey: env.RESEND_API_KEY,
    from: env.MAIL_FROM ?? 'Eurisko Hub <onboarding@resend.dev>',
  });
}

for (const note of skipped) console.log(`note  ${note}`);
if (skipped.length > 0) console.log('');

if (transports.length === 0) {
  fail(
    'no mail transport is configured in backend/.env.',
    'Set SMTP_HOST (and/or MAIL_WEBHOOK_URL / RESEND_API_KEY) — otherwise the reset link is only printed to the backend console. See: node scripts/setup-mail.mjs',
  );
}

// The recipient: an explicit argument wins; otherwise the first SMTP account
// (mail to yourself), which is what the setup wizard relies on.
const to =
  process.argv[2] ??
  transports.find((t) => t.kind === 'smtp')?.user ??
  fromAddress(transports.find((t) => t.kind === 'resend')?.from);

if (!to) {
  fail(
    'no recipient given and no SMTP account to default to.',
    'Run: node scripts/verify-mail.mjs you@gmail.com',
  );
}

console.log('Eurisko Hub — password-reset email check');
console.log(`  to:    ${to}`);
console.log(`  via:   ${transports.map((t) => t.label).join(' then ')}`);
console.log('');

const { smtpSend } = await import(CLIENT).catch(() => ({ smtpSend: null }));

const subject = 'Eurisko Hub — mail delivery test';
const body = (label) =>
  [
    'This is a delivery test from the Eurisko Hub backend.',
    '',
    `Transport: ${label}.`,
    'If you are reading this, password-reset links will now reach your inbox.',
    `Sent at ${new Date().toISOString()}.`,
  ].join('\n');

async function postJson(url, headers, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).trim()}`);
}

let delivered = 0;
for (const transport of transports) {
  const where =
    transport.kind === 'smtp'
      ? `${transport.host}:${transport.port} (${transport.secure ? 'implicit TLS' : 'STARTTLS'})`
      : transport.kind === 'resend'
        ? 'api.resend.com'
        : transport.url;
  console.log(`Sending via ${transport.label} — ${where} …`);
  try {
    if (transport.kind === 'smtp') {
      if (!smtpSend) throw new Error(`built SMTP client missing at ${CLIENT} (cd backend && npm run build)`);
      await smtpSend(
        { to, subject, text: body(transport.label) },
        {
          host: transport.host,
          port: transport.port,
          secure: transport.secure,
          user: transport.user,
          pass: transport.pass,
          from: transport.from,
          timeoutMs: 20000,
        },
      );
    } else if (transport.kind === 'webhook') {
      await postJson(
        transport.url,
        transport.token ? { Authorization: `Bearer ${transport.token}` } : {},
        { to, subject, text: body(transport.label) },
      );
    } else {
      await postJson(
        'https://api.resend.com/emails',
        { Authorization: `Bearer ${transport.apiKey}` },
        { from: transport.from, to: [to], subject, text: body(transport.label) },
      );
    }
    delivered += 1;
    console.log(`PASS  ${transport.label} accepted the message for <${to}>.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`FAIL  ${transport.label}: ${message}`);
    console.log(`      ${hintFor(message)}\n`);
  }
}

if (delivered === 0) {
  console.log('No configured transport could deliver the message.');
  process.exit(1);
}

console.log(
  `${delivered}/${transports.length} transport(s) delivered. Check the inbox AND the spam folder,`,
);
console.log('then restart the backend so it picks up backend/.env.');
process.exit(0);

/** Turn the common provider errors into the actual fix. */
function hintFor(message) {
  if (/401|403|API key is invalid|Missing API key/i.test(message)) {
    return 'The provider rejected the credential. Re-copy it (a Resend key starts with "re_") and make sure it is the whole value.';
  }
  if (/535|Username and Password not accepted|Authentication failed/i.test(message)) {
    return 'The provider rejected the login. Use an App Password (not the normal password) with 2-Step Verification on, and remove any spaces from the 16-character value.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return 'The host could not be resolved — check the HOST value and your internet connection.';
  }
  if (/ETIMEDOUT|timeout/i.test(message)) {
    return 'The connection timed out — a firewall or antivirus may be blocking outbound port 587. Try the provider on port 465 with SMTP_SECURE=true.';
  }
  if (/no supported AUTH mechanism/i.test(message)) {
    return 'The server refused every AUTH method we implement (PLAIN/LOGIN). Check the USER value — a work/school Microsoft 365 account often has SMTP AUTH disabled entirely.';
  }
  if (/onboarding@resend\.dev|not verified|domain is not verified|restricted/i.test(message)) {
    return 'With Resend you can only send to your own account address from onboarding@resend.dev until you verify a domain at resend.com/domains.';
  }
  return 'See backend/src/mail/mail.service.ts for the exact payload each transport sends.';
}
