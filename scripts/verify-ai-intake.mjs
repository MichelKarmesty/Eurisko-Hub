#!/usr/bin/env node
/**
 * v0.4 - AI intake checks (docs/week4-production-ai.md).
 *
 * Calls POST /tickets/ai-suggest on a RUNNING api with realistic employee
 * descriptions and reports what came back, so the capability can be shown (and
 * graded) in a single command:
 *
 *     node scripts/verify-ai-intake.mjs
 *
 * It works with **no AI key configured**: the service then answers from its
 * offline keyword classifier, labelled `source: "offline"` with a notice, and
 * this script says so. With a free Groq key (console.groq.com), or any other
 * OpenAI-compatible provider, the same checks run against real classifications
 * and report `source: "ai"`.
 *
 * v0.6 - one of the descriptions is deliberately meaningless ("asdfghjkl…").
 * The AI must report that it could not find a support request there
 * (`relevant: false` + a `notice`) instead of inventing a plausible-looking
 * Category/Priority. That answer is still an HTTP 200 with a usable body: the
 * call succeeded, it is the *input* the assistant could not read, so nothing is
 * blocked and the employee can always fill the form by hand.
 *
 * Environment:
 *   BASE_URL        default http://localhost:3000
 *   ADMIN_EMAIL     default admin@eurisko.com
 *   ADMIN_PASSWORD  default Admin123!
 */
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@eurisko.com',
  password: process.env.ADMIN_PASSWORD ?? 'Admin123!',
};

const CATEGORIES = ['IT', 'HR', 'Maintenance'];
const PRIORITIES = ['Low', 'Medium', 'High'];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
};

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/**
 * text, expected category (null = any valid one), expected relevance
 * (null = any - the offline classifier cannot judge a vague-but-real "help" the
 * way a model can, so that one is reported but not asserted).
 */
const CASES = [
  ["My laptop screen is flickering and I can't work", 'IT', true],
  ['I need to update my emergency contact information', 'HR', true],
  ['The AC in conference room B is not working', 'Maintenance', true],
  ['help', null, null],
  ['The office door lock is broken and I also need HR to update my badge', null, true],
  ['asdfghjkl qwerty zxcvbn', null, false],
];

async function main() {
  console.log(`=== verify-ai-intake against ${BASE} ===`);

  const login = await req('POST', '/auth/login', { body: ADMIN });
  check('Admin can log in (seeded account)', login.status === 200, `HTTP ${login.status}`);
  if (login.status !== 200) {
    console.log('\nCannot continue without the seeded admin. Start the backend so it seeds, then re-run.');
    process.exitCode = 1;
    return;
  }
  const token = login.data.accessToken;

  const unauthenticated = await req('POST', '/tickets/ai-suggest', { body: { text: CASES[0][0] } });
  check('Requires authentication (401 without a token)', unauthenticated.status === 401, `HTTP ${unauthenticated.status}`);

  const tooShort = await req('POST', '/tickets/ai-suggest', { token, body: { text: 'hi' } });
  check('Rejects a too-short description (400)', tooShort.status === 400, `HTTP ${tooShort.status}`);

  const before = await req('GET', '/tickets', { token });
  const countBefore = Array.isArray(before.data) ? before.data.length : -1;

  const sources = new Set();
  for (const [text, expected, expectedRelevant] of CASES) {
    const res = await req('POST', '/tickets/ai-suggest', { token, body: { text } });
    const suggestion = res.data?.suggestion;

    if (res.status !== 200 || !suggestion) {
      check(`"${text}"`, false, `${res.status} ${JSON.stringify(res.data)}`);
      continue;
    }

    sources.add(res.data.source ?? 'ai');
    const label = res.data.source === 'offline' ? 'offline' : 'ai';
    const detail =
      `${suggestion.category} / ${suggestion.priority} / "${suggestion.title}" ` +
      `(confidence ${suggestion.confidence}, source ${label}, relevant ${suggestion.relevant})` +
      (suggestion.relevant === false && res.data.notice ? `\n      notice: ${res.data.notice}` : '');

    const ok =
      CATEGORIES.includes(suggestion.category) &&
      PRIORITIES.includes(suggestion.priority) &&
      typeof suggestion.title === 'string' &&
      suggestion.title.trim().length >= 3 &&
      typeof suggestion.confidence === 'number' &&
      suggestion.confidence >= 0 &&
      suggestion.confidence <= 1 &&
      typeof suggestion.relevant === 'boolean' &&
      (expected === null || suggestion.category === expected) &&
      (expectedRelevant === null || suggestion.relevant === expectedRelevant);

    check(
      `"${text}"${expected ? `  [expect ${expected}]` : ''}` +
        `${expectedRelevant === null ? '' : `  [expect relevant=${expectedRelevant}]`}`,
      ok,
      detail,
    );
  }

  // The advisory promise: asking for suggestions must never create a ticket.
  const after = await req('GET', '/tickets', { token });
  const countAfter = Array.isArray(after.data) ? after.data.length : -1;
  check(
    'Advisory only: no ticket was created by the suggestions',
    countBefore === countAfter && countBefore >= 0,
    `tickets before=${countBefore} after=${countAfter}`,
  );

  // And the ticket path itself still works, with a manual category/priority.
  const manual = await req('POST', '/tickets', {
    token,
    body: {
      title: 'AI intake check — manual ticket',
      description: 'Created by scripts/verify-ai-intake.mjs to prove POST /tickets is unchanged.',
      category: 'IT',
      priority: 'Medium',
    },
  });
  check('POST /tickets still works with a manual choice', manual.status === 201, `HTTP ${manual.status}`);

  const mode = sources.has('offline') && sources.has('ai')
    ? 'mixed (model + offline fallback)'
    : sources.has('offline')
      ? 'OFFLINE classifier — no AI model is answering'
      : 'AI model';
  console.log(`\nSuggestion source: ${mode}`);
  if (sources.has('offline')) {
    console.log(
      'No AI model answered, so the answers above come from the offline keyword classifier\n' +
        '(clearly labelled `source: "offline"`). For real AI answers, set a free Groq key:\n' +
        '  export AI_API_KEY=gsk_…   # free, no credit card — https://console.groq.com\n' +
        'You can also use a local Ollama (AI_PROVIDER_URL=http://localhost:11434/v1, no key),\n' +
        'or disable the fallback with AI_OFFLINE_FALLBACK=false.',
    );
  }

  console.log(
    '\nv0.6 relevance signal: text that is not a support request comes back as `relevant: false`\n' +
      'with a notice, and the form pre-fills nothing from it. The status is still 200 — the call\n' +
      'succeeded; it is only the input that could not be read as a request.',
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(` — FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`verify-ai-intake crashed: ${err}`);
  process.exitCode = 1;
});
