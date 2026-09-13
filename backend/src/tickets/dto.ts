import { IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { CATEGORIES, Category, PRIORITIES, Priority } from '../common/domain';

/** POST /tickets — requester submits a ticket (product-spec.md §3). */
export class CreateTicketDto {
  @IsString()
  @MinLength(3)
  title: string;

  @IsString()
  @MinLength(3)
  description: string;

  @IsIn(CATEGORIES)
  category: Category;

  @IsIn(PRIORITIES)
  priority: Priority;
}

/**
 * PATCH /tickets/:id/status — advance the documented lifecycle
 * (Open -> In Progress -> Resolved). Moving to Resolved requires a
 * non-empty resolutionNote (data-model.md §2). Claiming an Open ticket is
 * done via PATCH /tickets/:id/claim (ADR-001).
 *
 * ADR-002: when an Admin changes a ticket that is NOT assigned to them, the
 * change is an override and `overrideReason` is required — it is recorded as
 * an ADMIN_OVERRIDE history event so an unclaimed ticket is never silently
 * closed.
 */
export class UpdateStatusDto {
  @IsIn(['In Progress', 'Resolved'])
  status: 'In Progress' | 'Resolved';

  @IsOptional()
  @IsString()
  @MinLength(1)
  resolutionNote?: string;

  /** Required for an Admin acting on a ticket not assigned to them (ADR-002). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  overrideReason?: string;
}

/**
 * PATCH /tickets/:id/assign — an Admin gives an unclaimed ticket an owner by
 * assigning it to an agent of the matching department (ADR-003). This is the
 * normal, non-override way to get urgent work moving.
 */
export class AssignTicketDto {
  @IsInt()
  @Min(1)
  assigneeId: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  note?: string;
}

/**
 * PATCH /tickets/:id/cancel — an Admin retires a request that should not be
 * worked (duplicate, obsolete, withdrawn). Soft by design: the ticket and its
 * history are kept, never hard-deleted (ADR-003).
 */
export class CancelTicketDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
