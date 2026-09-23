import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { TicketsModule } from './tickets/tickets.module';
import { AiIntakeModule } from './ai/ai-intake.module';
import { Ticket } from './tickets/ticket.entity';
import { TicketEvent } from './tickets/ticket-event.entity';
import { UsersService } from './users/users.service';

/**
 * The one bootstrap account; override with ADMIN_EMAIL / ADMIN_PASSWORD.
 *
 * `admin@eurisko.com` is only the out-of-the-box **development default**: any
 * valid email address is accepted everywhere in the app (ADR-005), and a real
 * deployment should set ADMIN_EMAIL to a deliverable address so the Admin can
 * receive password-reset email.
 */
const DEFAULT_ADMIN_EMAIL = 'admin@eurisko.com';
const DEFAULT_ADMIN_PASSWORD = 'Admin123!';

/**
 * Modular monolith (architecture.md §2): Auth Module + Ticket Module + one
 * relational database. Local runs use a SQLite database (TypeORM sqljs
 * driver) so nothing extra needs installing; swap the TypeORM config for
 * PostgreSQL in production.
 *
 * v0.4 adds the AI intake module (docs/week4-production-ai.md): it is advisory
 * and has no database access at all, so TicketsService stays the only writer.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      // Resolved when the application boots rather than when this file is
      // imported, so `DB_FILE` is read per app instance: tests can point it at a
      // prepared database and operators at a persistent file.
      useFactory: () => {
        const location = process.env.DB_FILE;

        // `backend/.data` is gitignored, so it is missing in a fresh clone, and
        // sql.js cannot write a file into a folder that does not exist -- the app
        // would just log "Unable to connect to the database. Retrying..." until
        // someone created the folder by hand. Create it here instead, so
        // `npm start` works on a clean checkout with no extra step.
        if (location) {
          mkdirSync(dirname(location), { recursive: true });
        }

        return {
          type: 'sqljs',
          location: location ?? undefined, // undefined => in-memory DB
          autoSave: Boolean(location),
          synchronize: true,
          entities: [User, Ticket, TicketEvent],
        };
      },
    }),
    UsersModule,
    AuthModule,
    TicketsModule,
    AiIntakeModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('Seed');

  constructor(
    private readonly users: UsersService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * SQLite enforces foreign keys only while `PRAGMA foreign_keys = ON`, and
   * TypeORM's `sqljs` driver never sets it. Without this, every `onDelete` rule
   * declared on the entities (`RESTRICT`, `CASCADE`, `SET NULL`) is decorative:
   * a deleted account leaves `assignedToId` / `requesterId` pointing at a row
   * that no longer exists, and a ticket can be written for a user that is gone.
   *
   * The statement has to go through the driver's own connection: on `sqljs`,
   * `dataSource.query()` does not persist a PRAGMA (the connection still reports
   * `0` right after), while `databaseConnection.run()` does - and the setting
   * then survives ordinary repository traffic. `admin-user-deletion.spec.ts`
   * pins both facts.
   */
  private enforceForeignKeys(): void {
    const driver = this.dataSource.driver as unknown as {
      databaseConnection?: { run(sql: string): unknown };
    };
    driver.databaseConnection?.run('PRAGMA foreign_keys = ON');
  }

  /**
   * Guarantee the database has an Admin, so it can never be locked out.
   *
   * There is no demo seeding and no public registration (ADR-004); every other
   * account is created from inside the app by an Admin (the **Users** tab,
   * `POST /users`). The rules, in order:
   *
   *  1. the configured `ADMIN_EMAIL` already exists -> do nothing (a changed
   *     password is never reset);
   *  2. an Admin exists under another email -> do nothing (respect the running
   *     deployment);
   *  3. no Admin exists at all -> create one. On a new database this is the
   *     documented bootstrap; on a database that already has users it
   *     *recovers* an instance whose Admin email changed, which the previous
   *     "seed only an empty database" rule left permanently unreachable (every
   *     Admin login returned 401 "Invalid credentials").
   */
  async onApplicationBootstrap() {
    this.enforceForeignKeys();

    const email = (process.env.ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL).toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;

    if (await this.users.findByEmail(email)) return;

    const admins = await this.users.findByRole('Admin');
    if (admins.length > 0) {
      this.logger.log(
        `An Admin already exists (${admins
          .map((admin) => admin.email)
          .join(', ')}); not seeding ${email}.`,
      );
      return;
    }

    const existingUsers = await this.users.findAll();
    await this.users.create({
      name: 'Eurisko Admin',
      email,
      password,
      role: 'Admin',
    });

    if (existingUsers.length > 0) {
      this.logger.warn(
        `No Admin account existed in a database with ${existingUsers.length} ` +
          `account(s) (${existingUsers
            .map((user) => `${user.email} [${user.role}]`)
            .join(', ')}) — seeded the Admin account: ${email}`,
      );
    } else {
      this.logger.log(`Seeded the Admin account: ${email}`);
    }
    this.logger.log(
      'No demo accounts and no public registration: sign in as Admin and create users from the Users tab.',
    );
  }
}
