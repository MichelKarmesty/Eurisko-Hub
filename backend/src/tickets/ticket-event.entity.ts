import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TicketStatus } from '../common/domain';
import { User } from '../users/user.entity';
import { Ticket } from './ticket.entity';

export type TicketAction =
  | 'CREATED'
  | 'CLAIMED'
  | 'STATUS_CHANGED'
  | 'RESOLVED';

/**
 * Ticket history (architecture.md §2: the DB is the source of truth for
 * "user credentials, tickets, and ticket history"). One row per event so
 * every status change is stored durably (docs/data-model.md §3).
 */
@Entity('ticket_events')
export class TicketEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  ticketId: number;

  @Column()
  actorId: number;

  @Column({ type: 'text' })
  action: TicketAction;

  @Column({ type: 'text', nullable: true })
  fromStatus: TicketStatus | null;

  @Column({ type: 'text', nullable: true })
  toStatus: TicketStatus | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  ticket: Ticket;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  actor: User;
}
