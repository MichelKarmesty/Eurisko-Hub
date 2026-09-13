/**
 * Vitest global setup for the DOM-level UI E2E.
 *
 * Runs once, in Node, before any test file. It makes the suite runnable against
 * a freshly started backend (only the seeded admin account exists):
 *
 *   1. waits for the API to answer;
 *   2. logs in as the seeded admin;
 *   3. provisions the demo personas the UI flow uses (idempotent).
 *
 * If the API is not reachable it fails fast with a clear, actionable message
 * instead of a confusing timeout deep inside a test.
 *
 * Configure the target with API_URL (default http://localhost:3000).
 */
const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'rami.fares@eurisko.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin123!',
};

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data: data as any };
}

async function waitForApi() {
  const deadline = Date.now() + 20_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/auth/me`);
      if (res.status === 401 || res.status === 200) return; // API is up
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Backend API not reachable at ${API} (${lastError}).\n` +
      `Start it first, e.g.\n` +
      `  cd backend && npm run build && DB_FILE="$PWD/.data/e2e.sqlite" npm start\n` +
      `or run the whole suite with: node scripts/run-tests.mjs`,
  );
}

export default async function setup() {
  await waitForApi();

  const admin = await call('POST', '/auth/login', ADMIN);
  if (admin.status !== 200) {
    throw new Error(
      `Could not log in as the seeded admin (${ADMIN.email}) at ${API}: HTTP ${admin.status} ` +
        JSON.stringify(admin.data),
    );
  }
  const token = admin.data.accessToken as string;

  // The account list comes from the backend (single source of truth:
  // backend/src/common/demo-accounts.ts) via the dev-only GET /demo/accounts.
  const demo = await call('GET', '/demo/accounts');
  const accounts = (demo.data?.accounts ?? []) as Array<{
    name: string;
    email: string;
    role: string;
    password: string | null;
  }>;

  if (accounts.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[e2e] Demo seeding looks disabled; no demo accounts to provision.');
    return;
  }

  for (const account of accounts) {
    if (!account.password) continue; // admin password overridden — keep it private
    const login = await call('POST', '/auth/login', {
      email: account.email,
      password: account.password,
    });
    if (login.status === 200) continue;

    const created = await call(
      'POST',
      '/users',
      { name: account.name, email: account.email, password: account.password, role: account.role },
      token,
    );
    if (created.status !== 201) {
      throw new Error(
        `Could not provision ${account.role} ${account.email}: HTTP ${created.status} ` +
          JSON.stringify(created.data),
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n[e2e] Backend ready at ${API}; ${accounts.length} demo accounts available.`);
}
