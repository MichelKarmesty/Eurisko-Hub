import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Health & observability surface (docs/security.md §ops, README "Operations").
 *
 * Why this exists: the final smoke test and the live defense health monitor
 * need to prove, from outside the process, that the API is alive, that it has
 * been up for a known time, and that the SQLite file is really on disk and
 * growing. Without an endpoint the only "proof" would be a screenshot, and
 * "health/ops evidence missing" is an explicit hard-fail condition.
 *
 * Two rules keep it safe to expose publicly:
 *
 *  1. **No secrets and no PII.** It reports counts, timings and a file size -
 *     never a JWT, a password hash, an email address or a ticket body. The
 *     last-request ring buffer stores only method, path, status and duration.
 *  2. **Path only, never a query string.** A ticket title never travels in a
 *     URL here, but query strings are dropped anyway so a future route cannot
 *     leak one into an unauthenticated response.
 */

/** One observed HTTP request; deliberately free of bodies, headers and query. */
export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  ms: number;
  at: string;
}

/** `GET /health` (and `GET /`) response body - the deployment's vital signs. */
export interface HealthReport {
  status: 'ok';
  service: string;
  version: string;
  startedAt: string;
  now: string;
  uptimeMs: number;
  uptime: string;
  db: {
    mode: 'file' | 'memory';
    file: string | null;
    exists: boolean;
    sizeBytes: number;
    sizeHuman: string;
  };
  requests: {
    total: number;
    errors: number;
    last5: RequestLogEntry[];
  };
}

/** How many requests the ring buffer keeps. "Last 5" is what the monitor shows. */
const LOG_SIZE = 25;

/** Human-readable byte size, e.g. `148 KB` - matches what an operator expects. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `12m 34s` / `45s` / `2h 04m` - compact uptime for a terminal line. */
export function humanDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * Resolve `DB_FILE` to an absolute path.
 *
 * `DB_FILE` is documented relative to `backend/` (`./.data/hub.sqlite`), but a
 * process started from the repository root or with an absolute path must also
 * work. Try the working directory first (an operator's explicit choice), then
 * the backend directory (the documented default).
 */
export function resolveDbFile(raw: string | undefined): string | null {
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  const candidates = [
    path.resolve(process.cwd(), raw),
    path.resolve(__dirname, '..', '..', raw), // backend/ from src/ or dist/
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** Read the API version from package.json; never let a broken file break health. */
function readVersion(): string {
  try {
    const file = path.join(__dirname, '..', '..', 'package.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

@Injectable()
export class HealthService {
  private readonly startedAtMs = Date.now();
  private readonly version = readVersion();
  private readonly log: RequestLogEntry[] = [];
  private total = 0;
  private errors = 0;

  /**
   * Record one finished request. Called from the middleware's `finish` event,
   * so `status` is the real response code (including 4xx/5xx).
   */
  record(entry: RequestLogEntry): void {
    this.total += 1;
    if (entry.status >= 400) this.errors += 1;
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
  }

  /** The current vital signs. Cheap and side-effect free. */
  report(): HealthReport {
    const now = Date.now();
    const dbFile = resolveDbFile(process.env.DB_FILE);

    let exists = false;
    let sizeBytes = 0;
    if (dbFile && existsSync(dbFile)) {
      exists = true;
      sizeBytes = statSync(dbFile).size;
    }

    return {
      status: 'ok',
      service: 'eurisko-hub-api',
      version: this.version,
      startedAt: new Date(this.startedAtMs).toISOString(),
      now: new Date(now).toISOString(),
      uptimeMs: now - this.startedAtMs,
      uptime: humanDuration(now - this.startedAtMs),
      db: {
        mode: dbFile ? 'file' : 'memory',
        file: dbFile,
        exists,
        sizeBytes,
        sizeHuman: humanBytes(sizeBytes),
      },
      requests: {
        total: this.total,
        errors: this.errors,
        last5: this.log.slice(-5).reverse(),
      },
    };
  }
}
