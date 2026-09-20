import { Injectable, Logger } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** How a message actually left the process — reported back to the caller. */
export type MailDelivery = 'webhook' | 'resend' | 'console';

/**
 * Delivery of transactional email (currently only the password-reset link).
 *
 * The project deliberately ships **no mail-server dependency and no credentials**
 * (same spirit as the AI intake's offline fallback and the zero-setup SQLite
 * database): out of the box every message is written to the backend console, so
 * the "forgot password" flow is fully usable in development with nothing
 * installed. Operators who want real delivery configure one environment
 * variable — the service itself never changes:
 *
 *  - `MAIL_WEBHOOK_URL` — POSTs `{ to, subject, text }` as JSON to any HTTPS
 *    endpoint that accepts the payload (an internal relay, Zapier, a serverless
 *    function…). `MAIL_WEBHOOK_TOKEN` adds `Authorization: Bearer <token>`.
 *  - `RESEND_API_KEY` — POSTs to Resend's HTTP API
 *    (<https://api.resend.com/emails>) from `MAIL_FROM`, no SDK required.
 *
 * A provider failure is logged and then falls back to the console, so a missing
 * or misconfigured mail provider can never break account recovery (it only ever
 * changes *how* the link reaches the person).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly webhookUrl = process.env.MAIL_WEBHOOK_URL;
  private readonly webhookToken = process.env.MAIL_WEBHOOK_TOKEN;
  private readonly resendApiKey = process.env.RESEND_API_KEY;
  private readonly from =
    process.env.MAIL_FROM ?? 'Eurisko Hub <no-reply@eurisko.local>';

  async send(message: MailMessage): Promise<MailDelivery> {
    if (!this.webhookUrl && !this.resendApiKey && process.env.NODE_ENV === 'production') {
      // Never let a production deployment believe email was sent when the only
      // copy of a password-reset link is in the server log.
      this.logger.warn(
        'No mail provider is configured in production (set MAIL_WEBHOOK_URL or RESEND_API_KEY); ' +
          'the message below is only written to this log.',
      );
    }

    if (this.webhookUrl) {
      try {
        await this.postJson(
          this.webhookUrl,
          this.webhookToken ? { Authorization: `Bearer ${this.webhookToken}` } : {},
          { to: message.to, subject: message.subject, text: message.text },
        );
        return 'webhook';
      } catch (err) {
        this.logger.warn(
          `MAIL_WEBHOOK_URL delivery failed (${describe(err)}); falling back to the console.`,
        );
      }
    } else if (this.resendApiKey) {
      try {
        await this.postJson(
          'https://api.resend.com/emails',
          { Authorization: `Bearer ${this.resendApiKey}` },
          {
            from: this.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          },
        );
        return 'resend';
      } catch (err) {
        this.logger.warn(
          `RESEND_API_KEY delivery failed (${describe(err)}); falling back to the console.`,
        );
      }
    }

    this.logger.log(
      `No mail provider configured — printing the message instead.\n` +
        `  To:      ${message.to}\n` +
        `  Subject: ${message.subject}\n` +
        `${message.text}`,
    );
    return 'console';
  }

  private async postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${await res.text()}`.trim());
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
