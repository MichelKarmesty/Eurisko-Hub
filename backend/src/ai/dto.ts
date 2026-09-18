import { IsString, MinLength } from 'class-validator';

/**
 * POST /tickets/ai-suggest — v0.4 AI-assisted intake (docs/week4-production-ai.md).
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
