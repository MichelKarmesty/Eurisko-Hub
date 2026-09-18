import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AiSuggestDto } from './dto';
import { AiIntakeResult, AiIntakeService } from './ai-intake.service';

/**
 * v0.4 — POST /tickets/ai-suggest (docs/week4-production-ai.md).
 *
 * Advisory, authenticated, side-effect free: it returns a suggestion and does
 * nothing else. It shares the `/tickets` prefix with TicketsController (the
 * product's vocabulary, docs/api.md) but adds no route the existing contract
 * relies on — `POST /tickets` is still the only way a ticket is created.
 *
 * There is no `@Roles(...)`: authentication is enough, because any signed-in
 * employee may open a request and therefore may ask for a suggestion. The
 * global JwtAuthGuard still requires a valid bearer token (401 otherwise).
 */
@Controller('tickets')
export class AiIntakeController {
  constructor(private readonly ai: AiIntakeService) {}

  /** POST /tickets/ai-suggest — `{ text }` -> `{ suggestion }` (or a graceful error). */
  @Post('ai-suggest')
  @HttpCode(HttpStatus.OK)
  suggest(@Body() dto: AiSuggestDto): Promise<AiIntakeResult> {
    return this.ai.suggest(dto.text);
  }
}
