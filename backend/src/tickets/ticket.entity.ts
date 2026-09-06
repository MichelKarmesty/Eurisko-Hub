import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  Category,
  Priority,
  STATUSES,
  TicketStatus,
} from '../common/domain';
import { User } from '../users/user.entity';

/** docs/data-model.md §1 — Ticket: a request for help. */
@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'text' })
  category: Category;

  @Column({ type: 'text' })
  priority: Priority;

  @Column({ type: 'text', default: 'Open' })
  status: TicketStatus;

  /** FK -> users.id of the employee who opened the ticket. */
  @Column()
  requesterId: number;

  /** FK -> users.id of the claiming agent; NULL until claimed (ADR-001). */
  @Column({ type: 'int', nullable: true })
  assignedToId: number | null;

  /** Resolution note; required before a ticket may become Resolved. */
  @Column({ type: 'text', nullable: true })
  resolutionNote: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  requester: User;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  assignedTo: User | null;
}

export const TICKET_STATUSES = STATUSES;
