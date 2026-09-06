import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from './ticket.entity';
import { TicketEvent } from './ticket-event.entity';
import { TicketsService } from './tickets.service';
import { AdminController, TicketsController } from './tickets.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket, TicketEvent])],
  providers: [TicketsService],
  controllers: [TicketsController, AdminController],
  exports: [TicketsService],
})
export class TicketsModule {}
