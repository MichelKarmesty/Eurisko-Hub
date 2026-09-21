#!/usr/bin/env node
/**
 * Eurisko Hub - a TEST DOUBLE for an OpenAI-compatible provider.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THIS IS NOT A MODEL. Its answers come from keyword rules.              │
 * │                                                                          │
 * │  Point the app at it and the app will report `source: "ai"` for answers  │
 * │  a machine derived from a keyword table - which is exactly what §3.4 of  │
 * │  docs/week4-production-ai.md forbids in the product. That is acceptable  │
 * │  HERE and only here: this file exists to exercise the HTTP path, the     │
 * │  prompt that goes out, and the response handling, in a test or a         │
 * │  demonstration of the plumbing. It must never stand in for a model in    │
 * │  front of an audience or in a real deployment.                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Why it exists: every live AI check in this repo (scripts/verify-ai-intake.mjs,
 * the real-provider eval cases 1–5) skips when no provider answers, so the
 * *model* half of the contract - the `source: "ai"` branch, the request the
 * service actually sends, the model-path notices - is otherwise never exercised
 * on a machine without a key. The offline classifier cannot cover it: it is
 * deliberately labelled `source: "offline"` and is a different code path.
 *
 * Usage (two terminals):
 *
 *   node scripts/mock-ai-provider.mjs                 # listens on :4321
 *   MOCK_PORT=4399 node scripts/mock-ai-provider.mjs
 *
 *   # then start the API against it
 *   cd backend
 *   DB_FILE="$PWD/.data/hub.sqlite" \
 *     AI_PROVIDER_URL=http://127.0.0.1:4321/v1 AI_MODEL=mock-model AI_API_KEY=mock-key \
 *     node dist/main.js
 *
 *   # and run the ordinary checks - they now report `source: ai`
 *   node scripts/verify-ai-intake.mjs
 *   (cd backend && AI_PROVIDER_URL=http://127.0.0.1:4321/v1 AI_MODEL=mock-model \
 *      AI_API_KEY=mock-key npm run test:ai-eval)     # cases 1–5 stop skipping
 *
 * Environment:
 *   MOCK_PORT   default 4321   port to listen on (127.0.0.1 only)
 *   MOCK_FAIL   unset          make every call fail, to exercise the fallback:
 *                              401 | 429 | 500   -> that HTTP status
 *                              prose             -> 200 with non-JSON content
 *                              hang              -> never answers (timeout path)
 *
 * It logs one line per call, including whether the system prompt it received
 * mentions `relevant`/`reason` - so a stale build that still sends the old
 * prompt is visible immediately rather than silently "passing".
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4321);
const FAIL = (process.env.MOCK_FAIL ?? '').toLowerCase();

/** Keyword tables in the same spirit as the offline classifier - deliberately rough. */
const KEYWORDS = {
  HR: [
    'contract', 'payroll', 'salary', 'payslip', 'leave', 'vacation', 'badge', 'hr',
    'emergency contact', 'onboarding', 'offboarding', 'insurance', 'recruitment',
  ],
  Maintenance: [
    'ac', 'air condition', 'air conditioning', 'door', 'lock', 'leak', 'light', 'lamp',
    'chair', 'desk', 'elevator', 'cleaning', 'heating', 'window', 'plumbing',
  ],
  IT: [
    'laptop', 'computer', 'pc', 'monitor', 'screen', 'keyboard', 'mouse', 'printer',
    'wifi', 'network', 'vpn', 'email', 'password', 'account', 'software', 'server',
    'dock', 'phone', 'headset', 'access',
  ],
};

/**
 * Words that make a short-but-real request count as a request, mirroring what
 * the real prompt tells the model: "help" and "something is wrong" are requests,
 * and only genuinely unreadable text is `relevant: false`.
 */
const REQUESTY = /help|wrong|broken|issue|problem|fix|assist|need|please|fault/i;

const URGENT = /cannot work|can't work|cant work|not working|urgent|asap|critical|outage|emergency|dead|stopped/i;
const CALM = /no rush|not urgent|whenever|minor|cosmetic/i;

/** Count keyword hits: phrases as substrings, single words on a word boundary. */
function hits(text, words) {
  return words.filter((word) =>
    word.includes(' ') ? text.includes(word) : new RegExp(`\\b${word}\\b`).test(text),
  ).length;
}

/** The rule-based stand-in answer, in the exact shape the service expects. */
function fakeCompletion(prompt) {
  const text = ` ${prompt.toLowerCase().replace(/\s+/g, ' ').trim()} `;

  const scored = Object.entries(KEYWORDS)
    .map(([category, words]) => ({ category, score: hits(text, words) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];

  const priority = URGENT.test(text) ? 'High' : CALM.test(text) ? 'Low' : 'Medium';
  const relevant = best.score > 0 || REQUESTY.test(prompt);

  return {
    category: best.score > 0 ? best.category : 'IT',
    priority,
    title: prompt.trim().split(/\s+/).slice(0, 8).join(' ').slice(0, 80) || 'New request',
    confidence: relevant ? 0.9 : 0.1,
    relevant,
    reason: relevant ? '' : 'the text looks like random characters, not a request',
  };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    }

    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }

    if (FAIL === 'hang') {
      console.log('[mock] FAIL=hang -> never answering (the caller must time out)');
      return; // no response, on purpose
    }

    let sent = {};
    try {
      sent = JSON.parse(body || '{}');
    } catch {
      // fall through with an empty body; the log below still reports blank values
    }
    const system = sent.messages?.find((m) => m.role === 'system')?.content ?? '';
    const user = sent.messages?.find((m) => m.role === 'user')?.content ?? '';

    if (FAIL) {
      if (FAIL === 'prose') {
        console.log('[mock] FAIL=prose -> 200 with a non-JSON answer');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'It is probably an IT thing, sorry!' } }],
          }),
        );
      }
      const status = Number(FAIL);
      if (Number.isFinite(status)) {
        console.log(`[mock] FAIL=${status} -> HTTP ${status}`);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `mock failure ${status}` } }));
      }
    }

    const answer = fakeCompletion(user);

    // The prompt check is the point: a build that still sends the old system
    // prompt shows up as prompt_mentions_relevant=false.
    console.log(
      `[mock] model=${sent.model ?? '?'} json_mode=${Boolean(sent.response_format)} ` +
        `temp=${sent.temperature} prompt_mentions_relevant=${system.includes('relevant')} ` +
        `prompt_mentions_reason=${system.includes('reason')} -> ` +
        `relevant=${answer.relevant} ${answer.category} / ${answer.priority}`,
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'chat.completion',
        model: sent.model ?? 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) } }],
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('=== Eurisko Hub — MOCK AI provider (test double, NOT a model) ===');
  console.log(`Listening on http://127.0.0.1:${PORT}/v1  (endpoints: /models, /chat/completions)`);
  if (FAIL) console.log(`Failing every call on purpose: MOCK_FAIL=${FAIL}`);
  console.log('Answers come from keyword rules and are returned as `source: "ai"` —');
  console.log('use this to exercise the HTTP path, never to demonstrate the product.');
});
