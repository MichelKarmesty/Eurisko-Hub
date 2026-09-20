import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Transactional email delivery. Kept in its own module (like the AI intake
 * module) so it can be injected anywhere without dragging in feature modules.
 * It has no database access and never throws on a delivery failure.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
