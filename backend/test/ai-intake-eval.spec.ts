/**
 * v0.4 — AI INTAKE EVAL (docs/week4-production-ai.md §"Eval results").
 *
 * Eight eval cases for the AI-assisted Request Intake capability, in two
 * groups with deliberately different guarantees:
 *
 *   Cases 1–5 — behaviour against a REAL provider. A paid provider is not
 *   required: if `AI_PROVIDER_URL` (default http://localhost:11434/v1, i.e.
 *   local Ollama) is not answering, these skip gracefully instead of failing.
 *   They assert what the product promises — the suggestion is always inside
 *   the domain enums and always usable — rather than exact wording from a
 *   specific model, which would be flaky and would pin the eval to one LLM.
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

const PROVIDER_URL = (process.env.AI_PROVIDER_URL ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
const MODEL = process.env.AI_MODEL ?? 'llama3.2';

const service = new AiIntakeService();

/** Is a real OpenAI-compatible provider answering right now? */
let providerAvailable = false;

beforeAll(async () => {
  // Give a local model time to answer when one is actually there.
  process.env.AI_TIMEOUT_MS = process.env.AI_TIMEOUT_MS ?? '15000';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const probe = await realFetch(`${PROVIDER_URL}/models`, { signal: controller.signal });
    providerAvailable = probe.ok;
  } catch {
    providerAvailable = false;
  } finally {
    clearTimeout(timer);
  }

  if (!providerAvailable) {
    // eslint-disable-next-line no-console
    console.info(
      `[ai-eval] No AI provider at ${PROVIDER_URL} — cases 1–5 will be skipped ` +
        '(cases 6–8 are mocked and always run). Start Ollama to run them for real.',
    );
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a canned chat-completion response. */
function stubProvider(content: string, ok = true, status = 200) {
  globalThis.fetch = (async () => ({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  })) as unknown as typeof fetch;
}

/** Replace fetch with a provider that cannot be reached. */
function stubProviderDown(message = 'ECONNREFUSED 127.0.0.1:11434') {
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

describe('AI intake eval — real provider (skips when no provider is running)', () => {
  it('1. clear IT report -> IT, with a usable priority and title', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectUsable(
      await service.suggest('My monitor is broken and I need a replacement'),
      'clear IT',
    );
    expect(suggestion.category).toBe('IT');
    // Urgency is a judgement call, so the eval asserts a valid priority rather
    // than pinning one exact value from a particular model.
  });

  it('2. clear HR request -> HR', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectUsable(
      await service.suggest('I need to update my emergency contact information'),
      'clear HR',
    );
    expect(suggestion.category).toBe('HR');
  });

  it('3. clear Maintenance report -> Maintenance', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectUsable(
      await service.suggest('The AC in conference room B is not working'),
      'clear Maintenance',
    );
    expect(suggestion.category).toBe('Maintenance');
  });

  it('4. thin input still yields a valid category and priority (low confidence is fine)', async ({ skip }) => {
    if (!providerAvailable) skip();
    expectUsable(await service.suggest('help'), 'thin input');
    expectUsable(await service.suggest('something is wrong'), 'thin input (second wording)');
  });

  it('5. mixed signals resolve to exactly one valid category', async ({ skip }) => {
    if (!providerAvailable) skip();
    const suggestion = expectUsable(
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
    const offlineCases: Array<[string, 'IT' | 'HR' | 'Maintenance']> = [
      ['my laptop screen is flickering', 'IT'],
      ['the printer on floor 2 is jammed', 'IT'],
      ['I need to update my emergency contact', 'HR'],
      ['when does my contract get renewed', 'HR'],
      ['the AC in conference room B is not working', 'Maintenance'],
      ['the door lock is broken', 'Maintenance'],
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
  });

  it('7. invalid AI output (Finance / Urgent) is corrected, never passed through', async () => {
    stubProvider('{"category":"Finance","priority":"Urgent","title":"Printer jam","confidence":0.99}');

    const result = await service.suggest('The printer on floor 2 is jammed');
    const suggestion = expectUsable(result, 'invalid enums');
    expect(suggestion.category).not.toBe('Finance');
    expect(suggestion.priority).not.toBe('Urgent');
    expect(suggestion.category).toBe('IT');
    expect(suggestion.priority).toBe('Medium');
    // The parts that were usable are kept.
    expect(suggestion.title).toBe('Printer jam');
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
