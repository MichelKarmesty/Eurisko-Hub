import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
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
 */
export class UpdateStatusDto {
  @IsIn(['In Progress', 'Resolved'])
  status: 'In Progress' | 'Resolved';

  @IsOptional()
  @IsString()
  @MinLength(1)
  resolutionNote?: string;
}
