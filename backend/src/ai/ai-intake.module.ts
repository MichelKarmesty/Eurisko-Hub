import { Module } from '@nestjs/common';
import { AiIntakeController } from './ai-intake.controller';
import { AiIntakeService } from './ai-intake.service';

/**
 * v0.4 - AI-assisted intake module (docs/week4-production-ai.md).
 *
 * Deliberately has no TypeORM import: the feature is advisory, so it must not
 * be able to touch the database. That is a design statement, not an oversight -
 * the only writer of tickets remains TicketsService.
 */
@Module({
  controllers: [AiIntakeController],
  providers: [AiIntakeService],
  exports: [AiIntakeService],
})
export class AiIntakeModule {}
