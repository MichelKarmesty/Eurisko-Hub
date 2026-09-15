import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { Ticket } from '../tickets/ticket.entity';
import { TicketEvent } from '../tickets/ticket-event.entity';

@Module({
  // Ticket/TicketEvent are injected so account deletion can tell an account
  // with history (deactivate) from one without (hard delete).
  imports: [TypeOrmModule.forFeature([User, Ticket, TicketEvent])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
