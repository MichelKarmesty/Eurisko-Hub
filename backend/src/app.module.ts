import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import {
  DEMO_ADMIN,
  DEMO_PERSONAS,
  adminEmail,
  adminPassword,
  demoSeedingEnabled,
} from './common/demo-accounts';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { TicketsModule } from './tickets/tickets.module';
import { Ticket } from './tickets/ticket.entity';
import { TicketEvent } from './tickets/ticket-event.entity';
import { UsersService } from './users/users.service';

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
    const email = adminEmail();
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
      name: DEMO_ADMIN.name,
      email,
      password: adminPassword(),
      role: 'Admin',
    });
    this.logger.log(`Seeded admin account: ${email}`);
    await this.seedDemoAccounts();
  }

  /**
   * Dev convenience: a fresh database also gets the demo requester/agents so
   * the slice can be exercised straight from the login screen — no terminal
   * provisioning step needed. Never runs in production; disable in dev with
   * `SEED_DEMO_DATA=false`. See docs/security.md.
   */
  private async seedDemoAccounts() {
    if (!demoSeedingEnabled()) {
      this.logger.warn(
        'Demo account seeding is disabled (SEED_DEMO_DATA=false or NODE_ENV=production).',
      );
      return;
    }
    for (const persona of DEMO_PERSONAS) {
      await this.users.create({
        name: persona.name,
        email: persona.email,
        password: persona.password,
        role: persona.role,
      });
    }
    this.logger.warn(
      `Seeded ${DEMO_PERSONAS.length} DEMO accounts with well-known passwords ` +
        `(${DEMO_PERSONAS.map((p) => p.email).join(', ')}). ` +
        'Development only — never enable this in production.',
    );
  }
}
