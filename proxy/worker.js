/**
 * Eurisko Hub — shared demo AI provider (Cloudflare Worker).
 *
 * WHY THIS EXISTS
 *   The repository is public, so it must never contain an AI key: a `gsk_…`
 *   string committed to a public repo is scraped within minutes and burned.
 *   This Worker is the one place the key lives — as an encrypted Cloudflare
 *   *secret*, never in the code and never in git.
 *
 * HOW IT IS USED
 *   The backend already speaks to any OpenAI-compatible endpoint via
 *   `AI_PROVIDER_URL`, and it sends **no** `Authorization` header when
 *   `AI_API_KEY` is empty (see `callOnce()` in `backend/src/ai/ai-intake.service.ts`).
 *   So a fresh clone with no `.env` at all reaches this Worker, which adds the
 *   key server-side. Instructors get the real model with zero setup, and the
 *   key never leaves Cloudflare.
 *
 * WHAT IT REFUSES TO DO
 *   - no logging of request bodies (the text is an employee's problem report)
 *   - no key echo, ever, in any response
 *   - only the models the app is configured to ask for
 *   - only a small body and a small answer (the reply is one JSON object)
 *   - best-effort per-IP rate limiting, so one abuser cannot drain the quota
 *
 * If this Worker is down, rate-limited, or deleted, the app does **not** break:
 * `AI_OFFLINE_FALLBACK` (on by default) answers from the labelled offline
 * classifier and the UI says so. See ADR-006.
 *
 * Deploy: see proxy/README.md.
 */

/** The only upstream this Worker ever calls. */
const UPSTREAM = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * The models the demo endpoint accepts — exactly the ones the app asks for by
 * default (`AI_MODEL`) or as its fallback (`AI_FALLBACK_MODEL`). Anything else
 * is refused before a single upstream token is spent.
 */
const ALLOWED_MODELS = new Set(['openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);

/** The prompt plus one sentence of user text is well under this. */
const MAX_BODY_BYTES = 8 * 1024;
/** The answer is four small fields, so this is generous. */
const MAX_TOKENS = 256;
/** Requests allowed per IP per window. One "AI Suggest" click = one request. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Best-effort limiter. Cloudflare may run several isolates in several
 * locations, so this is a speed bump rather than a wall — the real backstop is
 * the provider's own per-key quota plus rotating the key after the course.
 */
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now > entry.resetAt) {
    if (hits.size > 5000) hits.clear(); // never grow without bound
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // A tiny health check, useful right after deploying.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, service: 'eurisko-hub-demo-ai' });
    }

    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return json({ error: { message: 'Not found. POST /v1/chat/completions.' } }, 404);
    }

    if (!env.GROQ_API_KEY) {
      return json(
        { error: { message: 'Demo proxy is not configured: the GROQ_API_KEY secret is missing.' } },
        503,
      );
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (isRateLimited(ip)) {
      return json(
        {
          error: {
            message:
              'Demo rate limit reached. Try again shortly, or point AI_PROVIDER_URL at your own provider with your own AI_API_KEY.',
          },
        },
        429,
      );
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: { message: 'Request body too large for the demo endpoint.' } }, 413);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: { message: 'Invalid JSON body.' } }, 400);
    }

    const model = typeof body?.model === 'string' ? body.model : '';
    if (!ALLOWED_MODELS.has(model)) {
      return json(
        { error: { message: `Model "${model}" is not served by the demo endpoint.` } },
        400,
      );
    }

    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        stream: false,
        max_tokens: Math.min(Number(body?.max_tokens) || MAX_TOKENS, MAX_TOKENS),
        ...(body?.response_format ? { response_format: body.response_format } : {}),
        messages: Array.isArray(body?.messages) ? body.messages : [],
      }),
    });

    // The app parses the OpenAI-compatible answer, so pass it through as-is —
    // including a 429 or 5xx, which the app already retries and then falls back
    // from (labelled) rather than failing the ticket form.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  },
};
