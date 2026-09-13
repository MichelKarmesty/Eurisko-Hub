import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { TicketsModule } from './tickets/tickets.module';
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
 */
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqljs',
      location: process.env.DB_FILE ?? undefined, // undefined => in-memory DB
      autoSave: Boolean(process.env.DB_FILE),
      synchronize: true,
      entities: [User, Ticket, TicketEvent],
    }),
    UsersModule,
    AuthModule,
    TicketsModule,
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
   * Bootstrap an empty database with exactly ONE account: the Admin.
   *
   * There is no demo seeding and no public registration (ADR-004). Every other
   * account — agents and employees — is created from inside the app by an
   * Admin (the **Users** tab, `POST /users`). Seeding runs only when the
   * database has no users at all, so restarts never duplicate data.
   */
  async onApplicationBootstrap() {
    const email = (process.env.ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL).toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;

    const existing = await this.users.findByEmail(email);
    if (existing) return;

    const count = await this.users.count();
    if (count > 0) {
      this.logger.warn(
        `Database is not empty and no ${email} exists — skipping the admin seed.`,
      );
      return;
    }

    await this.users.create({
      name: 'Eurisko Admin',
      email,
      password,
      role: 'Admin',
    });
    this.logger.log(`Seeded the Admin account: ${email}`);
    this.logger.log(
      'No demo accounts and no public registration: sign in as Admin and create users from the Users tab.',
    );
  }
}
