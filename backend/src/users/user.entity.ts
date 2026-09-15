import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Role } from '../common/domain';

/** docs/data-model.md §1 — User: login credentials + one defined role. */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  /** bcrypt hash — never exposed by the API. */
  @Exclude()
  @Column()
  passwordHash: string;

  @Column({ type: 'text' })
  role: Role;

  /**
   * Account removal (Admin action, `DELETE /users/:id`).
   *
   * An account with NO history at all (no ticket opened, no event recorded) is
   * hard-deleted — the row is really gone. An account that already has tickets
   * or history is kept for audit and marked inactive: it disappears from the
   * Users list and can no longer sign in, exactly like a deleted account, while
   * the tickets/history it is attached to stay intact (the same "never destroy
   * the audit trail" principle as ADR-003's soft `Cancelled`).
   */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
