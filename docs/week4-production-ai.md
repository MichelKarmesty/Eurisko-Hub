# Week 4 — v0.4 AI-Assisted Request Intake

**Project:** Internal Operations Service Hub (Eurisko Hub)
**Capability:** AI-assisted Request Intake — the AI suggests the structured fields, the employee decides
**Stack:** React (Vite) → NestJS → SQLite (TypeORM), one repository
**Status:** delivered; every existing v0.3 behaviour and test is unchanged and still passing

This is the Week 4 delivery record. Like the Week 3 record, every claim here maps
to a file in this repository and to a command you can run.

> **Decision record:** the scope decision that lets this capability exist at all —
> the MVP spec originally excluded AI — is [ADR-006](decisions/ADR-006.md)
> (*Advisory AI Request Intake*). It narrows the product-spec non-goal to
> "no autonomous AI" and records why the model is advisory-only, validated, and
> backed by a labelled offline fallback.

---

## 1. The capability

An employee who does not know whether their problem is "IT" or "Maintenance", or
how urgent it is, can describe it in their own words. The AI reads that text and
**suggests** three things — the category, the priority and a cleaned-up title —
which appear in the New Request form as an editable starting point.

And (v0.6) if the text is **not a support request at all** — random characters,
a greeting, a test message, a joke — it says so instead of inventing a
category: `relevant: false` plus a short reason, nothing pre-filled, and the
form untouched. "I could not find a request here" is one more thing the AI is
allowed to answer, never an error the employee has to work around (§3.6).

> **The AI proposes; the employee disposes.** Nothing the model says reaches the
> database: the employee can change every field, the suggestion is visually
> marked and unmarks itself as soon as the employee types, and the ticket is
> still created by the unchanged `POST /tickets` with the unchanged
> `CreateTicketDto`.

```
Employee                 React form            AiIntakeService            AI provider
   |                         |                        |                        |
   | types "my laptop        |                        |                        |
   | screen flickers and     |                        |                        |
   | I can't work"           |                        |                        |
   |------------------------>|                        |                        |
   |      clicks AI Suggest  |-- POST /tickets/ai-suggest { text } ----------->|
   |                         |                        |-- chat completion ---->|
   |                         |                        |<-- JSON (untrusted) ---|
   |                         |                        |                        |
   |                         |        coerceSuggestion(): category in CATEGORIES,
   |                         |        priority in PRIORITIES, title, confidence 0-1
   |                         |<-- { suggestion } -----|
   |                         |                        |
   |  sees Category=IT, Priority=High, Title="Laptop screen flickers"
   |  each marked "AI suggested" (editable)
   |                         |                        |
   | edits the priority ---- |                        |
   |      clicks Open ticket |                        |
   |------------------------>|-- POST /tickets (unchanged CreateTicketDto) ----> DB
```

What the employee can do at every point:

| Step | What happens |
|---|---|
| Types a free-form description | Nothing is sent until they ask |
| Presses **AI Suggest** | `POST /tickets/ai-suggest`; a read-only advisory call, no database writes |
| Suggestion arrives | Category, Priority and Title are pre-filled, each tagged **AI suggested** and highlighted (or **"Suggested (offline)"** when no model answered — §3.4) |
| Text is not a support request | v0.6: nothing is pre-filled. A notice explains that no request could be found (with the reason) and invites the employee to add detail or fill the fields by hand; the form itself is untouched. The model's verdict is an **error** notice, the keyword classifier's weaker "nothing matched" is **informational** (§3.6) |
| Edits any field | That field's highlight and tag disappear — the value is now theirs |
| Presses **Open ticket** | The ordinary `POST /tickets` runs with whatever the form now holds |
| No key or model configured | The offline classifier still fills the form in, clearly labelled; a notice explains how to get real AI answers |
| AI disabled (`AI_ENABLED=false`) | A non-blocking notice: *"AI suggestions unavailable — fill in the fields manually."* The form works exactly as before |

---

## 2. Architecture

### Files added (all inside the existing repository — no new project, no new repo)

| File | Role |
|---|---|
| `backend/src/ai/ai-intake.service.ts` | `AiIntakeService.suggest()`: prompt, call, parse, validate. Also exports the pure `coerceSuggestion()`, `titleFromText()` and `extractJsonObject()` helpers the eval tests use directly |
| `backend/src/ai/ai-intake.controller.ts` | `POST /tickets/ai-suggest`, authenticated, `200`, no side effects |
| `backend/src/ai/dto.ts` | `AiSuggestDto` — `text` (string, min 3), class-validator like every other DTO |
| `backend/src/ai/ai-intake.module.ts` | Wires the controller and service; **imports no TypeORM module at all** |
| `backend/src/app.module.ts` | Registers `AiIntakeModule` next to `TicketsModule` |
| `frontend/src/components/RequesterView.tsx` | Free-text box + **AI Suggest**, suggestion tagging, non-blocking failure notice |
| `frontend/src/api.ts` | `apiAiSuggest(text)` — the typed call |
| `frontend/src/types.ts` | `AiIntakeSuggestion` / `AiIntakeResult`, mirroring the backend |
| `frontend/src/styles.css` | `.ai-intake`, `.ai-tag`, `.ai-field` — the suggestion styling |
| `backend/test/ai-intake-eval.spec.ts` | The eval cases (this delivery ships 9: 5 real-or-skip + 4 mocked) |
| `backend/package.json` | `test:ai-eval` script |
| `docs/week4-production-ai.md` | This document |

Nothing existing changed behaviour. `TicketsService`, `CreateTicketDto`, the RBAC
guards and every ticket route are untouched.

### `POST /tickets/ai-suggest` — the contract

Base URL `http://localhost:3000`; requires `Authorization: Bearer <accessToken>`
(any signed-in user — authentication is the only requirement, because anyone who
may open a ticket may ask for a suggestion).

```jsonc
// request
{ "text": "My laptop screen is flickering and I can't work" }

// 200 — a model answered (category/priority are always inside the domain enums)
{ "suggestion": { "category": "IT", "priority": "High",
                  "title": "Laptop screen flickering", "confidence": 0.92,
                  "relevant": true },
  "source": "ai" }

// 200 — no model answered, so the labelled offline classifier did (the default)
{ "suggestion": { "category": "IT", "priority": "Medium",
                  "title": "Laptop will not charge", "confidence": 0.4,
                  "relevant": true },
  "source": "offline",
  "notice": "AI provider unavailable — this suggestion comes from the offline keyword classifier, not from a model. …" }

// v0.6 — 200: the model answered, but could not find a request in the text.
// Still a 200 with a usable body: the call succeeded, the *input* was unreadable.
{ "suggestion": { "category": "IT", "priority": "Low",
                  "title": "Not a support request", "confidence": 0.1,
                  "relevant": false,
                  "reason": "the text is random characters, not a request" },
  "source": "ai",
  "notice": "This does not look like a support request (the text is random characters, not a request) — add a few details about the problem, or fill in the fields by hand." }

// 200 — strict provider-only contract (AI_OFFLINE_FALLBACK=false)
{ "suggestion": null, "error": "AI provider unavailable" }
{ "suggestion": null, "error": "AI suggestions are disabled (AI_ENABLED=false)." }

// 400 — the text itself is missing/too short (normal DTO validation)
// 401 — no or invalid bearer token
```

Note what is **not** in the contract: there is no way for this call to create,
change or delete a ticket, and no status code that means "the ticket was
affected". It is a read-only advisory call.

`relevant` (v0.6) is the one field that reports on the **input** instead of
guessing at it: `false` means *"I could not find a support request here"*
(random characters, a greeting, a test message, something unrelated to work).
It deliberately does **not** change the status code — a `4xx` would say the API
call was wrong, but the call succeeded; it is the text the assistant could not
read. So the UI shows the notice above and pre-fills nothing (§3.6), and the
employee opens the ticket by hand exactly as before. A missing or wrong-typed
`relevant` means `true`: an assistant must never accuse a real request of being
nonsense, and `"help"` is a request even though it is short.

### Configuration (all optional, all read per call)

| Variable | Default | Meaning |
|---|---|---|
| `AI_ENABLED` | `true` | `false` switches the feature off entirely (the endpoint then answers with the disabled error, and the form still works) |
| `AI_PROVIDER_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible base URL. Groq's free cloud API by default, so nothing has to be installed; a local Ollama is `http://localhost:11434/v1` |
| `AI_MODEL` | `openai/gpt-oss-20b` | Model name sent to the provider. Groq's free model names change over time, so list what your key can use at `GET /openai/v1/models` (e.g. `openai/gpt-oss-120b`, `groq/compound-mini`, `qwen/qwen3.8-27b`) |
| `AI_TIMEOUT_MS` | `15000` | Hard cap on the provider call (AbortController); cloud APIs get a little more room than a local model, and a transient blip is retried once |
| `AI_FALLBACK_MODEL` | *(unset)* | Comma-separated models tried when the primary model fails (429/5xx/retired) — so one busy model does not drop the answer to the offline rules (e.g. `qwen/qwen3.8-27b`) |
| `AI_RETRY_DELAY_MS` | `1500` | How long to wait before the one retry of a rate-limited / transient call |
| `AI_OFFLINE_FALLBACK` | `true` | When no model answers, return a suggestion from the built-in keyword classifier — always labelled `source: "offline"`. Set to `false` for the strict `{ suggestion: null, error }` contract |
| `AI_API_KEY` | *(unset)* | **Required for Groq** — a free key from <https://console.groq.com>; sent as `Authorization: Bearer …`. A keyless local provider such as Ollama needs none |

---

## 3. Architecture decisions

### 3.1 Why advisory-only

The alternative — let the AI create or pre-classify the ticket server-side —
would put an unpredictable component on the write path of the product's source
of truth. Three concrete reasons to refuse that:

1. **The user keeps authority.** The spec of the product says the employee
   chooses category and priority (product-spec.md §3). A model that silently
   picks them removes a decision the product assigns to a person.
2. **There is exactly one writer.** `TicketsService.create()` remains the only
   code path that inserts a ticket, so every existing guarantee — DTO
   validation, RBAC scoping, the `CREATED` audit event, the department rule —
   keeps applying with no new exceptions to reason about.
3. **It is structurally enforced, not just intended.** `AiIntakeModule` imports
   no TypeORM feature module, so the AI code has no repository to write
   through. Advisory-only is a property of the wiring, not a promise in a
   comment.

The suggestion is therefore a *form prefill*, and the UI says so: each suggested
field is tagged and highlighted, and the highlight clears the moment the
employee edits it.

### 3.2 Why a validation layer with the final word

Model output is untrusted input — the same category of risk as a request body
from the internet, and it is treated the same way. Every suggestion the service
can emit is built by one pure, total function:

```ts
coerceSuggestion(value: unknown, sourceText: string): AiIntakeSuggestion
```

* `category` must be a member of `CATEGORIES` (`IT | HR | Maintenance`), else the
  documented fallback `IT`;
* `priority` must be a member of `PRIORITIES` (`Low | Medium | High`), else the
  documented fallback `Medium`;
* `title` must be a usable string; otherwise it is derived from the employee's
  own words (`titleFromText`);
* `confidence` is clamped to `0…1`, and anything non-numeric becomes `0.5`.

The fallbacks are deliberate: `IT` is the busiest internal queue and the safest
first guess for "something is broken", and `Medium` neither hides an emergency
nor invents one. Either way the employee is expected to correct them — the point
is that **an invalid enum can never leave the service**, so
`{ "category": "Finance", "priority": "Urgent" }` becomes
`{ "category": "IT", "priority": "Medium" }` before anyone sees it.

Because the function is total (defined for every input) and pure, it is directly
unit-testable — which is what eval case 6 does with a deliberately hostile list
of inputs.

### 3.3 Why a graceful fallback instead of an error

The AI is an *assist*. The product must never depend on it, so no failure mode
of the provider is allowed to block the ticket workflow:

| Failure | What the product does |
|---|---|
| No provider listening / provider returns `500`/`503` / too slow (`AbortController` at `AI_TIMEOUT_MS`) | With `AI_OFFLINE_FALLBACK=true` (the default) the employee still gets a usable suggestion from the offline keyword classifier, returned as `source: "offline"` with a `notice`. With `AI_OFFLINE_FALLBACK=false` the answer is the strict `{ suggestion: null, error: "AI provider unavailable" }` |
| Provider returns prose instead of JSON | The offline classifier answers, with a notice saying the provider's answer could not be parsed |
| Partial or wrong-typed JSON | The validation layer fills the gaps; the answer is `source: "ai"` |
| **The text is not a support request** (v0.6) | A `200` with `relevant: false` and a `reason`, so the employee is told rather than handed a guess (§3.6). Not a failure of the provider at all — which is why it is not an error status |
| `AI_ENABLED=false` | `{ suggestion: null, error: "AI suggestions are disabled…" }` — no offline suggestion, because the feature was switched off on purpose |

The endpoint always answers `200` with a body the client understands, never a
`500`; `service.suggest()` catches everything. The only `4xx` responses are the
ordinary ones: `400` for a too-short `text` and `401` without a token.

### 3.4 The offline fallback, and why it is labelled

A fresh clone, a reviewer's laptop or a locked-down runner has no model
installed. Showing "unavailable" everywhere would make the capability
un-demonstrable, so the service falls back to a small, pure keyword classifier
(`classifyOffline`):

* **What it matches** — IT ← laptop, screen, printer, wifi, password, account, …
  HR ← contract, payroll, badge, leave, emergency contact, … Maintenance ← AC,
  leak, light, door, chair, cleaning, … A multi-word phrase ("emergency
  contact") outweighs a generic single word ("update"), ties go to `IT` (the same
  documented default), and urgency wording ("can't work", "urgent", "outage")
  raises the priority while "no rush"/"minor" lowers it.
* **It is multilingual.** Employees write in English, Arabic (including Lebanese
  dialect) and French, so the classifier understands all three: French accents are
  stripped before matching, and Arabic keywords match inside the word because the
  definite article is glued to the front (اللابتوب، المكيف، اللمبة). The model
  prompt is multilingual for the same reason, and it is asked to keep the
  suggested **title in the language the employee used** while `category`/`priority`
  stay as English enum values.
* **How sure it claims to be** — its confidence is capped at **0.6** and drops to
  **0.25** when nothing matches, so it never imitates model-like certainty. It
  can only emit members of `CATEGORIES` / `PRIORITIES`, exactly like the model
  path.
* **How it is disclosed** — every answer carries `source: "offline"` and a
  `notice`, the API documents it, and the UI tags the fields **"Suggested
  (offline)"** instead of "AI suggested". Rules are never dressed up as the
  model's work; the delivery record you are reading says the same thing.
* **How to switch it off** — `AI_OFFLINE_FALLBACK=false` restores the strict
  provider-only contract (`{ suggestion: null, error }`), which is what the
  mocked eval case 8 asserts as the "strict" branch.

### 3.5 Smaller decisions

* **No new dependency.** The provider call uses Node's built-in `fetch` (Node
  20+), so the dependency tree is unchanged.
* **Any OpenAI-compatible provider.** Groq is the default because it is free and
  needs nothing installed; Ollama, vLLM, LM Studio or any hosted API work too —
  only the base URL and model differ.
* **`temperature: 0`.** Classification should be repeatable, not creative.
* **A JSON-only prompt.** The system prompt asks for the exact fields, states
  the allowed values, and includes one example per category; defensive parsing
  exists because the model may still disobey.

### 3.6 Why "this doesn't make sense" is a signal, not an error (v0.6)

Before v0.6 every input got a confident-looking answer. Feed the classifier
`asdfghjkl qwerty`, and it replied `IT` / `Medium` — a plausible guess that was
indistinguishable from a good one, because `coerceSuggestion()` is *total* and
the prompt offered the model no way to say "this is not a request". The only
weak signal, `confidence`, was not even rendered in the UI.

The fix is a fifth field rather than a new status code:

| Decision | Why |
|---|---|
| **A field, not a `4xx`** | The provider answered perfectly. It is the *input* that could not be read as a request, so the call succeeded — returning an error status would be semantically wrong and would break the "AI trouble never blocks the ticket workflow" promise (§3.3). `relevant: false` keeps the contract at one `200` shape. |
| **Nothing is pre-filled** | A guess the assistant itself flagged as meaningless is worse than an empty form: it invites the employee to submit a ticket that says "IT / Medium" about nothing. The form is left exactly as they typed it. |
| **It is said out loud** | The notice carries the backend's own `reason` ("the text is random characters, not a request"), so the employee learns what to fix instead of wondering why the button did nothing. Severity follows the claim: a model's verdict is shown as an error, the rules' weaker "nothing matched" as information. |
| **The default is `true`** | `coerceRelevant()` only honours an explicit `false`. A missing, misspelled or wrong-typed field means relevant, because the one unacceptable failure here is telling an employee their real request is nonsense. The prompt says the same: *"When you are unsure, answer relevant=true."* |
| **Short is not the same as senseless** | "help", "something is wrong" and "it's broken" are requests. The prompt names them as `relevant: true` examples, and eval case 4 asserts a real model keeps thin input relevant — otherwise the feature would nag exactly the employees who write the least. |
| **The offline classifier says less, not more** | Rules cannot understand a vague-but-real request, so `classifyOffline()` reports only the verifiable claim — *no service-desk keyword matched* — and puts that in `reason`. Its notice is therefore a **different sentence** from the model's ("There is not enough here for the offline classifier to go on…" rather than "This does not look like a support request…"): it flags `"help"` as no-signal, and a keyword miss is not evidence that the employee wrote nonsense. The answer is still labelled `source: "offline"` (§3.4). |

---

## 4. How to run it

### Groq (the default — free, nothing to install)

The default provider is **Groq's free OpenAI-compatible cloud API**, so the AI
works without installing any model. Get a free key (no credit card) at
<https://console.groq.com>, then:

```bash
# 1. make the key available to the API process
export AI_API_KEY=gsk_…            # Windows PowerShell: $env:AI_API_KEY="gsk_…"

# 2. start the API as usual
cd backend
mkdir -p .data
npm run build
DB_FILE="$PWD/.data/hub.sqlite" npm start

# 3. start the web client in a second terminal
cd frontend && npm run dev
```

On Windows PowerShell the backend command is:

```powershell
$env:DB_FILE="$PWD\.data\hub.sqlite"; npm start
```

Then sign in, create an Employee, and use the free-text box + **AI Suggest** on
the New Request form — the fields come back tagged **"AI suggested"** and the
API reports `source: "ai"`.

Free-tier models change over time. `AI_MODEL` picks another one and
`GET /openai/v1/models` lists what your key can use, e.g.
`AI_MODEL=openai/gpt-oss-120b npm start`.

> **Why not `llama-3.1-8b-instant`?** It was the obvious small default, but Groq
> now returns `404 model_not_found` for it (as it does for
> `llama-3.3-70b-versatile`). The default is `openai/gpt-oss-20b`; the eval's
> `source: "ai"` assertion below is what turns a retired model name into a
> visible failure instead of a silent offline fallback.

### No key? It still works

With `AI_API_KEY` unset the provider answers `401`, and pressing **AI Suggest**
fills the form in from the offline keyword classifier, tagged **"Suggested
(offline)"** with a notice explaining what happened (§3.4). Everything else
behaves exactly as it did in v0.3, and nothing needs configuring to run the app
or the test suite. Prefer the strict provider-only behaviour? Start with
`AI_OFFLINE_FALLBACK=false`.

### Local model with Ollama (the alternative — free, no API key)

Prefer to run the model on your own machine? You can also use a local
[Ollama](https://ollama.com), which needs no API key. Point the API at it and
nothing else changes:

```bash
AI_PROVIDER_URL=http://localhost:11434/v1 AI_MODEL=llama3.2 npm start
```

### Pointing somewhere else

```bash
# another Groq model (list them: GET /openai/v1/models)
AI_MODEL=openai/gpt-oss-120b npm start

# any other OpenAI-compatible endpoint
AI_PROVIDER_URL=https://api.example.com/v1 AI_MODEL=gpt-4o-mini AI_API_KEY=sk-… npm start

# a local model served by vLLM or LM Studio
AI_PROVIDER_URL=http://localhost:8000/v1 AI_MODEL=mistral npm start

# a longer wait on a slow network or a slow local model
AI_TIMEOUT_MS=20000 npm start

# strict provider-only answers (no offline suggestion when nothing answers)
AI_OFFLINE_FALLBACK=false npm start

# switch the feature off completely
AI_ENABLED=false npm start
```

### Checking the endpoint directly

```bash
# token from POST /auth/login
curl -s http://localhost:3000/tickets/ai-suggest \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"My laptop screen is flickering and I cannot work"}'
```

Without a key (or any provider) the answer carries a **labelled offline
suggestion** (`"source":"offline"` plus a notice) rather than an error, so the
capability is demonstrable anywhere. With `AI_OFFLINE_FALLBACK=false` the same
call returns `{"suggestion":null,"error":"AI provider unavailable"}`.

### One command to show it working

```bash
node scripts/verify-ai-intake.mjs          # BASE_URL=… to point elsewhere
```

It logs in as the seeded Admin and drives six descriptions — five realistic ones
plus deliberately meaningless text — through `POST /tickets/ai-suggest`, printing
the category, priority, title, confidence, **source** and **relevance** for each,
then proves the call created no ticket and that `POST /tickets` still works by
hand. It passes with or without a key and says which mode it saw — 11 checks in
total. `node scripts/run-tests.mjs` runs it too.

### Verifying the model path without a provider (test double)

The offline classifier covers the no-key case, but it cannot cover the *model*
half of the contract: it is a different code path, deliberately labelled
`source: "offline"`. So the `source: "ai"` branch, the prompt that actually goes
out, and the model-path notices go unexercised on a machine without a key —
they are exactly what `npm run test:ai-eval` skips (cases 1–5).

`scripts/mock-ai-provider.mjs` fills that gap. It is an OpenAI-compatible **test
double** — a keyword table wearing a `/chat/completions` endpoint:

```bash
node scripts/mock-ai-provider.mjs                 # http://127.0.0.1:4321/v1

cd backend                                        # then start the API against it
DB_FILE="$PWD/.data/hub.sqlite" \
  AI_PROVIDER_URL=http://127.0.0.1:4321/v1 AI_MODEL=mock-model AI_API_KEY=mock-key \
  node dist/main.js

node scripts/verify-ai-intake.mjs                 # 11/11, now with source: "ai"
(cd backend && AI_PROVIDER_URL=http://127.0.0.1:4321/v1 AI_MODEL=mock-model \
   AI_API_KEY=mock-key npm run test:ai-eval)       # 9 passed, 0 skipped
```

It logs one line per call, including whether the system prompt it received
mentions `relevant`/`reason` — so a stale build still sending the old prompt shows
up as `prompt_mentions_relevant=false` instead of silently passing.
`MOCK_FAIL=401|429|500|prose|hang` makes every call fail on purpose, which drives
the retry, fallback and notice paths over real HTTP rather than through a stubbed
`fetch`.

> **What it proves, and what it does not.** It proves the plumbing: the request
> the service sends, JSON-mode handling, the `source: "ai"` branch, `relevant`
> passing through, and the notices. It proves **nothing about model quality** —
> the answers are rules, and pointing the app at it makes the API report
> `source: "ai"` for them, which is precisely what §3.4 exists to prevent. Use it
> to test the path; never to demonstrate the capability or in a deployment. A
> real key is the only way to check that a model obeys the prompt.

### Running the evals

```bash
cd backend
npm run test:ai-eval     # the 9 AI eval cases
npm test                 # every backend suite (the evals included)
cd .. && node scripts/run-tests.mjs   # everything: backend, live HTTP, AI intake, DOM E2E, browser E2E
```

---

## 5. Eval results

Nine cases in `backend/test/ai-intake-eval.spec.ts`, split by what they can
guarantee. Cases 1–5 require the **model itself** to answer (`source: "ai"`): a
labelled offline fallback is not an acceptable pass, so a retired or misspelled
`AI_MODEL` fails visibly instead of hiding.

| # | Case | Input | Expectation | Kind |
|---|---|---|---|---|
| 1 | Clear IT | "My monitor is broken and I need a replacement" | `category: 'IT'`, a valid priority, a usable title | real provider, skips if absent |
| 2 | Clear HR | "I need to update my emergency contact information" | `category: 'HR'` | real provider, skips if absent |
| 3 | Clear Maintenance | "The AC in conference room B is not working" | `category: 'Maintenance'` | real provider, skips if absent |
| 4 | Thin input | "help", "something is wrong" | still a valid category **and** priority (low confidence is fine), and still `relevant: true` — short is not the same as senseless | real provider, skips if absent |
| 5 | Mixed signals | "The office door lock is broken and I also need HR to update my badge" | exactly one valid category — never an invented one | real provider, skips if absent |
| 6 | Validation layer + offline classifier | 12 hostile values (`null`, `42`, `[]`, `{}`, `{category:'Finance',priority:'Urgent'}`, wrong types, missing fields) **and** fourteen realistic phrases (English, Arabic, French) through `classifyOffline` | every returned category/priority is in the domain enums; defaults are `IT`/`Medium`; a title is always derivable; the offline classifier gets IT/HR/Maintenance right in all three languages, caps its confidence at 0.6 (0.25 when nothing matches) and honours urgency wording. **v0.6:** `relevant` defaults to `true` for a missing/wrong-typed field (`null`, `'yes'`, `0`), an explicit `false` is honoured with a `reason`, every realistic phrase stays relevant, and text with no keyword signal at all is flagged | mocked, always runs |
| 7 | Invalid AI output | stubbed model reply `{"category":"Finance","priority":"Urgent",…}` | corrected to `IT`/`Medium`; the usable parts (the title) are kept; `source: "ai"` | mocked, always runs |
| 8 | Provider failure | stubbed `ECONNREFUSED`, stubbed `HTTP 503`, a prose answer, `AI_ENABLED=false` | never throws and never a `500`: with `AI_OFFLINE_FALLBACK=false` → `{ suggestion: null, error }`; with it on → a **labelled** `source: "offline"` suggestion; `AI_ENABLED=false` → the disabled error and no suggestion | mocked, always runs |
| 9 | Not a support request (v0.6) | stubbed `"relevant": false` + reason, a stubbed string `"relevant": "false"`, and `"asdfghjkl qwerty zxcvbn"` | the flag and its reason survive to the caller, the notice explains it; a real request and a *thin* real request both stay relevant and carry no notice; offline text with no signal is `relevant: false` with the rules' own wording; and it is still a usable `200` body — no exception, no block | mocked, always runs |

**Results on this machine.** With no `AI_API_KEY` the real-provider cases skip —
the out-of-the-box state on a machine that has not been given a key:

```text
$ cd backend && npm run test:ai-eval
 ✓ test/ai-intake-eval.spec.ts (9 tests | 5 skipped) 838ms
 Test Files  1 passed (1)
      Tests  4 passed | 5 skipped (9)
```

With a free Groq key the five real-provider cases run against the real model (the
four mocked cases always run). The confidences below are the model's own, recorded
on the v0.4 prompt — the offline classifier caps at 0.6 and returns 0.25 for
"help", which is how the two are told apart:

```text
$ AI_API_KEY=gsk_… npm run test:ai-eval        # recorded on the v0.4 spec (9 cases)
[ai-eval] clear IT: IT / High / "Broken monitor replacement" (confidence 0.97)
[ai-eval] clear HR: HR / Low / "Update emergency contact information" (confidence 0.95)
[ai-eval] clear Maintenance: Maintenance / High / "AC not working in conference room B" (confidence 0.95)
[ai-eval] thin input: IT / Low / "General help request" (confidence 0.3)
[ai-eval] thin input (second wording): IT / Medium / "General issue reported" (confidence 0.5)
[ai-eval] mixed signals: Maintenance / High / "Office door lock broken" (confidence 0.95)
 ✓ test/ai-intake-eval.spec.ts (8 tests)
      Tests  8 passed (8)
```

The skip is deliberate — a paid provider is not required to prove this work, and
a missing key must not turn a green suite red. A local Ollama
(`AI_PROVIDER_URL=http://localhost:11434/v1`) runs the same cases with no key.

**What the evals prove**

* Cases 1–3: the three departments are recognised from ordinary phrasing.
* Case 4: a useless description still yields a form the employee can submit —
  the feature degrades to "filled in with something valid", not to an error.
* Case 5: ambiguity produces *a* valid answer rather than an invented fourth
  department; the human corrects it, which is the whole design.
* Case 6: the validation layer is **total** — it holds for every hostile input,
  not just the ones we happened to think of in the service.
* Case 7: the specific failure the brief calls out (`Finance` / `Urgent`) is
  corrected before it can reach a DTO, a database column or a UI.
* Case 8: the product's promise that AI trouble never blocks ticket creation.
* Case 9 (v0.6): meaningless text is **reported**, not guessed at — and the two
  ways of getting that wrong are both pinned: a real request (or a merely short
  one) is never flagged, and the answer stays a usable `200` instead of becoming
  an error the form would have to handle.

Full-suite position after v0.6 (the v0.4 behaviour, plus the relevance eval case
and the 11th AI intake check):

```text
$ node scripts/run-tests.mjs
  backend suites        71 passed | 5 skipped (76)   (9 files)
  live HTTP checks      28/28
  AI intake checks      11/11
  DOM UI E2E            4 passed (4)
  browser E2E           6 checks (skips without Chromium)
  ALL TESTS PASSED
```

---

## 6. What "AI is advisory" means in practice

| Statement | Where it is true |
|---|---|
| The employee always has the final say | Every suggested field is editable; the tag disappears the moment they type (`RequesterView.tsx`) |
| The AI cannot create a ticket | `AiIntakeController` exposes only the suggest route; `AiIntakeModule` has no database access; `TicketsService.create()` is the only insert path |
| The AI cannot put a bad value in the database | `coerceSuggestion()` is the only constructor of a suggestion and can only emit `CATEGORIES` / `PRIORITIES` members |
| The AI cannot break the form | Every provider failure is caught and reported; the UI shows a notice and the employee proceeds manually — or gets a labelled offline suggestion |
| A rules-based answer is never passed off as the model's | The offline fallback returns `source: "offline"` + a `notice`, and the UI tags those fields **"Suggested (offline)"** (§3.4) |
| "I don't understand this text" is a first-class answer (v0.6) | `relevant: false` + `reason` + a `notice`; nothing is pre-filled, and the status stays `200` because the call succeeded (§3.6) |
| The AI cannot change an existing rule | `CreateTicketDto`, the lifecycle, RBAC and the audit trail are untouched, and all v0.3 tests pass unchanged |
| The AI's answer is attributable | It is never stored; the ticket records only what the employee submitted, and the `CREATED` event names the employee as the actor |

---

## 7. Requirements traceability

### BUILD

| Requirement | Status | Evidence |
|---|---|---|
| `AiIntakeService` in `backend/src/ai/` | ✅ | `ai-intake.service.ts` |
| Accepts plain text, returns a structured candidate, creates nothing | ✅ | `suggest()` returns `AiIntakeResult`; no repository injected |
| Exactly the four suggested fields (category, priority, title, confidence) | ✅ | `AiIntakeSuggestion`; v0.6 adds `relevant`/`reason` — a report on the *input*, not a fifth guess |
| **v0.6:** reports text it cannot read as a request (`relevant` + `reason`) without an error status | ✅ | `coerceRelevant()`, `classifyOffline()`, `relevanceNotice()`; eval case 9; §3.6 |
| Output validated against `CATEGORIES` / `PRIORITIES` | ✅ | `coerceSuggestion()`; eval cases 6–7 |
| Never passes garbage to the database | ✅ | validation layer + no DB access in the module |
| Advisory: employee can accept, edit or ignore | ✅ | `RequesterView.tsx` |
| `POST /tickets` unchanged; no auto-create | ✅ | `tickets.controller.ts`, `dto.ts` untouched |
| OpenAI-compatible provider, `AI_PROVIDER_URL` / `AI_MODEL` | ✅ | §2 configuration, `callProvider()` |
| Graceful fallback when the provider is down | ✅ | `suggest()` catch; eval case 8 (both the strict and the offline branch) |
| Works with no key or model installed (labelled offline fallback) | ✅ | `classifyOffline()` + `AI_OFFLINE_FALLBACK` (default on); `scripts/verify-ai-intake.mjs` |
| `POST /tickets/ai-suggest`, authenticated, read-only | ✅ | `ai-intake.controller.ts`; §2 contract |
| Frontend: free text, AI Suggest, prefill, marking, fallback notice | ✅ | `RequesterView.tsx` + `styles.css` |
| Frontend: no prefill and a notice when the text is not a request (v0.6) | ✅ | `RequesterView.tsx` (`suggestion.relevant === false` branch; error for a model verdict, info for the rules' weaker "nothing matched") |
| `AI_ENABLED`, `AI_TIMEOUT_MS`, `AI_OFFLINE_FALLBACK` (+ `AI_API_KEY`) | ✅ | §2 configuration |

### PROVE

| Requirement | Status | Evidence |
|---|---|---|
| All existing deterministic tests still green | ✅ | `npm test` → 71 passed, 5 skipped (76); `run-tests.mjs` → ALL TESTS PASSED |
| `node scripts/run-tests.mjs` still passes end to end | ✅ | 28/28 live HTTP, 11/11 AI intake, 4/4 DOM, full run exit 0 |
| 5–9 eval cases, covering the listed scenarios | ✅ | 9 cases in `ai-intake-eval.spec.ts` |
| Cases 1–5 real when a provider exists, skipped otherwise | ✅ | `providerAvailable` probe in `beforeAll`; `skip()` in the test body |
| Cases 6–9 mocked and deterministic | ✅ | stubbed `globalThis.fetch`, no network |
| `test:ai-eval` npm script | ✅ | `backend/package.json` |
| The capability is demonstrable with or without a key | ✅ | `scripts/verify-ai-intake.mjs` — 11 checks, reports which source answered and whether the text read as a request |
| The **model** path is verifiable with no provider at all | ✅ | `scripts/mock-ai-provider.mjs` (test double): 11/11 with `source: "ai"` and 9/9 eval cases unskipped; `MOCK_FAIL=…` drives the fallback over real HTTP |

### DELIVER

| Requirement | Status | Evidence |
|---|---|---|
| All new code inside the existing repo | ✅ | `backend/src/ai/`, `frontend/src/`, `backend/test/` |
| New backend files under `backend/src/ai/` | ✅ | service, controller, dto, module |
| One repeatable command for the evals | ✅ | `cd backend && npm run test:ai-eval` |
| Full suite includes the new eval | ✅ | `npm test` picks up `test/**/*.spec.ts`; verified in `run-tests.mjs` |
| `docs/week4-production-ai.md` | ✅ | this file |
| README v0.4 block, env vars, `test:ai-eval` | ✅ | `README.md` |

---

## 8. Boundaries

Explicitly **not** built, and why:

* **No RAG, embeddings or vector store.** There is no knowledge base to retrieve
  from — the task is four-field classification, and a prompt plus validation is
  the right size for it.
* **No auto-creation, no auto-assignment.** Authority stays with the employee
  and with the existing service rules (§3.1).
* **No streaming responses.** The suggestion is one small JSON object; streaming
  would complicate the contract for no benefit.
* **No fine-tuning or eval harness beyond the 9 cases.** The eval proves the
  contract and the safety net; it deliberately does not attempt to score model
  quality, which changes with every model release.
* **No `4xx` for "this doesn't make sense".** The API call succeeded, so the
  status stays `200` and the signal rides in the body (`relevant`, §3.6).
  Rejecting nonsense with an error status would make the *assistant's opinion*
  the thing the form has to handle, which is the coupling §3.3 exists to avoid.
* **No AI on the agent side.** The capability is intake only.
* **No new dependency, no telemetry, no prompt/response storage.** The request
  text is sent to the configured provider and the answer is not persisted.
* **The offline classifier is a fallback, not the AI.** It exists so the
  capability can be demonstrated without downloading a model; it is labelled in
  the API and the UI, capped at 0.6 confidence, and `AI_OFFLINE_FALLBACK=false`
  removes it entirely. The real capability remains the model path.
* **`scripts/mock-ai-provider.mjs` is test tooling, not a feature.** It ships so
  the model path can be exercised without a key, and it says so in its own
  banner. It is never wired into the app, never started by `run-tests.mjs`, and
  never a demonstration of the capability — anything derived from a keyword table
  must not be presented as a model's work (§3.4).
