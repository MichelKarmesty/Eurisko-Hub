#!/usr/bin/env node
/**
 * Eurisko Hub — one-time setup for REAL password-reset email.
 *
 *     node scripts/setup-mail.mjs [you@gmail.com]
 *
 * It asks for your Gmail address and a Google **App Password**, writes them into
 * `backend/.env` (gitignored — never committed), and then sends a real test
 * message through the same built-in SMTP client the backend uses, so a PASS
 * means reset links will genuinely reach an inbox.
 *
 * The App Password is typed hidden and is never echoed, logged or printed.
 *
 * Gmail requires an App Password — a normal account password will not work:
 *   1. turn on 2-Step Verification  https://myaccount.google.com/security
 *   2. create one                   https://myaccount.google.com/apppasswords
 *   3. copy the 16 characters (spaces are ignored)
 *
 * Any other provider works too — edit SMTP_HOST / SMTP_PORT in backend/.env
 * (Outlook/Hotmail: smtp-mail.outlook.com; or MAIL_WEBHOOK_URL / RESEND_API_KEY).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, 'backend', '.env');
const EXAMPLE = join(ROOT, 'backend', '.env.example');
const CLIENT = join(ROOT, 'backend', 'dist', 'mail', 'smtp.client.js');

/** Lines already supplied on a pipe (non-interactive runs / tests). */
let pipedLines = null;
async function readPiped() {
  if (pipedLines) return;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  pipedLines = Buffer.concat(chunks).toString('utf8').split('\n').map((s) => s.trim());
}

/** Read one line. `hidden` prints '*' instead of the characters. */
async function ask(question, hidden = false) {
  process.stdout.write(question);

  if (!process.stdin.isTTY) {
    await readPiped();
    process.stdout.write('\n');
    return pipedLines.shift() ?? '';
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          return reject(new Error('cancelled'));
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          if (hidden) process.stdout.write('\b \b');
          continue;
        }
        value += ch;
        if (hidden) process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/** Set KEY=value in the .env file, preserving every other line and comment. */
function upsertEnv(values) {
  const source = existsSync(ENV_FILE)
    ? readFileSync(ENV_FILE, 'utf8')
    : existsSync(EXAMPLE)
      ? readFileSync(EXAMPLE, 'utf8')
      : '';
  const keys = Object.keys(values);
  const seen = new Set();
  const lines = source.split(/\r?\n/).map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (match && keys.includes(match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${values[match[1]]}`;
    }
    return line;
  });
  for (const key of keys) if (!seen.has(key)) lines.push(`${key}=${values[key]}`);
  writeFileSync(ENV_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}

async function main() {
  console.log('Eurisko Hub — real password-reset email setup\n');

  const argAddress = process.argv[2]?.trim();
  const address = argAddress || (await ask('Gmail address           : '));
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    console.error('That does not look like an email address.');
    process.exit(1);
  }

  const typed = await ask('Google App Password     : ', true);
  const appPassword = typed.replace(/\s+/g, '');
  if (!appPassword) {
    console.error('No App Password given — nothing was changed.');
    process.exit(1);
  }
  if (appPassword.length !== 16) {
    console.warn(
      `\n  ! A Google App Password is 16 characters; you gave ${appPassword.length}.\n` +
        '    Writing it anyway — if it is a normal account password, Gmail will refuse it.\n',
    );
  }

  upsertEnv({
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: address,
    SMTP_PASS: appPassword,
    MAIL_FROM: `Eurisko Hub <${address}>`,
  });
  console.log(`\nSaved to ${ENV_FILE.replace(`${ROOT}/`, '')} (gitignored — never committed).`);

  if (!existsSync(CLIENT)) {
    console.log('\nBuilding the backend (needed for the SMTP client)…');
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: join(ROOT, 'backend'),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) {
      console.error('Build failed — fix that, then run:  node scripts/verify-mail.mjs');
      process.exit(1);
    }
  }

  console.log(`\nSending a real test message to ${address} …\n`);
  const check = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'verify-mail.mjs'), address],
    { stdio: 'inherit' },
  );

  if (check.status === 0) {
    console.log('\nDone. Reset links will now be emailed.');
    console.log('Restart the backend so it picks the file up:  cd backend && npm start');
  } else {
    console.log('\nThe message could not be sent — the output above says why.');
    console.log('Check the address and the App Password (16 characters, spaces removed).');
  }
  process.exit(check.status ?? 1);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
