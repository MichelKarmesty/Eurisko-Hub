/**
 * SMTP transport for the password-reset mail (ADR-005).
 *
 * The client is hand-rolled (no npm dependency), so it is tested against a
 * throwaway SMTP server on localhost: the suite asserts the real conversation
 * (EHLO -> AUTH -> MAIL FROM -> RCPT TO -> DATA) and that a rejected provider
 * degrades to the console instead of breaking account recovery.
 */
import http from 'node:http';
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

/** Configure the SECOND sender (the `SMTP_ALT_*` block, ADR-008). */
function configureAltSmtp(port: number, from: string): void {
  process.env.SMTP_ALT_HOST = '127.0.0.1';
  process.env.SMTP_ALT_PORT = String(port);
  process.env.SMTP_ALT_SECURE = 'false';
  process.env.SMTP_ALT_USER = 'backup@eurisko.test';
  process.env.SMTP_ALT_PASS = 'backup-app-password';
  process.env.SMTP_ALT_FROM = from;
}

afterEach(() => {
  for (const key of [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
    'MAIL_FROM',
    'SMTP_ALT_HOST',
    'SMTP_ALT_PORT',
    'SMTP_ALT_SECURE',
    'SMTP_ALT_USER',
    'SMTP_ALT_PASS',
    'SMTP_ALT_FROM',
    'MAIL_WEBHOOK_URL',
    'MAIL_WEBHOOK_TOKEN',
    'RESEND_API_KEY',
  ]) {
    delete process.env[key];
  }
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

  // --- Two senders: the SMTP_ALT_* backup (ADR-008) ----------------------

  it('uses the second sender when the first one refuses the login', async () => {
    const primary = await startFakeSmtp({ rejectAuth: true });
    const backup = await startFakeSmtp();
    configureSmtp(primary.port, 'Eurisko Hub <reset@gmail.test>');
    configureAltSmtp(backup.port, 'Eurisko Hub <reset@outlook.test>');
    const mail = new MailService();

    const delivery = await mail.send({
      to: 'employee@gmail.com',
      subject: 'Reset your Eurisko Hub password',
      text: 'Open this link:\nhttp://localhost:5173/?resetToken=abc123\n',
    });

    // The message left through the backup, over a real SMTP conversation…
    expect(delivery).toBe('smtp-alt');
    expect(backup.envelope).toContain('MAIL FROM:<reset@outlook.test>');
    expect(backup.envelope).toContain('RCPT TO:<employee@gmail.com>');
    // …authenticated as the backup account, from the backup's own address.
    expect(backup.auth[0]).toMatch(/^AUTH PLAIN /);
    expect(Buffer.from(backup.auth[0].split(' ')[2], 'base64').toString('utf8')).toBe(
      '\0backup@eurisko.test\0backup-app-password',
    );
    expect(backup.lines[0]).toBe('From: Eurisko Hub <reset@outlook.test>');
    expect(decodeBody(backup.lines)).toContain('resetToken=abc123');
    // The primary was tried first and got nowhere.
    expect(primary.envelope).toHaveLength(0);

    await primary.close();
    await backup.close();
  });

  it('reports the second sender as "smtp-alt" and uses it when it is the only one', async () => {
    const backup = await startFakeSmtp();
    // No SMTP_HOST at all: only the alternate block is configured.
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM;
    configureAltSmtp(backup.port, 'Eurisko Hub <reset@outlook.test>');
    const mail = new MailService();

    const delivery = await mail.send({ to: 'a@b.test', subject: 's', text: 'link' });

    expect(delivery).toBe('smtp-alt');
    expect(backup.envelope).toContain('RCPT TO:<a@b.test>');

    await backup.close();
  });

  // --- The non-SMTP transports (ADR-008) ---------------------------------

  it('delivers through MAIL_WEBHOOK_URL (with the optional bearer token)', async () => {
    const received: Array<{ url?: string; auth?: string; body: any }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        received.push({
          url: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(raw),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const { port } = server.address() as { port: number };

    process.env.MAIL_WEBHOOK_URL = `http://127.0.0.1:${port}/relay`;
    process.env.MAIL_WEBHOOK_TOKEN = 'relay-secret';
    delete process.env.SMTP_HOST;

    try {
      const mail = new MailService();
      const delivery = await mail.send({
        to: 'employee@gmail.com',
        subject: 'Reset your Eurisko Hub password',
        text: 'link',
      });

      expect(delivery).toBe('webhook');
      expect(received).toHaveLength(1);
      expect(received[0].url).toBe('/relay');
      expect(received[0].auth).toBe('Bearer relay-secret');
      expect(received[0].body).toEqual({
        to: 'employee@gmail.com',
        subject: 'Reset your Eurisko Hub password',
        text: 'link',
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('delivers through the Resend HTTP API when RESEND_API_KEY is set', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const realFetch = global.fetch;
    global.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response('{"id":"test"}', { status: 200 });
    }) as typeof fetch;

    process.env.RESEND_API_KEY = 're_test_key';
    process.env.MAIL_FROM = 'Eurisko Hub <onboarding@resend.dev>';
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_WEBHOOK_URL;

    try {
      const mail = new MailService();
      const delivery = await mail.send({ to: 'me@gmail.com', subject: 's', text: 't' });

      expect(delivery).toBe('resend');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.resend.com/emails');
      expect(calls[0].init.headers.Authorization).toBe('Bearer re_test_key');
      expect(JSON.parse(calls[0].init.body)).toMatchObject({
        from: 'Eurisko Hub <onboarding@resend.dev>',
        to: ['me@gmail.com'],
        subject: 's',
        text: 't',
      });
    } finally {
      global.fetch = realFetch;
    }
  });
});
