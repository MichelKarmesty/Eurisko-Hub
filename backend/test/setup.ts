/**
 * Runs before every test file (see vitest.config.mts `setupFiles`).
 *
 * Make the test environment deterministic regardless of the developer's shell:
 *  - never touch a real on-disk database: with DB_FILE unset, AppModule uses an
 *    in-memory sqljs database (backend/.data/ is gitignored, so tests must not
 *    create files there);
 *  - use the documented seed admin credentials so HTTP tests can log in;
 *  - skip the dev demo-account seeding so suites start from a minimal state.
 */
import 'reflect-metadata';

delete process.env.DB_FILE;
process.env.ADMIN_EMAIL = 'rami.fares@eurisko.com';
process.env.ADMIN_PASSWORD = 'Admin123!';
process.env.SEED_DEMO_DATA = 'false';
