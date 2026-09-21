/**
 * REGRESSION - the Admin seed must never lock a database out (ADR-004).
 *
 * ADR-004 ships exactly one seeded account, the Admin. The first version of
 * that seed only ran on a *completely empty* database, so a database that
 * already had users but no Admin - for example one created before the Admin
 * email changed from `rami.fares@eurisko.com` to `admin@eurisko.com` - was
 * skipped forever: `admin@eurisko.com` never existed and every Admin login
 * returned `401 "Invalid credentials"`, with only a console warning to explain
 * it. The database was effectively unreachable.
 *
 * These tests boot the real `AppModule` against a **persistent** sqljs file
 * prepared to look like an existing deployment, so they pin the recovery rules:
 *
 *   users but no Admin          -> the Admin is seeded, existing users kept;
 *   an Admin under another email -> nothing is seeded (respect the deployment);
 *   admin@eurisko.com exists     -> left untouched, password never reset.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Role } from '../src/common/domain';
import { TicketEvent } from '../src/tickets/ticket-event.entity';
import { Ticket } from '../src/tickets/ticket.entity';
import { User } from '../src/users/user.entity';
import { UsersService } from '../src/users/users.service';

const ADMIN_EMAIL = 'admin@eurisko.com';
const LEGACY_PASSWORD = 'password123';

interface SeedUser {
  name: string;
  email: string;
  role: Role;
}

/**
 * Write a real sqljs database that already contains `seed` (i.e. an existing
 * deployment) and hand back its temp directory and file path.
 */
async function prepareDatabase(seed: SeedUser[]) {
  const dir = mkdtempSync(join(tmpdir(), 'eurisko-seed-'));
  const file = join(dir, 'hub.sqlite');

  const source = new DataSource({
    type: 'sqljs',
    location: file,
    autoSave: true,
    synchronize: true,
    entities: [User, Ticket, TicketEvent],
  });

  await source.initialize();
  const repo = source.getRepository(User);
  for (const user of seed) {
    await repo.save(
      repo.create({
        name: user.name,
        email: user.email,
        passwordHash: await bcrypt.hash(LEGACY_PASSWORD, 10),
        role: user.role,
      }),
    );
  }
  await source.destroy();

  return { dir, file };
}

describe('Admin seed - a database can never be locked out (ADR-004)', () => {
  let app: INestApplication | null = null;
  let dir: string | null = null;

  /** Boot the real application against `file` (DB_FILE is read at boot). */
  async function boot(file: string): Promise<UsersService> {
    process.env.DB_FILE = file;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app.get(UsersService);
  }

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    delete process.env.DB_FILE;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('seeds the Admin when the database has users but no Admin (the lockout case)', async () => {
    const prepared = await prepareDatabase([
      { name: 'Rana Khoury', email: 'rana.khoury@eurisko.com', role: 'Employee' },
      { name: 'Karim Haddad', email: 'karim.haddad@eurisko.com', role: 'IT_Agent' },
    ]);
    dir = prepared.dir;

    const users = await boot(prepared.file);

    const admin = await users.findByEmail(ADMIN_EMAIL);
    expect(admin).not.toBeNull();
    expect(admin?.role).toBe('Admin');

    // Recovery is additive: the pre-existing accounts survive untouched.
    expect(await users.findByEmail('rana.khoury@eurisko.com')).not.toBeNull();
    expect(await users.findByEmail('karim.haddad@eurisko.com')).not.toBeNull();
    expect(await users.count()).toBe(3);
  });

  it('does not seed when an Admin already exists under another email', async () => {
    const prepared = await prepareDatabase([
      { name: 'Rami Fares', email: 'rami.fares@eurisko.com', role: 'Admin' },
    ]);
    dir = prepared.dir;

    const users = await boot(prepared.file);

    expect(await users.findByEmail(ADMIN_EMAIL)).toBeNull();
    expect(await users.count()).toBe(1);
  });

  it('leaves an existing admin@eurisko.com (and its password) untouched', async () => {
    const prepared = await prepareDatabase([]); // empty database
    dir = prepared.dir;

    const firstRun = await boot(prepared.file);
    const seeded = await firstRun.findByEmail(ADMIN_EMAIL);
    expect(seeded).not.toBeNull();
    const originalHash = seeded?.passwordHash;
    await app!.close();
    app = null;

    // A second boot against the same file must not duplicate or reset anything.
    const secondRun = await boot(prepared.file);
    const again = await secondRun.findByEmail(ADMIN_EMAIL);
    expect(again?.passwordHash).toBe(originalHash);
    expect(await secondRun.count()).toBe(1);
  });
});
