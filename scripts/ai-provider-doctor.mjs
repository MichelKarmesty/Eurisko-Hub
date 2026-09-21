#!/usr/bin/env node
/**
 * Finds a working AI provider for the v0.4 intake feature and tells you the
 * exact command to use it (docs/week4-production-ai.md).
 *
 *     node scripts/ai-provider-doctor.mjs
 *
 * The app's default provider is **Groq's free cloud API**
 * (https://api.groq.com/openai/v1) and needs only a free `AI_API_KEY`
 * (https://console.groq.com). This script probes, in order:
 *
 *   1. AI_PROVIDER_URL, if you already set it
 *   2. https://api.groq.com/openai/v1   (the default - needs AI_API_KEY)
 *   3. http://127.0.0.1:11434/v1        (a local Ollama - needs no key)
 *   4. http://localhost:11434/v1
 *   5. http://host.docker.internal:11434/v1
 *   6. http://<WSL default gateway>:11434/v1   (Ollama on Windows, API in WSL)
 *
 * Ollama listens on 127.0.0.1:11434 by default. If the API runs **inside WSL**
 * and Ollama runs on **Windows**, `localhost` is not Windows - the WSL default
 * gateway is. Ollama must listen on all interfaces there (set the user
 * environment variable OLLAMA_HOST=0.0.0.0:11434 and restart it).
 *
 * Exit code 0 when a provider answers, 1 when none does (the app then uses its
 * labelled offline fallback, or the strict error if AI_OFFLINE_FALLBACK=false).
 */
import { readFileSync } from 'node:fs';

/** The Windows host as seen from WSL: the default route's gateway. */
function wslGateway() {
  try {
    const lines = readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 3 || fields[1] !== '00000000') continue;
      const bytes = fields[2].match(/../g);
      if (!bytes) continue;
      // /proc/net/route stores the address little-endian in hex.
      return bytes.reverse().map((h) => parseInt(h, 16)).join('.');
    }
  } catch {
    /* not Linux/WSL */
  }
  return null;
}

const gateway = wslGateway();
const candidates = [
  process.env.AI_PROVIDER_URL,
  'https://api.groq.com/openai/v1',
  'http://127.0.0.1:11434/v1',
  'http://localhost:11434/v1',
  'http://host.docker.internal:11434/v1',
  gateway ? `http://${gateway}:11434/v1` : null,
].filter((u, i, all) => Boolean(u) && all.indexOf(u) === i);

/** Groq requires the key on this probe too, or it answers 401. */
const apiKey = process.env.AI_API_KEY;

async function probe(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const models = Array.isArray(body?.data)
      ? body.data.map((m) => m?.id ?? m?.name).filter(Boolean)
      : [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const wanted = process.env.AI_MODEL ?? 'openai/gpt-oss-20b';
console.log(`=== AI provider doctor (looking for an OpenAI-compatible API) ===`);
console.log(`Model the app will ask for: ${wanted}`);
if (!apiKey) console.log('AI_API_KEY is not set — the Groq default will answer 401 until you add one.');
console.log('');

const isLocalOllama = (base) => /(?:^|\/\/)(?:127\.0\.0\.1|localhost|host\.docker\.internal|\d+\.\d+\.\d+\.\d+):11434/.test(base);

let winner = null;
for (const base of candidates) {
  const result = await probe(base);
  if (result.ok) {
    winner = { base, models: result.models ?? [] };
    console.log(`PASS  ${base}  -> ${result.models.length} model(s): ${result.models.join(', ') || '(none available yet)'}`);
  } else {
    console.log(`fail  ${base}  -> ${result.why}`);
  }
}

console.log('');
if (!winner) {
  console.log('No AI provider is answering. The app still works: AI Suggest uses the');
  console.log('labelled offline fallback (or the strict error with AI_OFFLINE_FALLBACK=false).');
  console.log('\nFor free cloud AI, get a key (no credit card) and set it:');
  console.log('  export AI_API_KEY=gsk_…     # https://console.groq.com');
  console.log('\nYou can also use a local Ollama (https://ollama.com), which needs no key:');
  console.log('  AI_PROVIDER_URL=http://localhost:11434/v1');
  process.exitCode = 1;
} else {
  console.log(`Use it with:\n\n  AI_PROVIDER_URL=${winner.base} npm start\n`);
  const hasModel = winner.models.some((m) => String(m).startsWith(wanted));
  if (hasModel) {
    console.log(`"${wanted}" is available — the app will return real model answers (source: "ai").\n`);
  } else if (isLocalOllama(winner.base)) {
    console.log(`Note: no model named "${wanted}" is available in Ollama yet — make one available first.\n`);
  } else {
    console.log(`Note: "${wanted}" is not listed by that provider — set AI_MODEL to a model it offers.\n`);
  }
  if (gateway && winner.base.includes(gateway)) {
    console.log('(That URL is your Windows host as seen from WSL. Ollama must listen on all');
    console.log(' interfaces there: set the user environment variable OLLAMA_HOST=0.0.0.0:11434');
    console.log(' and restart Ollama.)\n');
  }
  process.exitCode = 0;
}
