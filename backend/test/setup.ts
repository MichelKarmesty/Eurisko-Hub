/**
 * Runs before every Jest test file (see jest.config.js `setupFiles`).
 *
 * Make the test environment deterministic regardless of the developer's shell:
 *  - never touch a real on-disk database: with DB_FILE unset, AppModule uses an
 *    in-memory sqljs database (backend/.gitignore and the root .gitignore both
 *    exclude backend/.data/, so tests must not create files there);
 *  - use the documented seed admin credentials so HTTP tests can log in.
 */
import 'reflect-metadata';

delete process.env.DB_FILE;
process.env.ADMIN_EMAIL = 'admin@eurisko.local';
process.env.ADMIN_PASSWORD = 'Admin123!';
