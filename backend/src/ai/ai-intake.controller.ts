import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Category, Priority } from '../common/domain';
import { AiIntakeResult, AiIntakeService } from './ai-intake.service';
import { AiClassifyDto, AiSuggestDto } from './dto';

/**
 * v0.4 - POST /tickets/ai-suggest (docs/week4-production-ai.md).
 *
 * Advisory, authenticated, side-effect free: it returns a suggestion and does
 * nothing else. It shares the `/tickets` prefix with TicketsController (the
 * product's vocabulary, docs/api.md) but adds no route the existing contract
 * relies on - `POST /tickets` is still the only way a ticket is created.
 *
 * There is no `@Roles(...)`: authentication is enough, because any signed-in
 * employee may open a request and therefore may ask for a suggestion. The
 * global JwtAuthGuard still requires a valid bearer token (401 otherwise).
 */
@Controller('tickets')
export class AiIntakeController {
  constructor(private readonly ai: AiIntakeService) {}

  /** POST /tickets/ai-suggest - `{ text }` -> `{ suggestion }` (or a graceful error). */
  @Post('ai-suggest')
  @HttpCode(HttpStatus.OK)
  suggest(@Body() dto: AiSuggestDto): Promise<AiIntakeResult> {
    return this.ai.suggest(dto.text);
  }
}

/**
 * The **flat** classification contract the Week-4 spec and the defense scripts
 * use: `{ category, priority, title, relevant, reason, source }`.
 *
 * Why a second route rather than changing the first one: `POST
 * /tickets/ai-suggest` returns a nested `{ suggestion, source, notice }` object
 * that the shipped React form already consumes, and a nested shape is better
 * for the UI (it carries the offline notice and the confidence together). The
 * documented external contract, however, is flat. Rather than break one to
 * satisfy the other, both routes call the **same** advisory service - there is
 * exactly one classifier, one validation path and one set of rules - and only
 * the envelope differs. Both are read-only: neither can create a ticket.
 */
export interface AiClassification {
  category: Category | null;
  priority: Priority | null;
  title: string | null;
  relevant: boolean;
  reason: string;
  confidence: number | null;
  /** `ai` = a model answered; `offline` = the labelled keyword classifier. */
  source: 'ai' | 'offline';
  notice?: string;
  error?: string;
}

@Controller('ai')
export class AiClassifyController {
  constructor(private readonly ai: AiIntakeService) {}

  /**
   * POST /ai/classify - any authenticated user.
   *
   * Status codes: `200` with a classification whenever a suggestion exists
   * (including `relevant: false`, which says "I could not read a request here"
   * - a successful call), `400` when `description`/`text` is missing or too
   * short, `503` when the feature is off or no provider answered and the offline
   * fallback is disabled, `401` without a valid token.
   */
  @Post('classify')
  @HttpCode(HttpStatus.OK)
  async classify(@Body() dto: AiClassifyDto): Promise<AiClassification> {
    const text = (dto.description ?? dto.text ?? '').trim();
    if (!text) {
      throw new BadRequestException('description is required');
    }

    const result = await this.ai.suggest(text);

    if (!result.suggestion) {
      // AI_ENABLED=false, or the provider failed with AI_OFFLINE_FALLBACK=false.
      // Honest 503 rather than a fabricated suggestion: the app itself keeps
      // working, the employee simply types the fields by hand.
      throw new ServiceUnavailableException(
        result.error ?? 'AI intake is unavailable',
      );
    }

    const suggestion = result.suggestion;
    return {
      category: suggestion.category,
      priority: suggestion.priority,
      title: suggestion.title,
      relevant: suggestion.relevant,
      reason: suggestion.reason ?? '',
      confidence: suggestion.confidence,
      // Never claim the model's work for the rules': absent means offline.
      source: result.source === 'ai' ? 'ai' : 'offline',
      ...(result.notice ? { notice: result.notice } : {}),
    };
  }
}
