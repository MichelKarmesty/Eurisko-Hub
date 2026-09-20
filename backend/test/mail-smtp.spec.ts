/**
 * SMTP transport for the password-reset mail (ADR-005).
 *
 * The client is hand-rolled (no npm dependency), so it is tested against a
 * throwaway SMTP server on localhost: the suite asserts the real conversation
 * (EHLO -> AUTH -> MAIL FROM -> RCPT TO -> DATA) and that a rejected provider
 * degrades to the console instead of breaking account recovery.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service';

interface FakeSmtp {
  port: number;
  /** Raw DATA lines (headers + base64 body), as received. */
  lines: string[];
  /** AUTH command lines, as received. */
  auth: string[];
  /** MAIL FROM / RCPT TO lines, as received. */
  envelope: string[];
  close: () => Promise<void>;
}

/** A throwaway SMTP server that speaks just enough for the client. */
function startFakeSmtp(options: { rejectAuth?: boolean } = {}): Promise<FakeSmtp> {
  const lines: string[] = [];
  const auth: string[] = [];
  const envelope: string[] = [];
  let inData = false;

  const server = net.createServer((socket) => {
    socket.write('220 fake ESMTP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            lines.push(line);
          }
          continue;
        }

        const command = line.split(' ')[0].toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          // No STARTTLS on purpose: the test runs in the clear on localhost.
          socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (command === 'AUTH') {
          auth.push(line);
          socket.write(
            options.rejectAuth
              ? '535 5.7.8 Authentication failed\r\n'
              : '235 2.7.0 Authentication successful\r\n',
          );
        } else if (command === 'MAIL' || command === 'RCPT') {
          envelope.push(line);
          socket.write('250 2.1.0 OK\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        lines,
        auth,
        envelope,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function configureSmtp(port: number, from = 'Eurisko Hub <no-reply@eurisko.test>'): void {
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'support@eurisko.test';
  process.env.SMTP_PASS = 'app-password';
  process.env.MAIL_FROM = from;
  delete process.env.MAIL_WEBHOOK_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NODE_ENV;
}

afterEach(() => {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.MAIL_FROM;
});

/** Pull the base64 body out of the captured DATA lines and decode it. */
function decodeBody(lines: string[]): string {
  const blank = lines.indexOf('');
  const body = (blank === -1 ? [] : lines.slice(blank + 1)).join('');
  return Buffer.from(body, 'base64').toString('utf8');
}

describe('MailService over SMTP', () => {
  it('sends a real SMTP conversation and reports delivery "smtp"', async () => {
    const server = await startFakeSmtp();
    configureSmtp(server.port);
    const mail = new MailService();

    const delivery = await mail.send({
      to: 'employee@gmail.com',
      subject: 'Reset your Eurisko Hub password',
      text: 'Open this link to choose a new password:\nhttp://localhost:5173/?resetToken=abc123\n',
    });

    expect(delivery).toBe('smtp');
    // AUTH PLAIN with the configured identity
    expect(server.auth[0]).toMatch(/^AUTH PLAIN /);
    expect(Buffer.from(server.auth[0].split(' ')[2], 'base64').toString('utf8')).toBe(
      '\0support@eurisko.test\0app-password',
    );
    // Envelope uses the bare addresses
    expect(server.envelope).toContain('MAIL FROM:<no-reply@eurisko.test>');
    expect(server.envelope).toContain('RCPT TO:<employee@gmail.com>');
    // Headers + the exact body (base64 so any UTF-8 survives)
    expect(server.lines[0]).toBe('From: Eurisko Hub <no-reply@eurisko.test>');
    expect(server.lines).toContain('To: employee@gmail.com');
    expect(server.lines).toContain('Subject: Reset your Eurisko Hub password');
    expect(decodeBody(server.lines)).toContain('resetToken=abc123');

    await server.close();
  });

  it('encodes a non-ASCII subject rather than corrupting it', async () => {
    const server = await startFakeSmtp();
    configureSmtp(server.port);
    const mail = new MailService();

    await mail.send({ to: 'a@b.test', subject: 'إعادة تعيين كلمة المرور', text: 'مرحبا' });

    const subject = server.lines.find((l) => l.startsWith('Subject: '));
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?/);
    const encoded = (subject as string).replace('Subject: =?UTF-8?B?', '').replace('?=', '');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('إعادة تعيين كلمة المرور');

    await server.close();
  });

  it('falls back to the console (never throws) when the provider rejects auth', async () => {
    const server = await startFakeSmtp({ rejectAuth: true });
    configureSmtp(server.port);
    const mail = new MailService();

    const delivery = await mail.send({
      to: 'employee@hotmail.com',
      subject: 'Reset your Eurisko Hub password',
      text: 'link',
    });

    expect(delivery).toBe('console');
    expect(server.envelope).toHaveLength(0); // never got past AUTH

    await server.close();
  });
});
