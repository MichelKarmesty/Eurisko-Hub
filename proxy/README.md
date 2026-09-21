# Demo AI provider - how the real model works with no key in the repo

The repository is **public**. A key committed here would be scraped and burned
within minutes, so the key lives in exactly one place: an encrypted **Cloudflare
Worker secret**. The Worker is a ~20-line OpenAI-compatible proxy in front of
Groq (`worker.js`).

```
instructor's clone                    Cloudflare                    Groq
┌──────────────────────┐        ┌───────────────────────┐      ┌──────────────┐
│ backend              │  POST  │  eurisko-hub-demo-ai  │ POST │ api.groq.com │
│ AI_PROVIDER_URL ────►│ ─────► │  + Authorization:     │────► │              │
│ (no AI_API_KEY)      │        │    Bearer <secret>    │      │              │
└──────────────────────┘        └───────────────────────┘      └──────────────┘
```

Why it works with zero setup: the backend sends **no** `Authorization` header
when `AI_API_KEY` is empty (`callOnce()` in `backend/src/ai/ai-intake.service.ts`),
and the default `AI_PROVIDER_URL` is this Worker. If the Worker is down or
rate-limited, the app does **not** fail - it answers from the labelled offline
classifier and the UI tags it **"Suggested (offline)"** (ADR-006).

## Deploy once (about 3 minutes)

Requires a free Cloudflare account (no credit card) and a free Groq key from
<https://console.groq.com/keys>.

```bash
cd proxy
npx wrangler login                      # opens the browser once
npx wrangler secret put GROQ_API_KEY    # paste the gsk_… key when prompted
npx wrangler deploy                     # prints the URL
```

`wrangler deploy` prints something like:

```
https://eurisko-hub-demo-ai.<your-subdomain>.workers.dev
```

The app calls `<url>/v1/chat/completions`, so the provider URL is that address
with `/v1` appended:

```
AI_PROVIDER_URL=https://eurisko-hub-demo-ai.<your-subdomain>.workers.dev/v1
```

The key is stored encrypted by Cloudflare and is never written to `wrangler.toml`,
to this repo, or to any response.

## Check it before wiring it in

```bash
# 1. health (should print {"ok":true,...})
curl -s https://eurisko-hub-demo-ai.<your-subdomain>.workers.dev/health

# 2. a real suggestion (no key in the request — that is the point)
curl -s -X POST https://eurisko-hub-demo-ai.<your-subdomain>.workers.dev/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-oss-20b","messages":[
        {"role":"user","content":"my laptop screen flickers and I cannot work"}]}'
```

## What the Worker deliberately does not do

| Control | Value | Why |
|---|---|---|
| Models served | `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | exactly what the app asks for; nothing else can spend tokens |
| Request body | ≤ 8 KB | the prompt plus one problem description |
| Answer size | ≤ 256 tokens | the reply is one small JSON object |
| Rate limit | 30 requests / IP / 10 min | best-effort (per isolate), so one abuser cannot drain the quota |
| Logging | none | the text is an employee's problem report |
| Key exposure | never | only the upstream call carries it |

## Security notes to keep in mind

1. **The endpoint is public.** Anyone who finds the URL can use it until the
   provider's quota stops them. That is the price of "clone and it just works".
   The rate limit plus Groq's own free-tier limits are the guard rails.
2. **Rotate after the course.** Revoke the key at
   <https://console.groq.com/keys>, then `npx wrangler secret put GROQ_API_KEY`
   again with a new one.
3. **Kill switch.** `npx wrangler delete` removes the endpoint entirely - the app
   then falls back to the labelled offline classifier. Deleting the
   `GROQ_API_KEY` secret (dashboard) has the same effect.
4. **Never** "just commit the key instead". On a public repo it is gone the same
   day, and a revoked key mid-grading is a worse demo than an offline fallback.

## Using your own provider instead

Nothing about the app requires this Worker. Any OpenAI-compatible endpoint works:

```bash
# your own Groq key
AI_PROVIDER_URL=https://api.groq.com/openai/v1 AI_API_KEY=gsk_… npm start

# a local model, no key at all
AI_PROVIDER_URL=http://localhost:11434/v1 AI_MODEL=llama3.2 npm start
```
