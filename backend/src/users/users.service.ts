import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './user.entity';
import { Role } from '../common/domain';

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role: Role;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({ where: { email: email.toLowerCase() } });
  }

  async findById(id: number): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  async create(input: CreateUserInput): Promise<User> {
    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = this.users.create({
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash,
      role: input.role,
    });
    return this.users.save(user);
  }

  async updateRole(id: number, role: Role): Promise<User | null> {
    const user = await this.findById(id);
    if (!user) return null;
    user.role = role;
    return this.users.save(user);
  }

  findAll(): Promise<User[]> {
    return this.users.find({ order: { id: 'ASC' } });
  }

  count(): Promise<number> {
    return this.users.count();
  }
}
