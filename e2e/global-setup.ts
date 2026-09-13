/**
 * Vitest global setup for the DOM-level UI E2E.
 *
 * Runs once, in Node, before any test file. The application seeds only the
 * Admin and has no public registration (ADR-004), so this setup provisions the
 * **test fixtures** the UI tests drive, through the real Admin API. Nothing
 * here is an application feature.
 *
 * If the API is not reachable it fails fast with a clear, actionable message.
 * Configure the target with API_URL (default http://localhost:3000).
 */
const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@eurisko.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin123!',
};
const PASSWORD = 'password123';

/** Test-only accounts, created by the Admin just like a real deployment would. */
const FIXTURES: Array<{ name: string; email: string; role: string }> = [
  { name: 'Rana Khoury', email: 'rana.khoury@eurisko.com', role: 'Employee' },
  { name: 'Karim Haddad', email: 'karim.haddad@eurisko.com', role: 'IT_Agent' },
  { name: 'Nadim Saad', email: 'nadim.saad@eurisko.com', role: 'IT_Agent' },
  { name: 'Layla Nassar', email: 'layla.nassar@eurisko.com', role: 'HR_Agent' },
  { name: 'Elias Aoun', email: 'elias.aoun@eurisko.com', role: 'Maintenance_Agent' },
];

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
      `Could not log in as the seeded Admin (${ADMIN.email}) at ${API}: HTTP ${admin.status} ` +
        JSON.stringify(admin.data),
    );
  }
  const token = admin.data.accessToken as string;

  for (const fixture of FIXTURES) {
    const login = await call('POST', '/auth/login', {
      email: fixture.email,
      password: PASSWORD,
    });
    if (login.status === 200) continue;

    const created = await call(
      'POST',
      '/users',
      { ...fixture, password: PASSWORD },
      token,
    );
    if (created.status !== 201) {
      throw new Error(
        `Could not provision ${fixture.role} ${fixture.email}: HTTP ${created.status} ` +
          JSON.stringify(created.data),
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n[e2e] Backend ready at ${API}; ${FIXTURES.length} test fixtures available.`);
}
