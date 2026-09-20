#!/usr/bin/env node
/**
 * Eurisko Hub — one-time setup for REAL password-reset email.
 *
 *     node scripts/setup-mail.mjs [you@gmail.com]
 *
 * It asks for your address(es) and an App Password, writes them into
 * `backend/.env` (gitignored — never committed), and then sends real test
 * messages through the same built-in SMTP client the backend uses, so a PASS
 * means reset links will genuinely reach an inbox.
 *
 * **Two senders are supported** (ADR-008): the backend tries the first one and
 * falls back to the second when it fails. Give a Gmail address first and an
 * Outlook one second — or just one and press Enter at the second prompt.
 * The provider is recognised from the domain:
 *
 *   @gmail.com                      -> smtp.gmail.com:587
 *   @outlook.com/@hotmail.com/…     -> smtp-mail.outlook.com:587
 *   anything else                   -> you are asked for the SMTP host
 *
 * App Passwords are typed hidden and are never echoed, logged or printed.
 *
 * Gmail requires an App Password — a normal account password will not work:
 *   1. turn on 2-Step Verification  https://myaccount.google.com/security
 *   2. create one                   https://myaccount.google.com/apppasswords
 *   3. copy the 16 characters (spaces are ignored)
 * Outlook (personal): https://account.microsoft.com/security ->
 *   Advanced security options -> App passwords.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, 'backend', '.env');
const EXAMPLE = join(ROOT, 'backend', '.env.example');
const CLIENT = join(ROOT, 'backend', 'dist', 'mail', 'smtp.client.js');

/** Known providers, recognised from the address domain. */
const PROVIDERS = [
  { match: /@(gmail|googlemail)\.com$/i, host: 'smtp.gmail.com', name: 'Gmail' },
  { match: /@(outlook|hotmail|live|msn)\./i, host: 'smtp-mail.outlook.com', name: 'Outlook' },
];

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

/** Ask for one sender's address + App Password; null when skipped. */
async function readSender(ordinal, presetAddress) {
  const label = ordinal === 1 ? 'Sender 1' : 'Sender 2 (backup, Enter to skip)';
  const address = (presetAddress ?? (await ask(`${label} address  : `))).trim();
  if (!address) return null;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    console.error(`"${address}" does not look like an email address.`);
    process.exit(1);
  }

  const typed = await ask(`${label} App Password : `, true);
  const appPassword = typed.replace(/\s+/g, '');
  if (!appPassword) {
    console.error(`No App Password given for ${address} — nothing was changed.`);
    process.exit(1);
  }
  if (appPassword.length !== 16) {
    console.warn(
      `  ! An App Password is 16 characters; you gave ${appPassword.length} for ${address}.\n` +
        '    Writing it anyway — if it is a normal account password, the provider will refuse it.',
    );
  }

  const known = PROVIDERS.find((p) => p.match.test(address));
  let host = known?.host;
  if (!host) {
    host = (await ask(`  SMTP host for ${address} (e.g. mail.company.com): `)).trim();
    if (!host) {
      console.error(`No SMTP host given for ${address} — nothing was changed.`);
      process.exit(1);
    }
  } else {
    console.log(`  ${known.name} detected -> ${host}`);
  }

  return { address, appPassword, host, name: known?.name ?? host };
}

async function main() {
  console.log('Eurisko Hub — real password-reset email setup\n');
  console.log('You can configure TWO senders: the backend uses the first and falls');
  console.log('back to the second if it fails (e.g. Gmail primary, Outlook backup).\n');

  const first = await readSender(1, process.argv[2]?.trim() || undefined);
  if (!first) {
    console.error('No sender address given — nothing was changed.');
    process.exit(1);
  }
  const second = await readSender(2);

  const values = {
    SMTP_HOST: first.host,
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: first.address,
    SMTP_PASS: first.appPassword,
    MAIL_FROM: `Eurisko Hub <${first.address}>`,
    SMTP_ALT_HOST: second?.host ?? '',
    SMTP_ALT_PORT: second ? '587' : '',
    SMTP_ALT_SECURE: second ? 'false' : '',
    SMTP_ALT_USER: second?.address ?? '',
    SMTP_ALT_PASS: second?.appPassword ?? '',
    SMTP_ALT_FROM: second ? `Eurisko Hub <${second.address}>` : '',
  };
  upsertEnv(values);
  console.log(`\nSaved to ${ENV_FILE.replace(`${ROOT}/`, '')} (gitignored — never committed).`);
  console.log(`  sender 1: ${first.address} via ${first.host}`);
  console.log(
    `  sender 2: ${second ? `${second.address} via ${second.host}` : '(none — the first sender is the only one)'}`,
  );

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

  console.log(`\nSending real test messages to ${first.address} …\n`);
  const check = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'verify-mail.mjs'), first.address],
    { stdio: 'inherit' },
  );

  if (check.status === 0) {
    console.log('\nDone. Reset links will now be emailed.');
    console.log('Restart the backend so it picks the file up:  cd backend && npm start');
  } else {
    console.log('\nNo sender could deliver — the output above says why.');
    console.log('Check the addresses and the App Passwords (16 characters, spaces removed).');
  }
  process.exit(check.status ?? 1);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
