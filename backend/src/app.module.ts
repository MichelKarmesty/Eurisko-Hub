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

  /** Create the first Admin account on an empty database (dev bootstrap). */
  async onApplicationBootstrap() {
    const email = process.env.ADMIN_EMAIL ?? 'admin@eurisko.local';
    const password = process.env.ADMIN_PASSWORD ?? 'Admin123!';
    const existing = await this.users.findByEmail(email);
    if (!existing) {
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
    }
  }
}
