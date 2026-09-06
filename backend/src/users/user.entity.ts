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

  @CreateDateColumn()
  createdAt: Date;
}
