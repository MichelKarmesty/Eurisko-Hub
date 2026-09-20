# Internal Operations Service Hub

Eurisko Hub gives employees one place to ask for help from IT, HR, or
Maintenance. Instead of chasing requests through WhatsApp messages and
scattered emails, people can submit a ticket, follow its progress, and see how
it was resolved.

> **Week 3 status — v0.3 integrated product slice.** One narrow, user-facing
> flow is complete across all three tiers: **a requester opens a Service
> Request, a department agent claims it, the agent resolves it with a note, and
> the requester sees it Resolved.** React frontend → NestJS backend → real
> SQLite persistence, behind an explicit request/response contract, with an
> authorization rule (allowed + denied), deliberate rejection of invalid input,
> and an automated test suite (business rule, backend↔database integration, HTTP
> contract/regression, DOM UI E2E, and a real-browser Playwright E2E). The Admin
> role is governed too: assign an unclaimed ticket, override with a recorded
> reason, or cancel softly — never delete. Full delivery record:
> [`docs/week3-full-stack-delivery.md`](docs/week3-full-stack-delivery.md).

> **Week 4 status — v0.4 AI-assisted Request Intake.** An employee can describe
> the problem in their own words and press **AI Suggest**: the AI proposes a
> Category, a Priority and a cleaned-up Title, which appear in the New Request
> form as an editable starting point. The AI is **advisory only** — it never
> creates a ticket and never touches the database, every suggested value is
> validated against the domain enums before it is returned, the employee can
> change or ignore all of it, and `POST /tickets` stays exactly as it was. If no
> AI provider is configured or reachable, the form simply carries on by hand.
> Full delivery record:
> [`docs/week4-production-ai.md`](docs/week4-production-ai.md).

> **v0.5 status — password recovery + any real email address.** A forgotten
> password can be **reset** (never "retrieved": passwords are bcrypt-hashed) from
> a one-time emailed link, and a signed-in user can **change** their own
> password with the current one. With no mail server configured the reset link is
> printed to the backend console and, outside production, returned to the UI — so
> the flow works with nothing installed, exactly like the offline AI classifier.
> Set `SMTP_HOST` (Gmail / Outlook / any mail server) or `MAIL_WEBHOOK_URL` /
> `RESEND_API_KEY` for real email. Accounts accept
> **any valid email address** — Gmail, Hotmail/Outlook, Yahoo or a company domain
> — not just `@eurisko.com`. Design record:
> [`docs/decisions/ADR-005.md`](docs/decisions/ADR-005.md).

## Repository layout

| Folder | What it is |
|---|---|
| [`backend/`](backend/) | NestJS + TypeORM API (auth with password reset/change, RBAC, tickets with claim/status flow, durable history, advisory AI intake under `src/ai/`, console/HTTP mail under `src/mail/`) |
| [`frontend/`](frontend/) | React + Vite web client (requester dashboard with AI Suggest, agent queue, admin view) |
| [`docs/`](docs/) | Product spec, architecture, data model, ADRs (incl. [ADR-006](docs/decisions/ADR-006.md), the advisory-AI scope decision), API reference, Week 3 & Week 4 delivery records |
| [`scripts/`](scripts/) | [`verify-slice.mjs`](scripts/verify-slice.mjs) live HTTP checks · [`run-tests.mjs`](scripts/run-tests.mjs) one-command test suite · [`verify-ai-intake.mjs`](scripts/verify-ai-intake.mjs) AI intake checks · [`ai-provider-doctor.mjs`](scripts/ai-provider-doctor.mjs) find a working AI provider |
| [`e2e/`](e2e/) | End-to-end tests: DOM-level (default) and real-browser (optional) |

## Requirements

- **Node.js 20.19+** (Node 22 LTS recommended) with npm
- No database server needed — the API persists to a local SQLite file

## Install

```bash
git clone https://github.com/MichelKarmesty/Eurisko-Hub.git
cd Eurisko-Hub

(cd backend  && npm install)
(cd frontend && npm install)
(cd e2e      && npm install)   # only needed for the automated E2E tests
```

## Run the app (quick start)

The API and the web client are **two separate processes**. Run each one in its
own terminal and leave both running. `npm run build` only compiles the backend
into `dist/` — it does **not** start it; `npm start` does. If the client cannot
reach the API, sign-in fails with `Request failed with status 500` (see
[Troubleshooting](#troubleshooting)).

**1. Backend API** — http://localhost:3000

```bash
cd backend
mkdir -p .data                       # DB_FILE's folder (gitignored, absent in a fresh clone)
npm run build
DB_FILE="$PWD/.data/hub.sqlite" npm start
```

Wait until it prints `Eurisko Hub API listening on http://localhost:3000` before
starting the client — if that line never appears, sign-in in the browser will
fail with a `500`. On Windows PowerShell the same commands are
`New-Item -ItemType Directory -Force .data | Out-Null`, then
`$env:DB_FILE="$PWD\.data\hub.sqlite"; npm start`.

First boot seeds **one** account — the Admin: `admin@eurisko.com` / `Admin123!`
(override with `ADMIN_EMAIL` / `ADMIN_PASSWORD`). There is **no public
registration** and no demo data (ADR-004): sign in as the Admin and create
everyone else from the **Users** tab. Set `DB_FILE` so tickets survive restarts;
without it the database is in-memory.

`admin@eurisko.com` is only the development **default**: the application accepts
**any valid email address** — `someone@gmail.com`, `someone@hotmail.com`,
`someone@outlook.com`, `someone@yahoo.com`, or a company domain. The Admin should
use a real, deliverable address if password-reset emails are to reach people.

If a database ever has **no Admin at all**, the backend seeds one on the next
boot — so an instance created before the Admin email changed is recovered rather
than locked out. An existing Admin is never duplicated or reset.

**2. Web client** (second terminal) — http://localhost:5173

```bash
cd frontend
npm run dev
```

The Vite dev server proxies `/api` to the backend on port 3000.

**3. Create the accounts you want to test with.** Open http://localhost:5173 and
sign in as the Admin (`admin@eurisko.com` / `Admin123!`), then open the
**👥 Users** tab and use **Create account** to add people — for example an
**Employee** (Requester), an **IT Agent**, an **HR Agent** and a
**Maintenance Agent**. Only an Admin can create accounts, and only an Admin sees
the Users tab; the login screen is sign-in plus **Forgot password?** (v0.5), and
any real email address is accepted for the people you create.

To also run the live HTTP definition-of-done checks (these provision their own
throwaway test accounts through the Admin API), with the backend running:

```bash
node scripts/verify-slice.mjs full
```

## Exercise the slice (5 minutes)

1. Open http://localhost:5173 and sign in as the Admin (`admin@eurisko.com` /
   `Admin123!`). On the **👥 Users** tab, create two accounts you will use:
   an **Employee** (e.g. `rana@eurisko.com`) and an **IT Agent**
   (e.g. `karim@eurisko.com`). Remember the passwords you set.
2. Click **Switch account** and sign in as the **Employee**. Under
   **New request**, enter a title, choose **IT** / **High**, add a description,
   and click **Open ticket** — it shows as `Open` in **My tickets**.
3. Click **Switch account** → sign in as the **IT Agent**. The ticket is in the
   **Department queue**; click **Claim** — it moves to **My work · In Progress**.
4. Click **Mark Resolved** *without* typing a note. The backend refuses the
   request and the form shows the validation message inline (the deliberate
   invalid request; nothing is saved).
5. Type a resolution note (e.g. *"Replaced the display cable."*) and click
   **Mark Resolved** — the ticket moves to **Resolved by me**.
6. Switch back to the **Employee**. **My tickets** now shows `Resolved` with the
   note. Expand **▾ History** to see `CREATED → CLAIMED → RESOLVED`, who did it,
   and when.
7. Optional — Admin actions: sign in as **Admin** → **Tickets** tab. On an
   unclaimed ticket use **Assign** (give it an owner) or **Cancel request…**
   (retire a duplicate with a reason); on an in-progress ticket, resolving asks
   for an **override reason** because the Admin is not the assignee. On the
   **Users** tab, **Delete** removes any account (Employee, agent, or another
   Admin): the row leaves the list and that person can no longer sign in.

Requests the API refuses (e.g. an employee trying to change a status) surface as
a visible notice instead of failing silently.

## AI-assisted intake (v0.4)

On the **New request** form an employee can describe the problem in their own
words and press **AI Suggest**. The AI returns a *suggestion* for Category,
Priority and Title; the fields are pre-filled and tagged **AI suggested**, the
tag clears as soon as the employee edits a field, and **Open ticket** still calls
the ordinary `POST /tickets`. The AI never creates a ticket and never writes to
the database. Full detail: [`docs/week4-production-ai.md`](docs/week4-production-ai.md).

**The default provider is Groq's free cloud API** — nothing to install, no
credit card. Get a free key at <https://console.groq.com>, then start the
backend with it:

```bash
export AI_API_KEY=gsk_…        # Windows PowerShell: $env:AI_API_KEY="gsk_…"
cd backend && npm start
```

`AI_MODEL` defaults to `openai/gpt-oss-20b`. Free model names change over time,
so list what your key can use before changing it:
`curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $AI_API_KEY"`.

**It works with no key at all.** With no `AI_API_KEY` the provider answers `401`
and the built-in **offline classifier** still fills the form in — clearly
labelled: the API returns `source: "offline"` with a notice, and the UI tags
those fields **"Suggested (offline)"** instead of "AI suggested", so a
rules-based answer is never passed off as the model's. Set
`AI_OFFLINE_FALLBACK=false` for the strict `{ suggestion: null, error }`
behaviour. Nothing about running the app or the test suite requires a key.

| Variable | Default | Purpose |
|---|---|---|
| `AI_ENABLED` | `true` | `false` disables the feature (the endpoint answers with a clear disabled message) |
| `AI_PROVIDER_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible base URL |
| `AI_MODEL` | `openai/gpt-oss-20b` | Groq's fast free model (names change over time) |
| `AI_TIMEOUT_MS` | `15000` | Hard cap on the provider call |
| `AI_OFFLINE_FALLBACK` | `true` | Suggest from the offline keyword classifier when no model answers (always labelled); `false` = strict provider-only |
| `AI_API_KEY` | *(unset)* | **Required for Groq** — free key from console.groq.com |

**Prefer to run the model locally?** You can also use a local Ollama, which needs
no API key: install it from <https://ollama.com> and start the backend with
`AI_PROVIDER_URL=http://localhost:11434/v1 AI_MODEL=llama3.2 npm start`.

To point anywhere else OpenAI-compatible, set the same two variables, e.g.
`AI_PROVIDER_URL=https://api.example.com/v1 AI_MODEL=… AI_API_KEY=… npm start`.

**See it working in one command** (with the API running; passes with or without
a key and says which source answered):

```bash
node scripts/verify-ai-intake.mjs
```

## Password recovery & any email address (v0.5)

**Passwords are bcrypt-hashed, so they can never be *retrieved*** — the capability
is to **reset** one, or to **change** it from inside the app. Three routes cover
that, and all of them accept any real email address:

| I want to… | Where | What happens |
|---|---|---|
| Reset a forgotten password | **Log in → Forgot password?** (or `POST /auth/forgot-password`) | A one-time, 30-minute link is sent to the account's email; the same generic answer is returned whether or not the address exists, so the form cannot be used to discover accounts. |
| Finish a reset | The link opens **Set a new password** (or `POST /auth/reset-password`) | The token is accepted once, the new password (8+ characters) is saved, and the old one stops working. |
| Change my password while signed in | **Change password** in the top bar (or `POST /auth/change-password`) | The current password is required; a session token alone cannot take the account over. |

**It works with no mail server.** By default the backend has no provider
configured, so the reset message (including the link) is printed to the backend
console, and outside production the one-time token is also returned to the UI so
the whole flow is demonstrable in one browser. For real email — Gmail,
Outlook/Hotmail, a company server or any SMTP provider — set the SMTP variables
and restart the backend (the SMTP client is built in; no package to install):

```bash
# option A — any standard mail server (Gmail / Outlook / company SMTP)
export SMTP_HOST=smtp.gmail.com          # Outlook/Hotmail: smtp-mail.outlook.com
export SMTP_PORT=587                     # 587 = STARTTLS · 465 = implicit TLS
export SMTP_USER=you@gmail.com
export SMTP_PASS=your-app-password       # an App Password, not your normal login
export MAIL_FROM="Eurisko Hub <you@gmail.com>"

# option B — any HTTPS endpoint that accepts { to, subject, text }
export MAIL_WEBHOOK_URL=https://mailer.example.com/send
export MAIL_WEBHOOK_TOKEN=…            # optional bearer token

# option C — Resend's HTTP API (https://resend.com)
export RESEND_API_KEY=re_…
export MAIL_FROM="Eurisko Hub <no-reply@your-domain.com>"
```

| Variable | Default | Purpose |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:5173` | Front of the reset link (`…/?resetToken=…`) |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | How long a reset link stays valid |
| `SMTP_HOST` / `SMTP_PORT` | *(unset)* / `587` | Standard SMTP server (Gmail, Outlook, company); `SMTP_SECURE=true` for port 465 |
| `SMTP_USER` / `SMTP_PASS` | *(unset)* | SMTP login — use an **App Password** when 2FA is on |
| `MAIL_WEBHOOK_URL` / `MAIL_WEBHOOK_TOKEN` | *(unset)* | Optional HTTP mail relay |
| `RESEND_API_KEY` / `MAIL_FROM` | *(unset)* | Optional Resend delivery |
| `PASSWORD_RESET_RETURN_TOKEN` | `true` outside production | Return the one-time token in the API response (development only; **always off** when `NODE_ENV=production`) |

**Any real email address is accepted — `@eurisko.com` is only the development
default.** Account creation, login, password reset and every example work
identically for `someone@gmail.com`, `someone@hotmail.com`,
`someone@outlook.com`, `someone@yahoo.com` or a company domain; a malformed
address is the only thing the API rejects (`400`). See
[`docs/decisions/ADR-005.md`](docs/decisions/ADR-005.md) and
[`docs/security.md`](docs/security.md).

## Run the automated tests

### Everything, with one command

```bash
node scripts/run-tests.mjs
```

It builds the backend, runs all backend suites, starts an isolated backend on a
free port with a throwaway SQLite file, runs the live HTTP checks, the DOM UI
E2E, and the real-browser E2E, then tears everything down. It exits non-zero if
any layer fails (a browser E2E that cannot obtain a Chromium is reported as
skipped, not failed).

### Layer by layer

**Backend tests** (self-contained — no server, no database file needed):

```bash
cd backend
npm test                  # all suites
npm run test:unit         # business rule: the ticket lifecycle
npm run test:integration  # backend <-> real SQL database
npm run test:api          # HTTP contract, authorization (allowed/denied), regression
npm run test:ai-eval      # v0.4: the 8 AI intake eval cases
```

| Requirement | Command | File |
|---|---|---|
| Automated test for a business rule | `npm run test:unit` | `backend/test/domain-rules.spec.ts` |
| Integration test backend ↔ database | `npm run test:integration` | `backend/test/tickets.database.integration.spec.ts` |
| HTTP contract + authorization + regression | `npm run test:api` | `backend/test/tickets.api.spec.ts` |
| Admin seed can never lock a database out | `npm test` | `backend/test/admin-seed.spec.ts` |
| Admin account deletion: contract, authorization, audit | `npm test` | `backend/test/admin-user-deletion.spec.ts` |
| v0.4: AI intake evals (5 real-or-skip + 3 mocked) | `npm run test:ai-eval` | `backend/test/ai-intake-eval.spec.ts` |
| v0.5: password recovery/change + any-email rule | `npm test` | `backend/test/auth-password.spec.ts` |

**UI E2E — two layers:**

* **DOM E2E (fast, no browser needed):** renders the real React app in jsdom
  against a live API.

  ```bash
  # terminal A — start the API
  cd backend && npm run build
  mkdir -p .data && DB_FILE="$PWD/.data/e2e.sqlite" npm start

  # terminal B — run the E2E (waits for the API, provisions its test fixtures)
  cd e2e
  npm run test:ui
  ```

  Point it elsewhere with `API_URL=http://127.0.0.1:3100 npm run test:ui`.
  The four tests cover the resolve slice, the Admin override (ADR-002), Admin
  assign/cancel (ADR-003), and the first run itself (the Admin creates an
  account in the Users tab and signs in as it).

* **Real-browser E2E (Playwright — self-contained, self-installing):**

  ```bash
  node scripts/run-browser-e2e.mjs
  ```

  It starts its own isolated backend and Vite dev server, makes sure a Chromium
  is available (`CHROME_PATH`, a repo-local binary, or
  `npx playwright install chromium`), drives the real UI, then tears everything
  down. If no browser can launch (e.g. missing system libraries) it **skips**
  with a clear message — set `STRICT_BROWSER_E2E=1` to fail instead.

Both layers run as part of `node scripts/run-tests.mjs`.

**Live HTTP definition-of-done checks** (backend running, from the repo root):

```bash
node scripts/verify-slice.mjs full      # provisions personas + checks the flow
node scripts/verify-slice.mjs persist   # restart the backend, then prove state survived
```

## API contract (summary)

Base URL `http://localhost:3000`; authenticated calls send
`Authorization: Bearer <accessToken>`; errors are
`{ statusCode, message, error }`. The full reference is
[`docs/api.md`](docs/api.md) and the slice contract is written out in
[`docs/week3-full-stack-delivery.md`](docs/week3-full-stack-delivery.md).

| Method & path | Who | Purpose |
|---|---|---|
| `POST /auth/login` | public | sign in (no registration; any valid email domain) |
| `POST /auth/forgot-password` | public | email a one-time reset link; always the same generic answer |
| `POST /auth/reset-password` | public | set a new password with the one-time token (single use, 30 min) |
| `POST /auth/change-password` | authenticated | change your own password (current password required) |
| `POST /tickets` | any authenticated user | open a request (title, description, category, priority) |
| `GET /tickets` | role-scoped | requester: own tickets · agent: own department's `Open` queue (`?mine=true` for claimed) · admin: all |
| `PATCH /tickets/:id/claim` | matching agent | claim an `Open` ticket → `In Progress` |
| `PATCH /tickets/:id/assign` | Admin | give an `Open`, unclaimed ticket a matching agent (ADR-003) |
| `PATCH /tickets/:id/status` | **assigned agent or Admin override** | advance `Open → In Progress → Resolved`; a note is required to resolve. An Admin acting on a ticket not assigned to them must also send `overrideReason` (`400` otherwise), recorded as `ADMIN_OVERRIDE` (ADR-002) |
| `PATCH /tickets/:id/cancel` | Admin | soft-cancel a request with a reason — kept and audited, never deleted (ADR-003) |
| `GET /tickets/:id/history` | ticket readers | durable `CREATED → CLAIMED/ASSIGNED → RESOLVED` trail, plus `ADMIN_OVERRIDE` / `CANCELLED` where applicable |
| `GET /users` · `POST /users` · `PATCH /users/:id/role` · `DELETE /users/:id` | Admin | manage accounts: list, create, change role, **delete any account** (the login is revoked at once; an account with tickets/history is kept for audit, one with none is really deleted). A role change can never empty the Admin seat: you cannot change your own Admin role, and the last active Admin cannot be demoted |
| `GET /admin/stats` | Admin | company-wide counters |

## Roles and access

- **Employee (Requester):** opens tickets and follows their own.
- **IT / HR / Maintenance Agent:** works a department queue; may only read and
  claim tickets in their own department; cannot resolve a ticket assigned to a
  colleague.
- **Admin:** sees every ticket, manages users, and can **assign** an unclaimed
  ticket to a matching agent, **cancel** a request softly (never a hard delete),
  or change any ticket's status — but a change to a ticket they are not assigned
  to is an explicit **override** that requires a reason and is written to the
  ticket history (ADR-002), so an unclaimed ticket is never silently closed.
  On the **Users** tab the Admin can also **delete any account** — an Employee,
  an IT/HR/Maintenance agent, or another Admin. The deleted person disappears
  from the list and can no longer sign in; an account with tickets/history is
  kept for audit (deactivated) while an account with none is really deleted.
  An Admin can never delete their own account, and the last active Admin can
  never be deleted or demoted (so the hub can't be locked out).

Role checks happen on the server only — the client never enforces permissions.

## Documentation

Read in this order:

1. [`docs/product-spec.md`](docs/product-spec.md)
2. [`docs/architecture.md`](docs/architecture.md)
3. [`docs/data-model.md`](docs/data-model.md)
4. [`docs/decisions/ADR-001.md`](docs/decisions/ADR-001.md) — manual queue claiming
5. [`docs/decisions/ADR-002.md`](docs/decisions/ADR-002.md) — Admin override policy
6. [`docs/decisions/ADR-003.md`](docs/decisions/ADR-003.md) — Admin assign & soft cancel
7. [`docs/decisions/ADR-004.md`](docs/decisions/ADR-004.md) — Admin-provisioned accounts, no public registration
8. [`docs/decisions/ADR-005.md`](docs/decisions/ADR-005.md) — password recovery/change and any-real-email accounts
9. [`docs/api.md`](docs/api.md)
10. [`docs/security.md`](docs/security.md) — the seeded Admin, no public registration, the authorization model, and password recovery
11. [`docs/week3-full-stack-delivery.md`](docs/week3-full-stack-delivery.md) — the Week 3 delivery record
12. [`docs/week4-production-ai.md`](docs/week4-production-ai.md) — the Week 4 AI-assisted intake record

## Troubleshooting

- **Sign-in shows `Request failed with status 500`:** the browser reached the Vite
  dev server but not the API, so the `/api` proxy returned a bodiless `500`. The
  usual cause is that the backend is not running — `npm run build` compiles it but
  does **not** start it. Confirm its terminal prints
  `Eurisko Hub API listening on http://localhost:3000`. If it instead repeats
  `Unable to connect to the database. Retrying…`, the `DB_FILE` folder is missing
  or not writable: `mkdir -p .data` (or point `DB_FILE` at a writable path) and
  restart. A wrong password is `401`, never `500`.
- **A password reset link never arrives:** no mail provider is configured, so the
  message is printed to the **backend terminal** (and outside production the token
  is shown in the UI too). Look for `No mail provider configured` in the backend
  output, or set `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — an **App
  Password** for Gmail/Outlook with 2FA), or `MAIL_WEBHOOK_URL` / `RESEND_API_KEY`,
  for real delivery. A reset
  link is valid for 30 minutes (`PASSWORD_RESET_TTL_MINUTES`) and can be used once;
  the API always answers `200` with the same generic message even for an unknown
  email (that is deliberate — it prevents account discovery).
- **Port 3000 is busy:** start the API with `PORT=3001 npm start`. The Vite dev
  proxy targets 3000, so either free port 3000 or point the client at the new
  port with `VITE_API_BASE=http://localhost:3001`.
- **Start over with an empty database:** stop the backend, `rm backend/.data/*.sqlite`,
  and start it again — the Admin account is re-seeded automatically. Every other
  account is created by an Admin from the Users tab.
- **`npm install` fails on a restricted machine:** point npm at a writable cache:
  `npm install --cache ./.npm-cache`.
- **E2E says the backend is not reachable:** the global setup prints the exact
  start command; make sure the API is running and pass `API_URL` if it is not on
  port 3000.
- **Browser E2E skips:** it needs Chromium and its system libraries. Install them
  (`npx playwright install chromium`; on Debian/Ubuntu `npx playwright install-deps`)
  or set `CHROME_PATH=/path/to/chrome`. It skips rather than failing unless
  `STRICT_BROWSER_E2E=1`.

## Current status

A working NestJS API ([`docs/api.md`](docs/api.md)) implements the core MVP
workflow — open a ticket, claim it from a department queue, resolve it with a
note, review it from the admin dashboard — and the React client in `frontend/`
wires that workflow end-to-end for the **"assigned agent resolves a ticket"**
slice, with durable SQLite persistence across restarts and an automated
test suite covering the business rule, the database integration, the HTTP
boundaries, regression, and the UI E2E. On top of that: advisory AI intake
(v0.4) and self-service **password recovery/change with any real email address**
(v0.5).
