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
> and an automated test suite. Full delivery record:
> [`docs/week3-full-stack-delivery.md`](docs/week3-full-stack-delivery.md).

## Repository layout

| Folder | What it is |
|---|---|
| [`backend/`](backend/) | NestJS + TypeORM API (auth, RBAC, tickets with claim/status flow, durable history) |
| [`frontend/`](frontend/) | React + Vite web client (requester dashboard, agent queue, admin view) |
| [`docs/`](docs/) | Product spec, architecture, data model, ADR, API reference, Week 3 delivery record |
| [`scripts/`](scripts/) | [`verify-slice.mjs`](scripts/verify-slice.mjs) live HTTP checks · [`run-tests.mjs`](scripts/run-tests.mjs) one-command test suite |
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

**1. Backend API** — http://localhost:3000

```bash
cd backend
npm run build
DB_FILE="$PWD/.data/hub.sqlite" npm start
```

First boot seeds an Admin account: `admin@eurisko.local` / `Admin123!`
(override with `ADMIN_EMAIL` / `ADMIN_PASSWORD`). Set `DB_FILE` so tickets
survive restarts; without it the database is in-memory.

**2. Web client** — http://localhost:5173

```bash
cd frontend
npm run dev
```

The Vite dev server proxies `/api` to the backend on port 3000.

**3. Provision demo data (once per fresh database).** With the backend
running, from the repository root:

```bash
node scripts/verify-slice.mjs full
```

This creates the demo personas (and runs the live definition-of-done checks).

| Account | Email | Password | Role |
|---|---|---|---|
| Admin | `admin@eurisko.local` | `Admin123!` | Admin (seeded on first boot) |
| Alice | `alice@corp.com` | `password123` | Employee (Requester) |
| Bob | `bob@corp.com` | `password123` | IT Agent |
| Dave | `dave@corp.com` | `password123` | IT Agent |
| Carol | `carol@corp.com` | `password123` | HR Agent |
| Eve | `eve@corp.com` | `password123` | Maintenance Agent |

You can also register a new Employee from the login screen; agent and admin
accounts are provisioned by an Admin through the Users tab.

## Exercise the slice (5 minutes)

1. Open http://localhost:5173 and log in as **Alice** (click the Requester chip).
2. Under **New request**, enter a title, choose **IT** / **High**, add a
   description, and click **Open ticket**. Alice's **My tickets** shows it as
   `Open`.
3. Click **Switch account** → log in as **Bob** (IT Agent). The ticket is in the
   **Department queue**.
4. Click **Claim** — it moves to **My work · In Progress**.
5. Click **Mark Resolved** *without* typing a note. The backend refuses the
   request and the form shows the validation message inline (the deliberate
   invalid request; nothing is saved).
6. Type a resolution note (e.g. *"Replaced the display cable."*) and click
   **Mark Resolved** — the ticket moves to **Resolved by me**.
7. Switch back to **Alice**. **My tickets** now shows `Resolved` with the note.
   Expand **▾ History** on any row to see `CREATED → CLAIMED → RESOLVED`, who
   did it, and when.

Requests the API refuses (e.g. an employee trying to change a status) surface as
a visible notice instead of failing silently.

## Run the automated tests

### Everything, with one command

```bash
node scripts/run-tests.mjs
```

It builds the backend, runs all backend suites, starts an isolated backend on a
free port with a throwaway SQLite file, runs the live HTTP checks and the UI
E2E, then tears everything down. It exits non-zero if any layer fails.

### Layer by layer

**Backend tests** (self-contained — no server, no database file needed):

```bash
cd backend
npm test                  # all three suites
npm run test:unit         # business rule: the ticket lifecycle
npm run test:integration  # backend <-> real SQL database
npm run test:api          # HTTP contract, authorization (allowed/denied), regression
```

| Requirement | Command | File |
|---|---|---|
| Automated test for a business rule | `npm run test:unit` | `backend/test/domain-rules.spec.ts` |
| Integration test backend ↔ database | `npm run test:integration` | `backend/test/tickets.database.integration.spec.ts` |
| HTTP contract + authorization + regression | `npm run test:api` | `backend/test/tickets.api.spec.ts` |

**E2E UI test** (drives the real React app against a live backend):

```bash
# terminal A — start the API
cd backend && npm run build
DB_FILE="$PWD/.data/e2e.sqlite" npm start

# terminal B — run the E2E (it waits for the API and provisions demo users)
cd e2e
npm run test:ui
```

Point the E2E at a different host/port with `API_URL=http://127.0.0.1:3100 npm run test:ui`.
A real-browser variant is available too (optional; needs a Chromium binary):

```bash
cd e2e
npx playwright install chromium     # or set CHROME_PATH=/path/to/chrome
npm run e2e:browser                 # needs the frontend dev server on :5173
```

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
| `POST /auth/register` · `POST /auth/login` | public | get a session token |
| `POST /tickets` | any authenticated user | open a request (title, description, category, priority) |
| `GET /tickets` | role-scoped | requester: own tickets · agent: own department's `Open` queue (`?mine=true` for claimed) · admin: all |
| `PATCH /tickets/:id/claim` | matching agent | claim an `Open` ticket → `In Progress` |
| `PATCH /tickets/:id/status` | **assigned agent or Admin** | advance `Open → In Progress → Resolved`; a note is required to resolve |
| `GET /tickets/:id/history` | ticket readers | durable `CREATED → CLAIMED → RESOLVED` audit trail |
| `GET /admin/stats` | Admin | company-wide counters |

## Roles and access

- **Employee (Requester):** opens tickets and follows their own.
- **IT / HR / Maintenance Agent:** works a department queue; may only read and
  claim tickets in their own department; cannot resolve a ticket assigned to a
  colleague.
- **Admin:** sees every ticket, may drive any ticket's lifecycle, and manages
  users.

Role checks happen on the server only — the client never enforces permissions.

## Documentation

Read in this order:

1. [`docs/product-spec.md`](docs/product-spec.md)
2. [`docs/architecture.md`](docs/architecture.md)
3. [`docs/data-model.md`](docs/data-model.md)
4. [`docs/decisions/ADR-001.md`](docs/decisions/ADR-001.md)
5. [`docs/api.md`](docs/api.md)
6. [`docs/week3-full-stack-delivery.md`](docs/week3-full-stack-delivery.md) — the Week 3 delivery record

## Troubleshooting

- **Port 3000 is busy:** start the API with `PORT=3001 npm start`. The Vite dev
  proxy targets 3000, so either free port 3000 or point the client at the new
  port with `VITE_API_BASE=http://localhost:3001`.
- **Start over with an empty database:** stop the backend, `rm backend/.data/*.sqlite`,
  and start it again — the Admin account is re-seeded automatically.
- **`npm install` fails on a restricted machine:** point npm at a writable cache:
  `npm install --cache ./.npm-cache`.
- **E2E says the backend is not reachable:** the global setup prints the exact
  start command; make sure the API is running and pass `API_URL` if it is not on
  port 3000.

## Current status

A working NestJS API ([`docs/api.md`](docs/api.md)) implements the core MVP
workflow — open a ticket, claim it from a department queue, resolve it with a
note, review it from the admin dashboard — and the React client in `frontend/`
wires that workflow end-to-end for the **"assigned agent resolves a ticket"**
slice, with durable SQLite persistence across restarts and an automated
test suite covering the business rule, the database integration, the HTTP
boundaries, regression, and the UI E2E.
