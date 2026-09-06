import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { CreateTicketDto, UpdateStatusDto } from './dto';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  /** POST /tickets — any authenticated user opens a ticket in their name. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.tickets.create(user, dto);
  }

  /** GET /tickets — RBAC-scoped list (see TicketsService.list). */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.tickets.list(user, query);
  }

  /** GET /tickets/:id — requester, matching agent, or admin. */
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.tickets.getById(id, user);
  }

  /** GET /tickets/:id/history — durable event log for the ticket. */
  @Get(':id/history')
  history(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.history(id, user);
  }

  /**
   * ADR-001: PATCH /tickets/:id/claim — an agent claims an OPEN ticket from
   * their department's queue (sets assigned_to; status -> In Progress).
   */
  @Patch(':id/claim')
  @HttpCode(HttpStatus.OK)
  claim(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.tickets.claim(id, user);
  }

  /**
   * PATCH /tickets/:id/status — assigned agent (or Admin) advances the
   * lifecycle (In Progress -> Resolved; note required to resolve).
   */
  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.tickets.changeStatus(id, user, dto.status, dto.resolutionNote);
  }
}

/** Admin dashboard (product-spec.md: admin sees every ticket company-wide). */
@Controller('admin')
@Roles('Admin')
export class AdminController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('stats')
  stats() {
    return this.tickets.adminStats();
  }
}
