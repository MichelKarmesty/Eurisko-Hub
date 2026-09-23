import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiIntakeService } from '../src/ai/ai-intake.service';

/**
 * Provider resilience (no network): the service must never let a single
 * unreachable endpoint cost the employee the model's answer. These tests mock
 * `fetch`, so they run everywhere and assert *which* endpoints were tried.
 */

const realFetch = globalThis.fetch.bind(globalThis);

const PRIMARY = 'https://primary.test/v1';
const FALLBACK = 'https://fallback.test/v1';

const validAnswer = JSON.stringify({
  category: 'IT',
  priority: 'High',
  title: 'Laptop screen flickering',
  confidence: 0.93,
  relevant: true,
  reason: '',
});

/** A fetch stub that answers per host, and records every URL it was asked for. */
function stubFetch(handlers: Record<string, () => Promise<Response> | Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [host, handler] of Object.entries(handlers)) {
      if (url.startsWith(host)) return handler();
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  return calls;
}

const ok = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

const httpError = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

describe('AI intake provider resilience', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'AI_PROVIDER_URL',
      'AI_FALLBACK_PROVIDER_URL',
      'AI_FALLBACK_API_KEY',
      'AI_API_KEY',
      'AI_MODEL',
      'AI_FALLBACK_MODEL',
      'AI_TIMEOUT_MS',
      'AI_RETRY_DELAY_MS',
      'AI_TOTAL_BUDGET_MS',
      'AI_OFFLINE_FALLBACK',
    ]) {
      saved[key] = process.env[key];
    }
    process.env.AI_PROVIDER_URL = PRIMARY;
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_RETRY_DELAY_MS = '0';
    process.env.AI_TIMEOUT_MS = '1000';
    delete process.env.AI_FALLBACK_PROVIDER_URL;
    delete process.env.AI_FALLBACK_MODEL;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the configured fallback provider when the primary is unreachable', async () => {
    process.env.AI_FALLBACK_PROVIDER_URL = FALLBACK;
    const calls = stubFetch({
      [PRIMARY]: () => {
        throw new TypeError('fetch failed');
      },
      [FALLBACK]: () => ok(validAnswer),
    });

    const result = await new AiIntakeService().suggest('my laptop screen flickers');

    expect(result.source).toBe('ai');
    expect(result.suggestion?.category).toBe('IT');
    expect(calls.some((u) => u.startsWith(PRIMARY))).toBe(true);
    expect(calls.some((u) => u.startsWith(FALLBACK))).toBe(true);
  });

  it('treats Groq as the automatic safety net when a local key is set', async () => {
    // No AI_FALLBACK_PROVIDER_URL: the key belongs to Groq, so Groq is the net.
    const calls = stubFetch({
      [PRIMARY]: () => {
        throw new TypeError('fetch failed');
      },
      'https://api.groq.com/openai/v1': () => ok(validAnswer),
    });

    const result = await new AiIntakeService().suggest('my laptop screen flickers');

    expect(result.source).toBe('ai');
    expect(calls.some((u) => u.startsWith('https://api.groq.com/openai/v1'))).toBe(true);
  });

  it('retries an empty completion on the other endpoint', async () => {
    process.env.AI_FALLBACK_PROVIDER_URL = FALLBACK;
    // The demo-style failure: HTTP 200 with no content at all (all tokens spent
    // on reasoning). The answer must still arrive, from the second endpoint.
    const calls = stubFetch({
      [PRIMARY]: () => ok(''),
      [FALLBACK]: () => ok(validAnswer),
    });

    const result = await new AiIntakeService().suggest('my laptop screen flickers');

    expect(result.source).toBe('ai');
    expect(result.suggestion?.title).toBe('Laptop screen flickering');
    expect(calls.filter((u) => u.startsWith(PRIMARY)).length).toBeGreaterThan(1);
  });

  it('does not retry a rejected key, and reports the offline fallback honestly', async () => {
    process.env.AI_FALLBACK_PROVIDER_URL = FALLBACK;
    const calls = stubFetch({
      [PRIMARY]: () => httpError(401),
      [FALLBACK]: () => httpError(401),
    });

    const result = await new AiIntakeService().suggest('printer is jammed again');

    expect(result.source).toBe('offline');
    expect(result.notice).toMatch(/not from a model/i);
    // 401 is terminal: one attempt per endpoint, no retry loop.
    expect(calls.length).toBe(2);
  });

  it('retries a non-JSON answer on the other endpoint', async () => {
    process.env.AI_FALLBACK_PROVIDER_URL = FALLBACK;
    // A 200 with prose, or JSON truncated by a reasoning model's token budget.
    // The employee must still get the model's answer, from the second endpoint.
    const calls = stubFetch({
      [PRIMARY]: () => ok('Sure! Happy to help. The weather in Beirut is sunny today.'),
      [FALLBACK]: () => ok(validAnswer),
    });

    const result = await new AiIntakeService().suggest('what is the weather in Beirut');

    expect(result.source).toBe('ai');
    expect(result.suggestion?.category).toBe('IT');
    expect(calls.filter((u) => u.startsWith(PRIMARY)).length).toBeGreaterThan(1);
    expect(calls.some((u) => u.startsWith(FALLBACK))).toBe(true);
  });

  it('falls back to the offline classifier, labelled, when nothing answers', async () => {
    const calls = stubFetch({
      [PRIMARY]: () => {
        throw new TypeError('fetch failed');
      },
    });

    const result = await new AiIntakeService().suggest('the printer on floor 2 is jammed');

    expect(result.source).toBe('offline');
    expect(result.suggestion?.category).toBe('IT');
    expect(result.notice).toMatch(/offline keyword classifier/i);
    expect(calls.length).toBeGreaterThan(0);
  });
});
