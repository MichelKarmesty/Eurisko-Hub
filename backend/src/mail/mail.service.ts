import { Injectable, Logger } from '@nestjs/common';
import { smtpSend, type SmtpConfig } from './smtp.client';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** How a message actually left the process - reported back to the caller. */
export type MailDelivery = 'smtp' | 'smtp-alt' | 'webhook' | 'resend' | 'console';

/** One configured SMTP server, with the label it reports when it delivers. */
interface SmtpTransport {
  /** `smtp` for the `SMTP_*` block, `smtp-alt` for the `SMTP_ALT_*` block. */
  delivery: 'smtp' | 'smtp-alt';
  /** Env prefix, used in log messages so the failing provider is obvious. */
  envPrefix: 'SMTP' | 'SMTP_ALT';
  config: SmtpConfig;
}

/**
 * Delivery of transactional email (currently only the password-reset link).
 *
 * The project ships **no mail-server dependency and no credentials** (same spirit
 * as the AI intake's offline fallback and the zero-setup SQLite database): out of
 * the box every message is written to the backend console, so the "forgot
 * password" flow is fully usable in development with nothing installed. For real
 * delivery, configure **any** of these - the service itself never changes, and the
 * first configured transport that works wins, in this order:
 *
 *  1. `SMTP_HOST` - a standard mail server, so Gmail, Outlook/Hotmail, a company
 *     server or any SMTP provider works. `SMTP_PORT` (default 587), `SMTP_SECURE`
 *     (default true only for 465 - implicit TLS; 587 uses STARTTLS),
 *     `SMTP_USER` / `SMTP_PASS` (an app password where 2FA is on) and the
 *     `MAIL_FROM` address (override per provider with `SMTP_FROM`). Implemented by
 *     a tiny built-in client (`smtp.client.ts`) - no npm dependency.
 *  2. `SMTP_ALT_HOST` - a **second** SMTP server, tried when the first one fails
 *     (e.g. Gmail as the primary sender and Outlook as the backup, or vice versa).
 *     Same variables with the `SMTP_ALT_` prefix: `SMTP_ALT_PORT`,
 *     `SMTP_ALT_SECURE`, `SMTP_ALT_USER`, `SMTP_ALT_PASS` and `SMTP_ALT_FROM`
 *     (defaults to `MAIL_FROM`). Its own `From` matters: Gmail rewrites a
 *     mismatched sender to the authenticated account, and some servers reject it
 *     outright, so set `SMTP_ALT_FROM` to the alternate account's own address.
 *  3. `MAIL_WEBHOOK_URL` - POSTs `{ to, subject, text }` as JSON to any HTTPS
 *     endpoint that accepts the payload (an internal relay, Zapier, a serverless
 *     function…). `MAIL_WEBHOOK_TOKEN` adds `Authorization: Bearer <token>`.
 *  4. `RESEND_API_KEY` - POSTs to Resend's HTTP API
 *     (<https://api.resend.com/emails>) from `MAIL_FROM`, no SDK required.
 *
 * A provider failure is logged and then the next transport (finally the console)
 * is tried, so a missing or misconfigured provider can never break account
 * recovery - it only ever changes *how* the link reaches the person.
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
    const smtps = this.smtpTransports();

    if (
      smtps.length === 0 &&
      !this.webhookUrl &&
      !this.resendApiKey &&
      process.env.NODE_ENV === 'production'
    ) {
      // Never let a production deployment believe email was sent when the only
      // copy of a password-reset link is in the server log.
      this.logger.warn(
        'No mail provider is configured in production (set SMTP_HOST, SMTP_ALT_HOST, ' +
          'MAIL_WEBHOOK_URL or RESEND_API_KEY); the message below is only written to this log.',
      );
    }

    for (const transport of smtps) {
      try {
        await smtpSend(message, transport.config);
        return transport.delivery;
      } catch (err) {
        this.logger.warn(
          `${transport.envPrefix} delivery failed via ${transport.config.host} ` +
            `(${describe(err)}); trying the next transport.`,
        );
      }
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
          `MAIL_WEBHOOK_URL delivery failed (${describe(err)}); trying the next transport.`,
        );
      }
    }

    if (this.resendApiKey) {
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

  /**
   * Every configured SMTP transport, in the order they are tried: the `SMTP_*`
   * block first, then the `SMTP_ALT_*` backup (ADR-008). See the class comment.
   */
  private smtpTransports(): SmtpTransport[] {
    const transports: SmtpTransport[] = [];

    const primary = this.readSmtp('SMTP', this.from);
    if (primary) transports.push({ delivery: 'smtp', envPrefix: 'SMTP', config: primary });

    const alternate = this.readSmtp('SMTP_ALT', process.env.SMTP_ALT_FROM ?? this.from);
    if (alternate) {
      transports.push({ delivery: 'smtp-alt', envPrefix: 'SMTP_ALT', config: alternate });
    }

    return transports;
  }

  /** Read one `PREFIX_*` SMTP block, or null when `PREFIX_HOST` is unset. */
  private readSmtp(
    prefix: 'SMTP' | 'SMTP_ALT',
    fallbackFrom: string,
  ): SmtpConfig | null {
    const host = process.env[`${prefix}_HOST`];
    if (!host) return null;

    const parsedPort = Number(process.env[`${prefix}_PORT`] ?? 587);
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587;
    const secure =
      (process.env[`${prefix}_SECURE`] ?? String(port === 465)).toLowerCase() === 'true';

    const parsedTimeout = Number(
      process.env[`${prefix}_TIMEOUT_MS`] ?? process.env.SMTP_TIMEOUT_MS ?? 20000,
    );

    return {
      host,
      port,
      secure,
      user: process.env[`${prefix}_USER`],
      pass: process.env[`${prefix}_PASS`],
      from: process.env[`${prefix}_FROM`] ?? fallbackFrom,
      timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 20000,
    };
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
