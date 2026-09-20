import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load `backend/.env` (gitignored) into `process.env`.
 *
 * This module exists so the file is read **before** anything else looks at the
 * environment: `main.ts` imports it first, and with CommonJS emit the requires
 * run in source order, so `JwtModule` (which reads `JWT_SECRET` /
 * `JWT_EXPIRES_IN` while its module is evaluated) sees the file's values too.
 *
 * Without it, plain `npm start` ignored `backend/.env` entirely: you could fill
 * in the Gmail block and no reset email would ever be sent, because only the VS
 * Code task ran node with `--env-file=.env`.
 *
 * `process.loadEnvFile` never overwrites a variable that is already set, so a
 * value exported in the shell still wins, and a missing file is not an error.
 */
const file = path.join(__dirname, '..', '.env');

if (existsSync(file)) {
  try {
    process.loadEnvFile(file);
    console.log(`[env] loaded ${file}`);
  } catch (err) {
    console.warn(
      `[env] could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export {};
