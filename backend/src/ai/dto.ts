import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * POST /tickets/ai-suggest - v0.4 AI-assisted intake (docs/week4-production-ai.md).
 *
 * The employee's free-form description of the problem. It is only used to ask
 * the AI for a *suggestion*: this request never creates a ticket, and the
 * answer is never written to the database.
 */
export class AiSuggestDto {
  @IsString()
  @MinLength(3)
  text: string;
}

/**
 * POST /ai/classify - the canonical, documented intake contract (docs/api.md
 * "POST /ai/classify", product-spec Week 4).
 *
 * `description` is the documented field name. `text` is accepted as an alias so
 * that the older `/tickets/ai-suggest` callers and a hand-typed `curl` keep
 * working; exactly one of the two must be present, which the controller checks
 * (both are optional here so that a missing field is a clear 400 from the
 * controller rather than a confusing "property should not exist" from the
 * whitelist pipe).
 */
export class AiClassifyDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  text?: string;
}
