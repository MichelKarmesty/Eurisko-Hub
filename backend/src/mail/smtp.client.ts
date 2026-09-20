import net from 'node:net';
import tls from 'node:tls';

/**
 * A very small, dependency-free SMTP client.
 *
 * Why hand-rolled? The rest of this project deliberately ships no mail-server
 * dependency (see MailService), and Gmail / Outlook / any standard mail server
 * speaks plain SMTP with AUTH + TLS. This covers exactly that:
 *
 *  - implicit TLS (port 465, `SMTP_SECURE=true`)
 *  - STARTTLS (port 587, the default — upgraded after EHLO)
 *  - AUTH PLAIN, falling back to AUTH LOGIN
 *  - a UTF-8 plain-text message, base64-encoded (no dot-stuffing needed)
 *
 * It is intentionally narrow: transactional one-recipient text mail only.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  timeoutMs: number;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
}

const CRLF = '\r\n';

/** Strip CR/LF so a header value can never inject another header. */
const headerSafe = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 encode a header only when it is not plain ASCII. */
const encodeHeader = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

/** Base64 the body, wrapped at 76 columns, so no line can start with ".". */
const encodeBody = (text: string): string => {
  const b64 = Buffer.from(text.replace(/\r?\n/g, CRLF), 'utf8').toString('base64');
  return (b64.match(/.{1,76}/g) ?? []).join(CRLF);
};

const bareAddress = (value: string): string => {
  const angled = /<\s*([^>]+)\s*>/.exec(value);
  return (angled ? angled[1] : value).trim();
};

/** A line-oriented reader with a multi-line SMTP response helper. */
class LineReader {
  private buffer = '';
  private queue: string[] = [];
  private failure: Error | null = null;
  private waiting: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;

  constructor(socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf(CRLF)) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + CRLF.length);
      if (this.waiting) {
        const { resolve } = this.waiting;
        this.waiting = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    }
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = null;
      reject(this.failure);
    }
  }

  next(): Promise<string> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as string);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  /** Read one full response, joining "250-…" continuation lines (keeps their text). */
  async response(): Promise<string> {
    let line = await this.next();
    const code = line.slice(0, 3);
    const parts = [line.slice(4)];
    while (line.length >= 4 && line[3] === '-') {
      line = await this.next();
      parts.push(line.slice(4));
    }
    return `${code} ${parts.join(' ')}`;
  }
}

class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private reader: LineReader;
  private capabilities = '';

  constructor(private readonly cfg: SmtpConfig) {
    this.socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    this.socket.setTimeout(cfg.timeoutMs, () => {
      this.socket.destroy(new Error(`SMTP timeout after ${cfg.timeoutMs}ms`));
    });
    this.reader = new LineReader(this.socket);
  }

  private write(line: string): void {
    this.socket.write(line + CRLF);
  }

  /** Send a command and require one of `expect` codes in the reply. */
  private async command(line: string, expect: number[]): Promise<string> {
    this.write(line);
    return this.expect(expect);
  }

  private async expect(codes: number[]): Promise<string> {
    const reply = await this.reader.response();
    const code = Number(reply.slice(0, 3));
    if (!codes.includes(code)) throw new Error(`SMTP unexpected reply: ${reply}`);
    return reply;
  }

  private async ehlo(): Promise<string> {
    const reply = await this.command('EHLO eurisko-hub', [250]);
    this.capabilities = reply;
    return reply;
  }

  private async upgradeToTls(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const upgraded = tls.connect(
        { socket: this.socket, servername: this.cfg.host },
        () => resolve(),
      );
      upgraded.once('error', reject);
      this.socket = upgraded;
      this.reader = new LineReader(upgraded);
    });
    // The server resets its state after STARTTLS, so greet it again.
    await this.ehlo();
  }

  private async authenticate(): Promise<void> {
    const { user, pass } = this.cfg;
    if (!user) return;

    // Prefer whichever mechanism the server actually advertises, so we never
    // burn a failed attempt (some servers lock the account after a few).
    const advertised = /AUTH\s+([A-Z0-9 _-]+)/i.exec(this.capabilities)?.[1]?.toUpperCase() ?? '';
    const offersPlain = advertised.includes('PLAIN');
    const offersLogin = advertised.includes('LOGIN');
    if (advertised && !offersPlain && !offersLogin) {
      throw new Error(`SMTP server offers no supported AUTH mechanism (${advertised})`);
    }

    const plain = async () => {
      const token = Buffer.from(`\0${user}\0${pass ?? ''}`, 'utf8').toString('base64');
      await this.command(`AUTH PLAIN ${token}`, [235]);
    };
    const login = async () => {
      await this.command('AUTH LOGIN', [334]);
      await this.command(Buffer.from(user, 'utf8').toString('base64'), [334]);
      await this.command(Buffer.from(pass ?? '', 'utf8').toString('base64'), [235]);
    };

    if (offersLogin && !offersPlain) return login();
    try {
      await plain();
    } catch {
      // Not every server implements PLAIN; LOGIN is the other universal one.
      await login();
    }
  }

  private buildMessage(message: SmtpMessage): string {
    const headers = [
      `From: ${headerSafe(this.cfg.from)}`,
      `To: ${headerSafe(message.to)}`,
      `Subject: ${encodeHeader(headerSafe(message.subject))}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].join(CRLF);
    return `${headers}${CRLF}${CRLF}${encodeBody(message.text)}`;
  }

  async send(message: SmtpMessage): Promise<void> {
    await this.expect([220]);
    const greeting = await this.ehlo();

    if (!this.cfg.secure && /STARTTLS/i.test(greeting)) {
      await this.command('STARTTLS', [220]);
      await this.upgradeToTls();
    }

    await this.authenticate();
    await this.command(`MAIL FROM:<${bareAddress(this.cfg.from)}>`, [250]);
    await this.command(`RCPT TO:<${bareAddress(message.to)}>`, [250, 251]);
    await this.command('DATA', [354]);
    await this.command(`${this.buildMessage(message)}${CRLF}.`, [250]);
    try {
      await this.command('QUIT', [221]);
    } catch {
      // A server that drops the connection after accepting the message is fine.
    }
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export async function smtpSend(message: SmtpMessage, cfg: SmtpConfig): Promise<void> {
  const session = new SmtpSession(cfg);
  try {
    await session.send(message);
  } catch (err) {
    session.destroy();
    throw err;
  }
}
