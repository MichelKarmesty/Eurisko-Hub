import { Role } from './domain';

/**
 * The ONE source of truth for the local/demo accounts.
 *
 * Every consumer reads from here:
 *  - `AppModule` seeds them into an empty database;
 *  - `DemoController` (`GET /demo/accounts`, dev-only) exposes them so the
 *    login card, `scripts/verify-slice.mjs` and the E2E harnesses never keep
 *    their own copy;
 *  - the frontend renders its "Quick sign-in" panel from that endpoint.
 *
 * They are development conveniences with well-known passwords. Seeding is
 * disabled automatically in production and can be switched off with
 * `SEED_DEMO_DATA=false`; see `docs/security.md`.
 */
export interface DemoAccount {
  /** Short role label shown on the login card. */
  label: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  hint: string;
}

export const DEMO_PERSONAS: readonly DemoAccount[] = [
  { label: 'Employee', name: 'Rana Khoury', email: 'rana.khoury@eurisko.com', password: 'password123', role: 'Employee', hint: 'Requester — opens tickets and follows their status' },
  { label: 'IT Agent', name: 'Karim Haddad', email: 'karim.haddad@eurisko.com', password: 'password123', role: 'IT_Agent', hint: 'Serves the IT queue' },
  { label: 'IT Agent', name: 'Nadim Saad', email: 'nadim.saad@eurisko.com', password: 'password123', role: 'IT_Agent', hint: 'Second IT agent — useful for the “not assigned” denied case' },
  { label: 'HR Agent', name: 'Layla Nassar', email: 'layla.nassar@eurisko.com', password: 'password123', role: 'HR_Agent', hint: 'Serves the HR queue' },
  { label: 'Maintenance Agent', name: 'Elias Aoun', email: 'elias.aoun@eurisko.com', password: 'password123', role: 'Maintenance_Agent', hint: 'Serves the Maintenance queue' },
];

export const DEMO_ADMIN: DemoAccount = {
  label: 'Admin',
  name: 'Rami Fares',
  email: 'rami.fares@eurisko.com',
  password: 'Admin123!',
  role: 'Admin',
  hint: 'Sees every ticket, manages users, assigns and cancels tickets',
};

/** Demo passwords are shown in the UI; these are not secrets. */
export const DEMO_PASSWORD = 'password123';

export function adminEmail(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADMIN_EMAIL ?? DEMO_ADMIN.email;
}

export function adminPassword(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADMIN_PASSWORD ?? DEMO_ADMIN.password;
}

/** Seeding never runs in production and can be turned off explicitly. */
export function demoSeedingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.SEED_DEMO_DATA !== 'false';
}

/** What `GET /demo/accounts` returns. */
export interface PublicDemoAccount extends Omit<DemoAccount, 'password'> {
  /** `null` when the Admin password was overridden and must stay private. */
  password: string | null;
}

/**
 * The demo accounts as exposed to the (dev-only) endpoint. The Admin password
 * is withheld if it was overridden via env, so a real secret is never echoed
 * back over HTTP.
 */
export function publicDemoAccounts(env: NodeJS.ProcessEnv = process.env): PublicDemoAccount[] {
  const admin: PublicDemoAccount = {
    ...DEMO_ADMIN,
    email: adminEmail(env),
    password: env.ADMIN_PASSWORD ? null : adminPassword(env),
  };
  return [admin, ...DEMO_PERSONAS];
}
