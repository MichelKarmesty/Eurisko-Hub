#!/usr/bin/env node
/**
 * Eurisko Hub - Week 1-5 evidence compiler.
 *
 *   node scripts/collect-evidence.mjs
 *
 * Produces `artifacts/evidence-summary.md`: one file that answers "what did you
 * actually build, and how do you know it works?" for the defense. It collects,
 * from the repository itself and never from a template:
 *
 *   - git log (last 50 commits: SHA, ISO date, message) and the submitted SHA;
 *   - the tracked file tree (`git ls-files`, so ignored build output is excluded);
 *   - the automated test run (`npm test` in backend/, i.e. the vitest suites),
 *     summarised and with the full output saved next to the summary;
 *   - lines of code by file type (.ts, .tsx, .css, .md, .mjs);
 *   - the documentation inventory (docs/**\/*.md + README.md) with sizes;
 *   - the ADR inventory with each decision's title and one-line summary;
 *   - the environment (OS, Node, npm, CPU, memory);
 *   - a dependency audit (`npm audit --json`) for backend and frontend;
 *   - every backend HTTP route, extracted from the NestJS decorators.
 *
 * Options:
 *   --help              Show help and exit 0.
 *   --no-tests          Skip the test run (fast: structure/LOC/docs/ADRs only).
 *   --full              Run the root `npm test` (build + suites + browser E2E + DOM E2E)
 *                       instead of only the backend vitest suites.
 *   --output <file>     Write the summary somewhere else.
 *
 * Exit codes: 0 = the summary was written; 1 = a fatal collection error.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACTS,
  BACKEND,
  FRONTEND,
  helpRequested,
  isoNow,
  parseArgs,
  ROOT,
} from './lib/defense-ui.mjs';

const PARSED = parseArgs();
if (
  helpRequested(PARSED, {
    name: 'collect-evidence.mjs - Week 1-5 evidence compiler',
    summary:
      'Collects git history, file tree, test results, LOC, docs, ADRs, environment, dependency audit and backend routes into artifacts/evidence-summary.md.',
    usage: 'node scripts/collect-evidence.mjs [--no-tests] [--full] [--output artifacts/evidence-summary.md]',
    details: [
      '  --no-tests        Skip the test run (fast structural evidence).',
      '  --full            Use the root npm test (includes browser + DOM E2E).',
      '  --output <file>   Destination for the markdown summary.',
      '',
      'Test output is also saved to artifacts/evidence-tests-<timestamp>.log',
      '',
      'Exit codes: 0 = summary written, 1 = fatal error.',
    ],
  })
) {
  process.exit(0);
}

const OUTPUT = PARSED.get('output', path.join(ARTIFACTS, 'evidence-summary.md'));
const RUN_TESTS = !PARSED.has('no-tests');
const FULL = PARSED.has('full');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

/** Run a command and return `{ ok, status, stdout, stderr }` without throwing. */
function run(command, args, { cwd = ROOT, timeout = 0, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: timeout || undefined,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

const git = (...args) => run('git', args, { cwd: ROOT });

// ── Git ─────────────────────────────────────────────────────────────────────
const sha = git('rev-parse', 'HEAD').stdout.trim();
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
const remote = git('config', '--get', 'remote.origin.url').stdout.trim() || '(no origin remote)';
const totalCommits = git('rev-list', '--count', 'HEAD').stdout.trim();
const log = git('log', '-50', '--date=iso-strict', '--pretty=format:%h%x09%ad%x09%s');

// ── Tree / LOC / docs / ADRs, all from tracked files ────────────────────────
const tracked = git('ls-files').stdout.split(/\r?\n/).filter(Boolean);

const EXTENSIONS = ['.ts', '.tsx', '.css', '.md', '.mjs', '.json', '.sql'];
const loc = new Map(EXTENSIONS.map((ext) => [ext, { files: 0, lines: 0 }]));
let totalLines = 0;
for (const file of tracked) {
  const ext = path.extname(file);
  if (!loc.has(ext)) continue;
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  const lines = text.length === 0 ? 0 : text.split('\n').length;
  const bucket = loc.get(ext);
  bucket.files += 1;
  bucket.lines += lines;
  totalLines += lines;
}

/** Render an indented tree from the tracked-file list. */
function renderTree(files, { maxLines = 400 } = {}) {
  const root = {};
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    for (const part of parts) {
      node[part] = node[part] ?? {};
      node = node[part];
    }
  }
  const out = [];
  const walk = (node, prefix = '') => {
    const entries = Object.keys(node).sort((a, b) => {
      const aDir = Object.keys(node[a]).length > 0;
      const bDir = Object.keys(node[b]).length > 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    entries.forEach((name, index) => {
      const last = index === entries.length - 1;
      const isDir = Object.keys(node[name]).length > 0;
      out.push(`${prefix}${last ? '└── ' : '├── '}${name}${isDir ? '/' : ''}`);
      if (isDir) walk(node[name], `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  walk(root);
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), `… and ${out.length - maxLines} more path(s) — see git ls-files.`];
  }
  return out;
}

const docsFiles = tracked.filter((file) => /^docs\/.*\.md$/i.test(file) || file === 'README.md');
const docInventory = docsFiles.map((file) => {
  const stats = statSync(path.join(ROOT, file));
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
  return { file, bytes: stats.size, lines, mtime: stats.mtime.toISOString() };
});

const adrFiles = tracked.filter((file) => /^docs\/decisions\/ADR-\d+\.md$/i.test(file)).sort();

/** Title + the decision line of an ADR, for a scannable inventory. */
function adrSummary(file) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? path.basename(file)).trim();
  const selected =
    /##\s*Selected Decision\s*\n+\*\*(.+?)\*\*/i.exec(text)?.[1] ??
    /##\s*(?:Decision|Selected Decision)\s*\n+(.+)/i.exec(text)?.[1] ??
    '';
  return { title, selected: selected.replace(/\s+/g, ' ').trim() };
}

// ── Environment ─────────────────────────────────────────────────────────────
const nodeVersion = process.version;
const npmVersion = run('npm', ['--version']).stdout.trim() || 'unknown';
const cpu = os.cpus()?.[0]?.model ?? 'unknown CPU';
const memoryGb = (os.totalmem() / 1024 ** 3).toFixed(1);

// ── Dependency audit ────────────────────────────────────────────────────────
function auditDirectory(dir, label) {
  if (!existsSync(path.join(dir, 'package.json'))) return { label, skipped: 'no package.json' };
  const result = run('npm', ['audit', '--json'], { cwd: dir, timeout: 90000 });
  const text = result.stdout || result.stderr;
  try {
    const json = JSON.parse(text);
    return { label, vulnerabilities: json.metadata?.vulnerabilities ?? null, dependencies: json.metadata?.dependencies ?? null };
  } catch {
    return { label, skipped: result.error ? `npm audit could not run (${result.error.message})` : 'no JSON output' };
  }
}
const audits = [auditDirectory(BACKEND, 'backend'), auditDirectory(FRONTEND, 'frontend')];

// ── Backend routes from NestJS decorators ───────────────────────────────────
function backendRoutes() {
  const routes = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.controller.ts')) {
        routes.push(...routesFromFile(full));
      }
    }
  };
  if (existsSync(path.join(BACKEND, 'src'))) walk(path.join(BACKEND, 'src'));
  return routes;
}

function routesFromFile(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const relative = path.relative(ROOT, file);
  const found = [];
  let prefix = '';
  let classRoles = null;
  let pendingRoles = null;
  let pendingPublic = false;

  const decoratorArg = (line, name) => {
    const match = new RegExp(`@${name}\\(\\s*(['"\`])(.*?)\\1`).exec(line);
    return match ? match[2] : '';
  };
  const rolesArg = (line) => {
    const match = /@Roles\(([^)]*)\)/.exec(line);
    if (!match) return null;
    return match[1]
      .split(',')
      .map((part) => part.replace(/['"\s]/g, ''))
      .filter(Boolean)
      .join(', ');
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('@Controller')) {
      prefix = decoratorArg(line, 'Controller');
      classRoles = null;
      pendingRoles = null;
      pendingPublic = false;
      continue;
    }
    if (line.startsWith('@Roles')) {
      pendingRoles = rolesArg(line);
      continue;
    }
    if (line.startsWith('@Public')) {
      pendingPublic = true;
      continue;
    }
    const method = /^@(Get|Post|Patch|Put|Delete|All)\(/.exec(line);
    if (method) {
      const suffix = decoratorArg(line, method[1]);
      // A class-level @Roles that appears before the first method binds to the class.
      if (!pendingRoles && !pendingPublic && classRoles === null && /export\s+class/.test(lines.join('\n').slice(0, lines.indexOf(raw))) === false) {
        /* no-op: classRoles stays null until a class-level @Roles is seen */
      }
      const roles = pendingRoles ?? classRoles ?? (pendingPublic ? 'public' : 'authenticated');
      const routePath = `/${[prefix, suffix].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
      found.push({
        method: method[1].toUpperCase(),
        path: routePath || '/',
        roles,
        file: `${relative}:${lines.indexOf(raw) + 1}`,
      });
      pendingRoles = null;
      pendingPublic = false;
      continue;
    }
    if (line.startsWith('export class')) {
      // Any @Roles/@Public seen just above the class is class-level.
      if (pendingRoles) classRoles = pendingRoles;
      pendingRoles = null;
      pendingPublic = false;
    }
  }
  return found;
}

const routes = backendRoutes().sort(
  (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
);

// ── Test run ────────────────────────────────────────────────────────────────
let testSection = ['_Tests skipped (--no-tests)._'];
let testLogPath = null;
if (RUN_TESTS) {
  const cwd = FULL ? ROOT : BACKEND;
  const args = FULL ? ['test'] : ['test'];
  process.stdout.write(`Running ${FULL ? 'root' : 'backend'} npm test …\n`);
  const started = Date.now();
  const result = run('npm', args, { cwd, timeout: 20 * 60 * 1000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${result.stdout}\n${result.stderr}`;
  testLogPath = path.join(ARTIFACTS, `evidence-tests-${stamp}.log`);
  writeFileSync(testLogPath, `$ ${FULL ? 'npm test' : 'npm test (backend)'}  @ ${isoNow()}\n\n${output}\n`);

  const files = /Test Files\s+(\d+)\s+passed(?:.*?(\d+)\s+failed)?/.exec(output);
  const tests = /Tests\s+(\d+)\s+passed(?:.*?(\d+)\s+failed)?/.exec(output);
  const failed = Number(files?.[2] ?? tests?.[2] ?? 0);
  const summary = [
    `- Command: \`npm test\` in \`${path.relative(ROOT, cwd) || '.'}\`${FULL ? ' (full suite)' : ' (backend vitest suites)'}`,
    `- Exit code: **${result.status}** in ${seconds}s`,
    `- Test files: **${files?.[1] ?? 'n/a'} passed**${failed ? `, ${failed} failed` : ''}`,
    `- Tests: **${tests?.[1] ?? 'n/a'} passed**${failed ? `, ${failed} failed` : ''}`,
    `- Full output: \`${path.relative(ROOT, testLogPath)}\``,
    '',
    '```text',
    ...output.split('\n').filter((line) => /Test Files|Tests\s|Duration|FAIL|✓|×/.test(line)).slice(0, 40),
    '```',
  ];
  testSection = summary;
  process.stdout.write(`Tests exit ${result.status}; ${tests?.[1] ?? '?'} tests passed.\n`);
}

// ── Markdown ────────────────────────────────────────────────────────────────
const md = [];
md.push('# Eurisko Hub — Week 1–5 Evidence Summary');
md.push('');
md.push(`**Generated:** ${isoNow()}  `);
md.push(`**Submitted commit (HEAD):** \`${sha}\`  `);
md.push(`**Branch:** \`${branch}\` · **Total commits:** ${totalCommits}  `);
md.push(`**Repository:** ${remote}`);
md.push('');
md.push('> Generated by `node scripts/collect-evidence.mjs`. Every fact below is read from the repository or the running toolchain at generation time — nothing is hand-maintained.');
md.push('');

md.push('## 1. Git history (last 50 commits)');
md.push('');
md.push('| SHA | Date (ISO 8601) | Message |');
md.push('| --- | --- | --- |');
for (const line of log.stdout.split(/\r?\n/).filter(Boolean)) {
  const [commitSha, date, ...message] = line.split('\t');
  md.push(`| \`${commitSha}\` | ${date} | ${message.join(' ').replace(/\|/g, '\\|')} |`);
}
md.push('');

md.push('## 2. Repository structure (tracked files)');
md.push('');
md.push(`\`\`\`text`);
md.push(`Eurisko/  (${tracked.length} tracked files)`);
md.push(...renderTree(tracked));
md.push('```');
md.push('');

md.push('## 3. Automated tests');
md.push('');
md.push(...testSection);
md.push('');

md.push('## 4. Lines of code (tracked files)');
md.push('');
md.push('| Type | Files | Lines |');
md.push('| --- | ---: | ---: |');
for (const ext of EXTENSIONS) {
  const bucket = loc.get(ext);
  if (bucket.files > 0) md.push(`| \`${ext}\` | ${bucket.files} | ${bucket.lines.toLocaleString('en-US')} |`);
}
md.push(`| **Total (counted)** | **${[...loc.values()].reduce((a, b) => a + b.files, 0)}** | **${totalLines.toLocaleString('en-US')}** |`);
md.push('');

md.push('## 5. Documentation inventory');
md.push('');
md.push('| File | Size | Lines | Last modified (ISO 8601) |');
md.push('| --- | ---: | ---: | --- |');
for (const doc of docInventory) {
  md.push(`| \`${doc.file}\` | ${(doc.bytes / 1024).toFixed(1)} KB | ${doc.lines} | ${doc.mtime} |`);
}
md.push('');

md.push('## 6. Architecture Decision Records');
md.push('');
md.push(`**${adrFiles.length} ADRs** under \`docs/decisions/\`.`);
md.push('');
md.push('| ADR | Decision |');
md.push('| --- | --- |');
for (const file of adrFiles) {
  const { title, selected } = adrSummary(file);
  md.push(`| [\`${path.basename(file)}\`](${file}) — ${title.replace(/\|/g, '\\|')} | ${selected.replace(/\|/g, '\\|') || '—'} |`);
}
md.push('');

md.push('## 7. Environment');
md.push('');
md.push(`- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`);
md.push(`- Node: ${nodeVersion}`);
md.push(`- npm: ${npmVersion}`);
md.push(`- CPU: ${cpu} (${os.cpus().length} logical cores)`);
md.push(`- Memory: ${memoryGb} GB`);
md.push('');

md.push('## 8. Dependency audit');
md.push('');
for (const audit of audits) {
  if (audit.skipped) {
    md.push(`- **${audit.label}**: ${audit.skipped}`);
    continue;
  }
  const v = audit.vulnerabilities ?? {};
  const total = (v.info ?? 0) + (v.low ?? 0) + (v.moderate ?? 0) + (v.high ?? 0) + (v.critical ?? 0);
  md.push(
    `- **${audit.label}**: ${total} vulnerabilit${total === 1 ? 'y' : 'ies'} ` +
      `(critical ${v.critical ?? 0}, high ${v.high ?? 0}, moderate ${v.moderate ?? 0}, low ${v.low ?? 0}, info ${v.info ?? 0}) ` +
      `across ${audit.dependencies?.total ?? 'n/a'} dependencies`,
  );
}
md.push('');

md.push('## 9. Backend HTTP routes (from NestJS decorators)');
md.push('');
md.push(`**${routes.length} routes** extracted from \`backend/src/**/*.controller.ts\`.`);
md.push('');
md.push('| Method | Path | Access | Source |');
md.push('| --- | --- | --- | --- |');
for (const route of routes) {
  md.push(`| ${route.method} | \`${route.path}\` | ${route.roles} | \`${route.file}\` |`);
}
md.push('');
md.push('---');
md.push('');
md.push(`_Generated by \`scripts/collect-evidence.mjs\` at ${isoNow()}._`);
md.push('');

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${md.join('\n')}\n`);

process.stdout.write(`\nEvidence written to ${path.relative(process.cwd(), OUTPUT)}\n`);
process.stdout.write(`  ${tracked.length} tracked files · ${routes.length} routes · ${adrFiles.length} ADRs\n`);
if (testLogPath) process.stdout.write(`  test log: ${path.relative(process.cwd(), testLogPath)}\n`);
