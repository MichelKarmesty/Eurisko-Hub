import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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

/** The one bootstrap account; override with ADMIN_EMAIL / ADMIN_PASSWORD. */
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
      useFactory: () => ({
        type: 'sqljs',
        location: process.env.DB_FILE ?? undefined, // undefined => in-memory DB
        autoSave: Boolean(process.env.DB_FILE),
        synchronize: true,
        entities: [User, Ticket, TicketEvent],
      }),
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

  constructor(private readonly users: UsersService) {}

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
