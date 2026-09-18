# Week 4 — v0.4 AI-Assisted Request Intake

**Project:** Internal Operations Service Hub (Eurisko Hub)
**Capability:** AI-assisted Request Intake — the AI suggests the structured fields, the employee decides
**Stack:** React (Vite) → NestJS → SQLite (TypeORM), one repository
**Status:** delivered; every existing v0.3 behaviour and test is unchanged and still passing

This is the Week 4 delivery record. Like the Week 3 record, every claim here maps
to a file in this repository and to a command you can run.

---

## 1. The capability

An employee who does not know whether their problem is "IT" or "Maintenance", or
how urgent it is, can describe it in their own words. The AI reads that text and
**suggests** three things — the category, the priority and a cleaned-up title —
which appear in the New Request form as an editable starting point.

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
| Suggestion arrives | Category, Priority and Title are pre-filled, each tagged **AI suggested** and highlighted |
| Edits any field | That field's highlight and tag disappear — the value is now theirs |
| Presses **Open ticket** | The ordinary `POST /tickets` runs with whatever the form now holds |
| AI is down or disabled | A non-blocking notice: *"AI suggestions unavailable — fill in the fields manually."* The form works exactly as before |

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
| `backend/test/ai-intake-eval.spec.ts` | The 5–8 eval cases (this delivery ships 8) |
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

// 200 — the AI answered (values are always inside the domain enums)
{ "suggestion": { "category": "IT", "priority": "High",
                  "title": "Laptop screen flickering", "confidence": 0.92 } }

// 200 — the AI is disabled, unreachable, too slow or answered unusably
{ "suggestion": null, "error": "AI provider unavailable" }
{ "suggestion": null, "error": "AI suggestions are disabled (AI_ENABLED=false)." }

// 400 — the text itself is missing/too short (normal DTO validation)
// 401 — no or invalid bearer token
```

Note what is **not** in the contract: there is no way for this call to create,
change or delete a ticket, and no status code that means "the ticket was
affected". It is a read-only advisory call.

### Configuration (all optional, all read per call)

| Variable | Default | Meaning |
|---|---|---|
| `AI_ENABLED` | `true` | `false` switches the feature off entirely (the endpoint then answers with the disabled error, and the form still works) |
| `AI_PROVIDER_URL` | `http://localhost:11434/v1` | Any OpenAI-compatible base URL (Ollama's default is exactly this) |
| `AI_MODEL` | `llama3.2` | Model name sent to the provider |
| `AI_TIMEOUT_MS` | `5000` | Hard cap on the provider call (AbortController) |
| `AI_API_KEY` | *(unset)* | Optional; when set it is sent as `Authorization: Bearer …` for hosted providers |

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
| No provider listening | `{ suggestion: null, error: "AI provider unavailable" }`; the form shows a non-blocking notice |
| Provider returns `500`/`503` | Same graceful result |
| Provider is too slow | `AbortController` cancels at `AI_TIMEOUT_MS`; same graceful result |
| Provider returns prose instead of JSON | The raw text is parsed defensively; if no JSON object can be extracted, the employee still gets a **validated defaults-based suggestion** (a filled-in form is more useful than an error) |
| Partial or wrong-typed JSON | The validation layer fills the gaps |
| `AI_ENABLED=false` | `{ suggestion: null, error: "AI suggestions are disabled…" }` |

The endpoint always answers `200` with a body the client understands, never a
`500`; `service.suggest()` catches everything. The only `4xx` responses are the
ordinary ones: `400` for a too-short `text` and `401` without a token.

### 3.4 Smaller decisions

* **No new dependency.** The provider call uses Node's built-in `fetch` (Node
  20+), so the dependency tree is unchanged.
* **Any OpenAI-compatible provider.** Ollama, vLLM, LM Studio, or a hosted API —
  only the base URL and model differ.
* **`temperature: 0`.** Classification should be repeatable, not creative.
* **A JSON-only prompt.** The system prompt asks for the exact four fields, states
  the allowed values, and includes one example per category; defensive parsing
  exists because the model may still disobey.

---

## 4. How to run it

### It already works with no AI at all

The default configuration points at `http://localhost:11434/v1`. If nothing is
listening there, pressing **AI Suggest** shows *"AI suggestions unavailable —
fill in the fields manually."* and the form behaves exactly as it did in v0.3.
Nothing needs configuring to run the app or the test suite.

### Local model with Ollama (optional, free, no API key)

```bash
# 1. install Ollama (https://ollama.com), then:
ollama pull llama3.2          # or: ollama pull mistral
ollama serve                  # listens on http://localhost:11434 — the default AI_PROVIDER_URL

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
the New Request form.

### Pointing somewhere else

```bash
# a different Ollama model
AI_MODEL=mistral npm start

# a hosted OpenAI-compatible endpoint
AI_PROVIDER_URL=https://api.example.com/v1 AI_MODEL=gpt-4o-mini AI_API_KEY=sk-… npm start

# a longer wait for a slow local model
AI_TIMEOUT_MS=20000 npm start

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

Without a provider the answer is
`{"suggestion":null,"error":"AI provider unavailable"}` — the graceful path.

### Running the evals

```bash
cd backend
npm run test:ai-eval     # the 8 AI eval cases
npm test                 # every backend suite (the evals included)
cd .. && node scripts/run-tests.mjs   # everything: backend, live HTTP, DOM E2E, browser E2E
```

---

## 5. Eval results

Eight cases in `backend/test/ai-intake-eval.spec.ts`, split by what they can
guarantee:

| # | Case | Input | Expectation | Kind |
|---|---|---|---|---|
| 1 | Clear IT | "My monitor is broken and I need a replacement" | `category: 'IT'`, a valid priority, a usable title | real provider, skips if absent |
| 2 | Clear HR | "I need to update my emergency contact information" | `category: 'HR'` | real provider, skips if absent |
| 3 | Clear Maintenance | "The AC in conference room B is not working" | `category: 'Maintenance'` | real provider, skips if absent |
| 4 | Thin input | "help", "something is wrong" | still a valid category **and** priority (low confidence is fine) | real provider, skips if absent |
| 5 | Mixed signals | "The office door lock is broken and I also need HR to update my badge" | exactly one valid category — never an invented one | real provider, skips if absent |
| 6 | Validation layer | 12 hostile values: `null`, `42`, `[]`, `{}`, `{category:'Finance',priority:'Urgent'}`, wrong types, missing fields | every returned category/priority is in the domain enums; defaults are `IT`/`Medium`; a title is always derivable | mocked, always runs |
| 7 | Invalid AI output | stubbed model reply `{"category":"Finance","priority":"Urgent",…}` | corrected to `IT`/`Medium`; the usable parts (the title) are kept | mocked, always runs |
| 8 | Provider failure | stubbed `ECONNREFUSED`, stubbed `HTTP 503`, `AI_ENABLED=false` | `{ suggestion: null, error }`; **never throws**, never a `500` | mocked, always runs |

**Results on this machine** (no AI provider running — the default state):

```text
$ cd backend && npm run test:ai-eval
 ✓ test/ai-intake-eval.spec.ts (8 tests | 5 skipped) 37ms
 Test Files  1 passed (1)
      Tests  3 passed | 5 skipped (8)
```

The 5 skipped cases are the real-provider ones: with Ollama running
(`ollama serve`, `ollama pull llama3.2`) the same command runs all 8 for real.
The skip is deliberate — a paid provider is not required to prove this work, and
a missing local model must not turn a green suite red.

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

Full-suite position after v0.4 (unchanged behaviour plus the new eval):

```text
$ node scripts/run-tests.mjs
  backend suites        51 passed | 5 skipped (56)   (6 files)
  live HTTP checks      28/28
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
| The AI cannot break the form | Every provider failure is caught and reported; the UI shows a notice and the employee proceeds manually |
| The AI cannot change an existing rule | `CreateTicketDto`, the lifecycle, RBAC and the audit trail are untouched, and all v0.3 tests pass unchanged |
| The AI's answer is attributable | It is never stored; the ticket records only what the employee submitted, and the `CREATED` event names the employee as the actor |

---

## 7. Requirements traceability

### BUILD

| Requirement | Status | Evidence |
|---|---|---|
| `AiIntakeService` in `backend/src/ai/` | ✅ | `ai-intake.service.ts` |
| Accepts plain text, returns a structured candidate, creates nothing | ✅ | `suggest()` returns `AiIntakeResult`; no repository injected |
| Exactly the four fields (category, priority, title, confidence) | ✅ | `AiIntakeSuggestion` |
| Output validated against `CATEGORIES` / `PRIORITIES` | ✅ | `coerceSuggestion()`; eval cases 6–7 |
| Never passes garbage to the database | ✅ | validation layer + no DB access in the module |
| Advisory: employee can accept, edit or ignore | ✅ | `RequesterView.tsx` |
| `POST /tickets` unchanged; no auto-create | ✅ | `tickets.controller.ts`, `dto.ts` untouched |
| OpenAI-compatible provider, `AI_PROVIDER_URL` / `AI_MODEL` | ✅ | §2 configuration, `callProvider()` |
| Graceful fallback when the provider is down | ✅ | `suggest()` catch; eval case 8 |
| `POST /tickets/ai-suggest`, authenticated, read-only | ✅ | `ai-intake.controller.ts`; §2 contract |
| Frontend: free text, AI Suggest, prefill, marking, fallback notice | ✅ | `RequesterView.tsx` + `styles.css` |
| `AI_ENABLED`, `AI_TIMEOUT_MS` (+ `AI_API_KEY`) | ✅ | §2 configuration |

### PROVE

| Requirement | Status | Evidence |
|---|---|---|
| All existing deterministic tests still green | ✅ | `npm test` → 51 passed, 5 skipped (56); `run-tests.mjs` → ALL TESTS PASSED |
| `node scripts/run-tests.mjs` still passes end to end | ✅ | 28/28 live, 4/4 DOM, full run exit 0 |
| 5–8 eval cases, covering the listed scenarios | ✅ | 8 cases in `ai-intake-eval.spec.ts` |
| Cases 1–5 real when a provider exists, skipped otherwise | ✅ | `providerAvailable` probe in `beforeAll`; `skip()` in the test body |
| Cases 6–8 mocked and deterministic | ✅ | stubbed `globalThis.fetch`, no network |
| `test:ai-eval` npm script | ✅ | `backend/package.json` |

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
* **No fine-tuning or eval harness beyond the 8 cases.** The eval proves the
  contract and the safety net; it deliberately does not attempt to score model
  quality, which changes with every model release.
* **No AI on the agent side.** The capability is intake only.
* **No new dependency, no telemetry, no prompt/response storage.** The request
  text is sent to the configured provider and the answer is not persisted.
