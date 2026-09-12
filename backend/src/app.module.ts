import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { Role } from './common/domain';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { TicketsModule } from './tickets/tickets.module';
import { Ticket } from './tickets/ticket.entity';
import { TicketEvent } from './tickets/ticket-event.entity';
import { UsersService } from './users/users.service';

/**
 * Demo personas for local development, so a fresh database is immediately
 * usable from the login screen. Keep in sync with DEMO_ACCOUNTS in
 * frontend/src/components/AuthScreen.tsx.
 */
const DEMO_PERSONAS: ReadonlyArray<{ name: string; email: string; role: Role }> = [
  { name: 'Alice Requester', email: 'alice@corp.com', role: 'Employee' },
  { name: 'Bob IT Agent', email: 'bob@corp.com', role: 'IT_Agent' },
  { name: 'Dave IT Agent', email: 'dave@corp.com', role: 'IT_Agent' },
  { name: 'Carol HR Agent', email: 'carol@corp.com', role: 'HR_Agent' },
  { name: 'Eve Maintenance Agent', email: 'eve@corp.com', role: 'Maintenance_Agent' },
];
const DEMO_PASSWORD = 'password123';

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
   * Bootstrap an empty database: create the first Admin account, then (in
   * development) the demo personas shown on the login screen. Both run only
   * when the database has no users at all, so restarts never duplicate data.
   */
  async onApplicationBootstrap() {
    const email = process.env.ADMIN_EMAIL ?? 'admin@eurisko.local';
    const password = process.env.ADMIN_PASSWORD ?? 'Admin123!';
    const existing = await this.users.findByEmail(email);
    if (existing) return;

    const count = await this.users.count();
    if (count > 0) {
      this.logger.warn(
        `DB is not empty and no ${email} exists — skipping admin seed.`,
      );
      return;
    }

    await this.users.create({
      name: 'Eurisko Admin',
      email,
      password,
      role: 'Admin',
    });
    this.logger.log(`Seeded admin account: ${email} / ${password}`);
    await this.seedDemoAccounts();
  }

  /**
   * Dev convenience: a fresh database also gets the demo requester/agents so
   * the resolve-ticket slice can be exercised straight from the login screen —
   * no terminal provisioning step needed. Disable with SEED_DEMO_DATA=false
   * (and it never runs when NODE_ENV=production). In normal operation, agent
   * and admin accounts are still provisioned by an Admin via POST /users.
   */
  private async seedDemoAccounts() {
    if (process.env.NODE_ENV === 'production' || process.env.SEED_DEMO_DATA === 'false') {
      return;
    }
    for (const persona of DEMO_PERSONAS) {
      await this.users.create({ ...persona, password: DEMO_PASSWORD });
    }
    this.logger.log(
      `Seeded ${DEMO_PERSONAS.length} demo accounts (password: ${DEMO_PASSWORD}).`,
    );
  }
}
