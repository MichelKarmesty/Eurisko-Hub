/**
 * Eurisko Hub - shared helpers for the defense tooling.
 *
 * Every script under `scripts/` is runnable on its own with `node`, and none of
 * them installs anything: this module and those scripts use Node's built-in
 * modules only (`fetch`, `fs`, `path`, `child_process`, `crypto`). The single
 * deliberate exception is `prove-recovery.mjs`'s database surgery, which loads
 * `sql.js` **out of `backend/node_modules`** exactly like the pre-existing
 * `scripts/reset-password.mjs` does - never a new dependency.
 *
 * What lives here:
 *   - colour handling that honours `NO_COLOR` and non-TTY output;
 *   - `Box`, the double-line report frame used by the defense scripts, which
 *     pads on the *visible* width (ANSI escapes excluded) so columns line up;
 *   - tiny argv helpers so each script can support `--help` in four lines;
 *   - `request()`, a `fetch` wrapper that reports status, elapsed time and a
 *     parsed body without ever throwing on a non-2xx response;
 *   - environment/DB path discovery shared by the health and recovery scripts.
 *
 * Nothing here has side effects on import.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository paths, derived from this file's location - never from cwd. */
export const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(LIB_DIR, '..', '..');
export const BACKEND = path.join(ROOT, 'backend');
export const FRONTEND = path.join(ROOT, 'frontend');
export const ARTIFACTS = path.join(ROOT, 'artifacts');

/** Should output carry ANSI colour? Honours NO_COLOR, FORCE_COLOR and TTY-ness. */
const colorEnabled = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout && process.stdout.isTTY);
})();

const wrap = (open) => (text) => (colorEnabled ? `\u001b[${open}m${text}\u001b[0m` : String(text));

export const color = {
  enabled: colorEnabled,
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '');

/** Visible length of a string, ignoring colour escapes. */
export function visibleLength(text) {
  return stripAnsi(text).length;
}

/**
 * Truncate to `max` visible columns, keeping ANSI colour codes intact and
 * appending an ellipsis. Used so one very long diagnostic cannot stretch a
 * report box past the terminal width.
 */
export function truncateVisible(text, max) {
  const str = String(text);
  if (visibleLength(str) <= max) return str;
  const escape = /\u001b\[[0-9;]*m/y;
  let out = '';
  let visible = 0;
  let index = 0;
  while (index < str.length) {
    escape.lastIndex = index;
    const match = escape.exec(str);
    if (match) {
      out += match[0];
      index += match[0].length;
      continue;
    }
    if (visible >= Math.max(0, max - 1)) {
      out += '…';
      break;
    }
    out += str[index];
    visible += 1;
    index += 1;
  }
  return out + (str.includes('\u001b[') ? '\u001b[0m' : '');
}

/** Pad to `width` visible columns (left-aligned unless `align: 'right'`). */
export function pad(text, width, align = 'left') {
  const missing = Math.max(0, width - visibleLength(text));
  return align === 'right' ? ' '.repeat(missing) + text : text + ' '.repeat(missing);
}

/**
 * The double-line report frame used by the defense scripts.
 *
 * `Box` accumulates rows and prints once, so a script can report a row the
 * moment it is proven - the audience sees each line appear during the demo
 * instead of the whole frame landing at the end.
 *
 *   const box = new Box('FINAL SMOKE TEST', { minWidth: 62 });
 *   box.row('  ✅  Server health');
 *   box.separator();
 *   box.row('  Result: 20/20 passed');
 *   box.print();
 */
export class Box {
  constructor(title, { minWidth = 62, maxWidth = 84, border = color.cyan } = {}) {
    this.title = title;
    this.minWidth = minWidth;
    this.maxWidth = maxWidth;
    this.border = border;
    this.rows = [];
  }

  /** One content row (already decorated with icons/colours). */
  row(text = '') {
    this.rows.push({ type: 'row', text: String(text) });
    return this;
  }

  /** A `╠═══╣` divider between sections. */
  separator() {
    this.rows.push({ type: 'separator' });
    return this;
  }

  /** Compose the frame as an array of lines (does not print). */
  lines() {
    const body = this.rows.map((entry) =>
      entry.type === 'separator'
        ? ''
        : `  ${entry.text}`.replace(/\s+$/, ''),
    );
    const titleLine = pad(this.title, Math.max(1, this.minWidth - 2), 'center');
    const computed = Math.max(
      this.minWidth,
      visibleLength(titleLine) + 2,
      ...body.map((line) => visibleLength(line)),
    );
    const width = Math.min(computed, this.maxWidth);

    const bar = (left, right) => `${left}${'═'.repeat(width)}${right}`;
    const out = [
      this.border(bar('╔', '╗')),
      `${this.border('║')}${pad(` ${this.title} `, width, 'center')}${this.border('║')}`,
      this.border(bar('╠', '╣')),
    ];

    for (const entry of this.rows) {
      if (entry.type === 'separator') {
        out.push(this.border(bar('╠', '╣')));
      } else {
        out.push(`${this.border('║')}${pad(truncateVisible(`  ${entry.text}`, width), width)}${this.border('║')}`);
      }
    }

    out.push(this.border(bar('╚', '╝')));
    return out;
  }

  print(stream = process.stdout) {
    stream.write(`${this.lines().join('\n')}\n`);
    return this;
  }
}

/** A single status line, e.g. `✅  Git working tree clean`. */
export function badge(ok, text, { warn = false } = {}) {
  const icon = ok ? color.green('✅') : warn ? color.yellow('⚠️ ') : color.red('❌');
  return `${icon}  ${text}`;
}

/** ISO 8601 timestamp - the format every artifact in this project uses. */
export const isoNow = () => new Date().toISOString();

/** `12m 34s` / `8s` - uptime rendered for a human, not a machine. */
export function humanDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/** `148 KB` - binary units, one decimal only when it helps. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return 'n/a';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** File size in bytes, or null when the file does not exist. */
export function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * Minimal `KEY=VALUE` reader for the gitignored `backend/.env`.
 *
 * Deliberately not a full dotenv: it exists so the defense scripts can find the
 * database path and confirm that a secret is configured **locally** without
 * importing the app or printing the value. `export ` prefixes, quotes and
 * comments are handled; nothing is written back to `process.env`.
 */
export function readEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * Where the running app keeps its SQLite file.
 *
 * Order: `process.env.DB_FILE` (what the process actually uses), then
 * `backend/.env`'s `DB_FILE`, then the documented dev default
 * `backend/.data/hub.sqlite` (`scripts/dev.mjs` sets exactly that when there is
 * no `.env`). A relative value is resolved against `backend/`, matching the
 * app, which runs with `backend/` as its working directory.
 */
export function resolveDbFile({ backend = BACKEND } = {}) {
  const fromEnv = process.env.DB_FILE || readEnvFile(path.join(backend, '.env')).DB_FILE;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(backend, fromEnv);
  return path.join(backend, '.data', 'hub.sqlite');
}

/** The API base URL a script should talk to, from `API_BASE`/argv or localhost. */
export function resolveApiBase(fallbackPort = 3000) {
  const explicit = process.env.API_BASE || process.env.LIVE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://127.0.0.1:${Number(process.env.PORT ?? fallbackPort)}`;
}

/** `--help` detection plus `--key value` / `--flag` reading, shared by scripts. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [name, inline] = token.slice(2).split('=');
    if (inline !== undefined) {
      options[name] = inline;
      flags.add(name);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      i += 1;
    }
    flags.add(name);
  }
  return {
    flags,
    options,
    has: (name) => flags.has(name),
    get: (name, fallback) => (options[name] !== undefined ? options[name] : fallback),
  };
}

/**
 * Print a consistent `--help` screen and return true when help was requested.
 * Scripts call this first and exit 0, so `--help` never fails a checklist run.
 */
export function helpRequested(parsed, { name, summary, usage, details = [] }) {
  if (!parsed.has('help') && !parsed.has('h')) return false;
  const lines = [
    color.bold(name),
    '',
    summary,
    '',
    `${color.bold('Usage:')} ${usage}`,
    '',
    `${color.bold('Options:')}`,
    '  --help                 Show this help and exit 0.',
    ...details,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return true;
}

/**
 * `fetch` wrapper for the defense scripts.
 *
 * Never throws on a non-2xx status - a `403` is a *result* the RBAC checks
 * assert on, not an exception. It only reports a transport failure as
 * `{ ok: false, status: 0, error }`, so a dead server produces a red line
 * instead of a stack trace in front of the audience.
 */
export async function request(base, route, { method = 'GET', token, body, timeoutMs = 20000, raw = false } = {}) {
  const url = `${base.replace(/\/+$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = process.hrtime.bigint();

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const text = await res.text();
    let data = null;
    if (!raw && text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { url, status: res.status, ok: res.ok, ms, data, text };
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return {
      url,
      status: 0,
      ok: false,
      ms,
      data: null,
      text: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the API answering? Probes `/health` first (the honest readiness route),
 * then `/` (liveness), and reports which one answered. Used by the scripts that
 * must wait for a backend they started themselves.
 */
export async function waitForApi(base, { timeoutMs = 30000, intervalMs = 300, token } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const health = await request(base, '/health', { token, timeoutMs: 2000 });
    if (health.status === 200) return { route: '/health', response: health };
    last = health;
    const root = await request(base, '/', { timeoutMs: 2000 });
    if (root.status === 200) return { route: '/', response: root };
    last = root;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { route: null, response: last };
}

/** `node scripts/...` for a log line, without assuming cwd. */
export const commandHint = (script, args = '') =>
  `node ${path.relative(process.cwd(), path.join(LIB_DIR, '..', script)) || script}${args ? ` ${args}` : ''}`;

/** Truncate a response body for a one-line diagnostic. */
export function brief(value, max = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || text === null) return '(no body)';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
