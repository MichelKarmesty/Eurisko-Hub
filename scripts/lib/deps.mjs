/**
 * Eurisko Hub - dependency bootstrap, shared by the one-command entry points.
 *
 * `git clone` gives you source and lockfiles, never `node_modules`. Installing
 * them used to be a manual step in the docs, which is exactly what makes "it
 * worked on my machine" possible: a clone with the install step skipped fails
 * with a different error on every machine. This module folds the install into
 * running the app, so one command is enough on any PC:
 *
 *   - it refuses to start on a Node version the toolchain cannot run, with a
 *     message that names the fix, instead of letting Vite fail later with
 *     something opaque;
 *   - it installs a folder's dependencies only when they are missing or older
 *     than that folder's `package.json` / `package-lock.json`, so repeated runs
 *     are not slowed down by a needless reinstall;
 *   - it prefers `npm ci`, which installs exactly what the committed lockfile
 *     pins - two PCs then get the same tree, not merely compatible ranges - and
 *     falls back to `npm install` only when the lockfile is out of sync;
 *   - it falls back to a cache inside the repository when npm's home-directory
 *     cache is not writable, so a locked-down PC can install too.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The range the JavaScript toolchain declares support for, taken from Vite 7
 * (`frontend/package.json`), which is the strictest of the dependencies:
 * Node 20 before 20.19, and every 21.x, are outside it.
 */
export const REQUIRED_NODE_RANGE = '^20.19.0 || >=22.12.0';

const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

/** npm writes this on every install; its mtime is our "dependencies are from here" stamp. */
const STAMP = path.join('node_modules', '.package-lock.json');
/** Files that, when newer than the stamp, mean the installed tree is out of date. */
const INPUTS = ['package.json', 'package-lock.json'];

/** Does a `major.minor.patch` string satisfy REQUIRED_NODE_RANGE? */
export function nodeSatisfies(version, range = REQUIRED_NODE_RANGE) {
  const [major, minor = 0] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;

  // Range: ^20.19.0 (i.e. >=20.19.0 <21) || >=22.12.0 (which includes 23.x+).
  if (major === 20) return minor >= 19;
  if (major === 21) return false;
  if (major === 22) return minor >= 12;
  return major > 22;
}

/**
 * Stop before doing any work if this Node cannot run the project. Failing here,
 * by name, is the difference between "install Node 22" and an afternoon of
 * unexplained `SyntaxError`s.
 */
export function assertNodeVersion() {
  const current = process.versions.node;
  if (nodeSatisfies(current)) return current;

  throw new Error(
    [
      `Node ${current} cannot run this project.`,
      `Required: ${REQUIRED_NODE_RANGE} (Node 22 LTS recommended).`,
      '',
      'Install a supported version and run the same command again:',
      '  nvm:  nvm install 22 && nvm use 22     (.nvmrc already pins 22)',
      '  fnm:  fnm install 22 && fnm use 22',
      '  other: https://nodejs.org/en/download',
      '',
      'Node 20 below 20.19 and every Node 21.x are outside the range the',
      'frontend toolchain supports, so the app would otherwise fail later',
      'with a much less useful error.',
    ].join('\n'),
  );
}

/** Are this folder's dependencies installed and newer than its manifests? */
export function dependenciesAreCurrent(appDir) {
  const stamp = path.join(appDir, STAMP);
  if (!existsSync(stamp)) return false;

  const stampTime = statSync(stamp).mtimeMs;
  return !INPUTS.some((file) => {
    const manifest = path.join(appDir, file);
    return existsSync(manifest) && statSync(manifest).mtimeMs > stampTime;
  });
}

/** Repository root, so the fallback cache lands beside the code (and stays gitignored). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** In-repo npm cache, used only when npm's own cache cannot be written. */
export const LOCAL_NPM_CACHE = path.join(REPO_ROOT, '.npm-cache');

function canWrite(target) {
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where npm would put its cache by default (honours an explicit npm_config_cache). */
function defaultCacheDir() {
  return process.env.npm_config_cache || path.join(os.homedir() || '', '.npm');
}

/**
 * npm's cache lives in the home directory (`~/.npm`) by default. On a locked-down
 * machine - a corporate laptop with a read-only profile, a CI sandbox, a
 * container with a read-only HOME - npm cannot create `_cacache/tmp` there and
 * dies with `EROFS`, followed by an unhelpful "Exit handler never called!". Detect
 * that up front and keep the cache inside the repository instead, which is the
 * workaround the README documents by hand.
 */
function defaultCacheIsWritable() {
  const dir = defaultCacheDir();
  if (!dir) return false;
  // npm creates the folder on demand, so an absent cache is fine as long as its
  // parent can be written to.
  return existsSync(dir) ? canWrite(dir) : canWrite(path.dirname(dir));
}

/** Human-readable folder name for log lines ("backend", not an absolute path). */
function label(appDir) {
  const rel = path.relative(process.cwd(), appDir);
  return rel && !rel.startsWith('..') ? rel : appDir;
}

/**
 * Install one folder's dependencies. `npm ci` is preferred because it installs
 * the lockfile exactly and fails loudly if the lockfile and package.json have
 * drifted; `npm install` is the repair path for that drift, and a repository-local
 * cache is the repair path for a home directory npm cannot write to.
 */
export function installDependencies(appDir) {
  const where = label(appDir);
  const hasLockfile = existsSync(path.join(appDir, 'package-lock.json'));
  const cacheIsWritable = defaultCacheIsWritable();

  const modes = hasLockfile ? ['ci', 'install'] : ['install'];
  const attempts = cacheIsWritable
    ? [...modes.map((mode) => ({ mode, cache: null })), { mode: 'install', cache: LOCAL_NPM_CACHE }]
    : modes.map((mode) => ({ mode, cache: LOCAL_NPM_CACHE }));

  if (!cacheIsWritable) {
    const shown = path.relative(process.cwd(), LOCAL_NPM_CACHE) || LOCAL_NPM_CACHE;
    console.log(
      `[deps] npm's cache (${defaultCacheDir()}) is not writable here — using ${shown} instead.`,
    );
  }
  console.log(`[deps] installing ${where} (npm ${attempts[0].mode}) — first run only…`);

  for (const [index, { mode, cache }] of attempts.entries()) {
    const args = [mode, '--no-audit', '--no-fund'];
    if (cache) args.push('--cache', cache);

    const result = spawnSync(npm, args, {
      cwd: appDir,
      stdio: 'inherit',
      shell: isWindows, // Windows needs a shell to resolve npm.cmd
    });
    if (result.status === 0) return true;

    const next = attempts[index + 1];
    if (next) {
      console.warn(
        next.mode !== mode
          ? `[deps] \`npm ${mode}\` failed in ${where}; retrying with \`npm ${next.mode}\`.`
          : `[deps] \`npm ${mode}\` failed in ${where}; retrying with a cache inside the repository.`,
      );
    }
  }

  console.error(
    `[deps] could not install ${where}. This step needs network access the first time; ` +
      'check your connection and try again.',
  );
  return false;
}

/**
 * Make sure a folder is ready to run: install only when something is missing or
 * stale. Returns false when the install genuinely failed, so the caller can stop
 * with a single clear error rather than a cascade of "module not found".
 */
export function ensureDependencies(appDir) {
  if (dependenciesAreCurrent(appDir)) {
    console.log(`[deps] ${label(appDir)} — dependencies are up to date.`);
    return true;
  }
  return installDependencies(appDir);
}

/** Same, for several folders in order. Throws on the first failure. */
export function ensureDependenciesFor(appDirs) {
  for (const appDir of appDirs) {
    if (!ensureDependencies(appDir)) {
      throw new Error(`dependency install failed in ${label(appDir)} — see the output above`);
    }
  }
}
