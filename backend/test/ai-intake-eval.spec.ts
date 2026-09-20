/**
 * v0.4 — AI INTAKE EVAL (docs/week4-production-ai.md §"Eval results").
 *
 * Eight eval cases for the AI-assisted Request Intake capability, in two
 * groups with deliberately different guarantees:
 *
 *   Cases 1–5 — behaviour against a REAL provider. No local installation is
 *   required: the default provider is Groq's free OpenAI-compatible API
 *   (https://api.groq.com/openai/v1), which needs only a free `AI_API_KEY`
 *   from console.groq.com. If no provider answers (no key, no network) these
 *   cases skip gracefully instead of failing — a paid provider is never
 *   required. When a provider *does* answer they also require the configured
 *   `AI_MODEL` to actually reply (`source: "ai"`): a retired or misspelled
 *   model name must not hide behind the offline fallback. They assert what the
 *   product promises — the suggestion is always inside the domain enums and
 *   always usable — rather than exact wording from a specific model, which
 *   would be flaky and would pin the eval to one LLM. A local Ollama works
 *   too: AI_PROVIDER_URL=http://localhost:11434/v1.
 *
 *   Cases 6–8 — the safety net, fully mocked and therefore deterministic and
 *   always run: whatever the model returns (garbage, wrong enums, wrong types)
 *   the validation layer emits valid values, and a dead provider produces a
 *   graceful fallback instead of an exception.
 *
 * Run:  cd backend && npm run test:ai-eval
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORIES, PRIORITIES } from '../src/common/domain';
import {
  AiIntakeService,
  classifyOffline,
  coerceSuggestion,
  titleFromText,
  type AiIntakeResult,
} from '../src/ai/ai-intake.service';

const realFetch = globalThis.fetch.bind(globalThis);

const PROVIDER_URL = (process.env.AI_PROVIDER_URL ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const MODEL = process.env.AI_MODEL ?? 'openai/gpt-oss-20b';

const service = new AiIntakeService();

/** Is a real OpenAI-compatible provider answering right now? */
let providerAvailable = false;

beforeAll(async () => {
  // Cloud APIs (Groq) and local models both get a little room to answer.
  process.env.AI_TIMEOUT_MS = process.env.AI_TIMEOUT_MS ?? '15000';

  // Groq requires the key on every call — including this probe, otherwise it
  // answers 401 and the real cases would always skip.
  const apiKey = process.env.AI_API_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const probe = await realFetch(`${PROVIDER_URL}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    providerAvailable = probe.ok;
  } catch {
    providerAvailable = false;
  } finally {
    clearTimeout(timer);
  }

  if (!providerAvailable) {
    // eslint-disable-next-line no-console
    console.info(
      `[ai-eval] No AI provider answered at ${PROVIDER_URL} — cases 1–5 will be skipped ` +
        '(cases 6–8 are mocked and always run). Set AI_API_KEY with a free key from ' +
        'console.groq.com, or point AI_PROVIDER_URL at a local Ollama ' +
        '(http://localhost:11434/v1), to run them for real.',
    );
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  lastRequest = null;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** The last request the service made, so the provider contract can be asserted. */
let lastRequest: { url: string; init?: RequestInit } | null = null;

/** Replace fetch with a canned chat-completion response. */
function stubProvider(content: string, ok = true, status = 200) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastRequest = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    };
    return {
      ok,
      status,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as typeof fetch;
}

/** Replace fetch with a provider that cannot be reached. */
function stubProviderDown(message = 'ECONNREFUSED api.groq.com:443') {
  globalThis.fetch = (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** Every suggestion the product can ever emit must be usable as-is. */
function expectUsable(result: AiIntakeResult, label: string): NonNullable<AiIntakeResult['suggestion']> {
  expect(result.suggestion, `${label}: expected a suggestion`).not.toBeNull();
  const suggestion = result.suggestion as NonNullable<AiIntakeResult['suggestion']>;
  expect(CATEGORIES, `${label}: category must come from CATEGORIES`).toContain(suggestion.category);
  expect(PRIORITIES, `${label}: priority must come from PRIORITIES`).toContain(suggestion.priority);
  expect(typeof suggestion.title, `${label}: title must be a string`).toBe('string');
  expect(suggestion.title.trim().length, `${label}: title must be non-empty`).toBeGreaterThanOrEqual(3);
  expect(Number.isFinite(suggestion.confidence), `${label}: confidence must be a number`).toBe(true);
  expect(suggestion.confidence).toBeGreaterThanOrEqual(0);
  expect(suggestion.confidence).toBeLessThanOrEqual(1);
  // Visible in the eval output so a human can judge the real model's answers.
  // eslint-disable-next-line no-console
  console.info(
    `[ai-eval] ${label}: ${suggestion.category} / ${suggestion.priority} / ` +
      `"${suggestion.title}" (confidence ${suggestion.confidence})`,
  );
  return suggestion;
}

/**
 * A real-provider answer: usable AND genuinely from the model. Without this, a
 * retired or misspelled `AI_MODEL` falls back to the offline classifier and
 * still "passes" — the exact silent failure this guards against.
 */
function expectModelAnswer(result: AiIntakeResult, label: string): NonNullable<AiIntakeResult['suggestion']> {
  const suggestion = expectUsable(result, label);
  expect(result.source, `${label}: the model must answer, not the offline fallback`).toBe('ai');
  return suggestion;
}

describe('AI intake eval — real provider (skips when no provider is running)', () => {
  it('1. clear IT report -> IT, with a usable priority and title', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectModelAnswer(
      await service.suggest('My monitor is broken and I need a replacement'),
      'clear IT',
    );
    expect(suggestion.category).toBe('IT');
    // Urgency is a judgement call, so the eval asserts a valid priority rather
    // than pinning one exact value from a particular model.
  });

  it('2. clear HR request -> HR', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectModelAnswer(
      await service.suggest('I need to update my emergency contact information'),
      'clear HR',
    );
    expect(suggestion.category).toBe('HR');
  });

  it('3. clear Maintenance report -> Maintenance', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectModelAnswer(
      await service.suggest('The AC in conference room B is not working'),
      'clear Maintenance',
    );
    expect(suggestion.category).toBe('Maintenance');
  });

  it('4. thin input still yields a valid category and priority (low confidence is fine)', async ({ skip }) => {
    if (!providerAvailable) skip();
    expectModelAnswer(await service.suggest('help'), 'thin input');
    expectModelAnswer(await service.suggest('something is wrong'), 'thin input (second wording)');
  });

  it('5. mixed signals resolve to exactly one valid category', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectModelAnswer(
      await service.suggest(
        'The office door lock is broken and I also need HR to update my badge',
      ),
      'mixed signals',
    );
    // Either department is defensible; what must never happen is an invented one.
    expect(CATEGORIES).toContain(suggestion.category);
  });
});

describe('AI intake eval — validation and failure handling (mocked, always runs)', () => {
  it('6. the validation layer emits domain values for any AI output', () => {
    const hostileInputs: unknown[] = [
      null,
      undefined,
      'not an object',
      42,
      [],
      {},
      { category: 'Finance', priority: 'Urgent' },
      { category: 'finance', priority: 'high' },
      { category: 7, priority: null, title: 12, confidence: 'lots' },
      { category: 'IT', priority: 'Urgent', title: '', confidence: -3 },
      { category: 'Maintenance' },
      { category: null, priority: 'Medium' },
    ];

    for (const value of hostileInputs) {
      const suggestion = coerceSuggestion(value, 'the printer is jammed again');
      expect(CATEGORIES, `input ${JSON.stringify(value)}`).toContain(suggestion.category);
      expect(PRIORITIES, `input ${JSON.stringify(value)}`).toContain(suggestion.priority);
      expect(suggestion.title.length).toBeGreaterThanOrEqual(3);
      expect(Number.isFinite(suggestion.confidence)).toBe(true);
      expect(suggestion.confidence).toBeGreaterThanOrEqual(0);
      expect(suggestion.confidence).toBeLessThanOrEqual(1);
    }

    // The documented defaults when nothing usable came back.
    expect(coerceSuggestion(null, 'x')).toMatchObject({ category: 'IT', priority: 'Medium' });
    // And a title is always derivable from the employee's own words.
    expect(titleFromText('')).toBe('New request');
    expect(titleFromText('the printer is jammed')).toBe('The printer is jammed');

    // The offline classifier (the no-model fallback) is held to the same rule.
    // It is multilingual on purpose: the employees write in English, Arabic
    // (with the definite article glued on) and French (accents stripped).
    const offlineCases: Array<[string, 'IT' | 'HR' | 'Maintenance']> = [
      ['my laptop screen is flickering', 'IT'],
      ['the printer on floor 2 is jammed', 'IT'],
      ['I need to update my emergency contact', 'HR'],
      ['when does my contract get renewed', 'HR'],
      ['the AC in conference room B is not working', 'Maintenance'],
      ['the door lock is broken', 'Maintenance'],
      // Arabic
      ['اللابتوب ما عم يشتغل', 'IT'],
      ['المكيف بالغرفة ما عم يبرّد', 'Maintenance'],
      ['اللمبة محروقة بال corridor', 'Maintenance'],
      ['بدي نسخة من عقدي', 'HR'],
      ['بدي غيّر بيانات حسابي بالبنك', 'HR'],
      // French
      ["mon ordinateur ne s'allume plus", 'IT'],
      ['la climatisation ne fonctionne pas', 'Maintenance'],
      ['je veux une copie de mon contrat', 'HR'],
    ];
    for (const [text, expected] of offlineCases) {
      const offline = classifyOffline(text);
      expect(CATEGORIES, `classifyOffline("${text}")`).toContain(offline.category);
      expect(PRIORITIES, `classifyOffline("${text}")`).toContain(offline.priority);
      expect(offline.category, `classifyOffline("${text}")`).toBe(expected);
      // It never claims model-like certainty: rules are capped low on purpose.
      expect(offline.confidence).toBeLessThanOrEqual(0.6);
    }
    // No signal at all still yields something valid — and a modest confidence.
    const vague = classifyOffline('help');
    expect(CATEGORIES).toContain(vague.category);
    expect(PRIORITIES).toContain(vague.priority);
    expect(vague.confidence).toBeLessThan(0.4);
    // Urgency wording is honoured in both directions.
    expect(classifyOffline("my laptop is broken and I can't work").priority).toBe('High');
    expect(classifyOffline('the office chair squeaks, no rush').priority).toBe('Low');
    // …including in Arabic and French.
    expect(classifyOffline('ما فيني اشتغل والنت واقف').priority).toBe('High');
    expect(classifyOffline('كرسي مكسور، ما في استعجال').priority).toBe('Low');
    expect(classifyOffline('ordinateur en panne, urgent').priority).toBe('High');
  });

  it('7. sends a Groq-shaped request, and invalid AI output is corrected, never passed through', async () => {
    stubProvider('{"category":"Finance","priority":"Urgent","title":"Printer jam","confidence":0.99}');

    const result = await service.suggest('The printer on floor 2 is jammed');
    const suggestion = expectUsable(result, 'invalid enums');
    expect(suggestion.category).not.toBe('Finance');
    expect(suggestion.priority).not.toBe('Urgent');
    expect(suggestion.category).toBe('IT');
    expect(suggestion.priority).toBe('Medium');
    // The parts that were usable are kept.
    expect(suggestion.title).toBe('Printer jam');
    expect(result.source).toBe('ai');

    // The request itself is OpenAI-compatible, i.e. Groq-compatible: the
    // configured base URL + /chat/completions, the configured model, a
    // deterministic temperature, and the bearer key when one is configured.
    expect(lastRequest?.url).toBe(`${PROVIDER_URL}/chat/completions`);
    const sent = JSON.parse(String(lastRequest?.init?.body)) as {
      model?: string;
      temperature?: number;
      stream?: boolean;
      response_format?: unknown;
    };
    expect(sent.model).toBe(MODEL);
    expect(sent.temperature).toBe(0);
    expect(sent.stream).toBe(false);
    // The provider is asked for strict JSON, which is why the parser rarely
    // has to repair anything (the validator still handles it if it must).
    expect(sent.response_format).toEqual({ type: 'json_object' });

    process.env.AI_API_KEY = 'test-key-not-a-real-secret';
    stubProvider('{"category":"HR","priority":"Low","title":"Badge renewal","confidence":0.8}');
    await service.suggest('I need my badge renewed');
    const headers = (lastRequest?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key-not-a-real-secret');
    delete process.env.AI_API_KEY;
  });

  it('8. provider failure is always graceful — strict error, or a labelled offline suggestion', async () => {
    // Strict contract (AI_OFFLINE_FALLBACK=false): null + a clear error.
    process.env.AI_OFFLINE_FALLBACK = 'false';
    stubProviderDown();

    const strict = await service.suggest('My laptop will not charge');
    expect(strict.suggestion).toBeNull();
    expect(strict.error).toBe('AI provider unavailable');

    // A provider that answers with an HTTP error is handled the same way.
    stubProvider('', false, 503);
    const errored = await service.suggest('My laptop will not charge');
    expect(errored.suggestion).toBeNull();
    expect(errored.error).toBe('AI provider unavailable');

    // With the fallback on (the default) the employee still gets a usable,
    // clearly-labelled suggestion instead of nothing.
    delete process.env.AI_OFFLINE_FALLBACK;
    stubProviderDown();

    const offline = await service.suggest('My laptop will not charge');
    expectUsable(offline, 'offline fallback');
    expect(offline.source).toBe('offline');
    expect(offline.notice).toMatch(/offline/i);
    expect(offline.suggestion?.category).toBe('IT');
    expect(offline.suggestion?.confidence).toBeLessThanOrEqual(0.6);

    // A provider that answers with prose rather than JSON is also labelled.
    stubProvider('I think this is probably an IT issue, sorry!');
    const prose = await service.suggest('My laptop will not charge');
    expectUsable(prose, 'non-JSON answer');
    expect(prose.source).toBe('offline');
    expect(prose.notice).toMatch(/unexpected format/i);

    // AI switched off entirely: no suggestion at all, whatever the fallback says.
    process.env.AI_ENABLED = 'false';
    const disabled = await service.suggest('My laptop will not charge');
    expect(disabled.suggestion).toBeNull();
    expect(disabled.error).toContain('disabled');
    delete process.env.AI_ENABLED;

    // The model that is configured is the one we asked for.
    expect(MODEL.length).toBeGreaterThan(0);
  });
});
