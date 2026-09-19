# Eurisko Hub — Backend API

NestJS + TypeORM implementation of the Internal Operations Service Hub
(see the [API reference](../docs/api.md) and the design docs in `../docs/`).

## Stack
- **NestJS 12** (modular monolith — architecture.md §2: Auth Module + Ticket Module)
- **TypeORM** over SQLite (data-model.md: one relational DB; sqljs driver = zero setup)
- **JWT** auth + **RBAC** roles: Employee, IT_Agent, HR_Agent, Maintenance_Agent, Admin
- **class-validator** DTO validation; passwords hashed with bcryptjs; ticket
  history recorded durably in a `ticket_events` table
- **No public registration** (ADR-004): the backend seeds only the Admin; the
  Admin creates every other account via the Admin-only Users API
- **AI-assisted intake** (v0.4, docs/week4-production-ai.md): an advisory
  `POST /tickets/ai-suggest` that suggests category/priority/title. It has no
  database access, validates every AI value against the domain enums, and fails
  gracefully when no provider is running

## Commands
```bash
npm install
npm run build        # tsc -> dist/
npm start            # run compiled build
npm run start:dev    # ts-node watch
npm run typecheck    # tsc --noEmit (src)
npm run typecheck:test # tsc -p tsconfig.spec.json (src + tests)
```

## Tests
Vitest + SWC (NestJS 12 is ESM-only and DI needs `emitDecoratorMetadata`, which
SWC emits — see `vitest.config.mts`). All suites are self-contained and use an
in-memory SQLite database; no server or database file is required.
```bash
npm test                 # all suites
npm run test:unit        # business rule: the ticket lifecycle
npm run test:integration # backend <-> real SQL database
npm run test:api         # HTTP contract + authorization + regression
npm run test:ai-eval     # v0.4 AI intake evals (real-or-skip + mocked cases)
npm run test:watch       # watch mode
```

## Environment
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | dev value | JWT signing secret (set in prod!) |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `DB_FILE` | *(in-memory)* | SQLite file path for persistence |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@eurisko.com` / `Admin123!` | The one seeded Admin account |
| `AI_ENABLED` | `true` | `false` switches the AI intake feature off |
| `AI_PROVIDER_URL` | `http://localhost:11434/v1` | OpenAI-compatible base URL (local Ollama by default) |
| `AI_MODEL` | `llama3.2` | Model name sent to the provider |
| `AI_TIMEOUT_MS` | `5000` | Hard cap on the provider call |
| `AI_OFFLINE_FALLBACK` | `true` | Answer from the built-in keyword classifier (always labelled `source: "offline"`) when no model is available; `false` = strict `{ suggestion: null, error }` |
| `AI_API_KEY` | *(unset)* | Optional bearer token for hosted providers |

## Layout
```
src/
  main.ts               bootstrap (listens on PORT)
  app.setup.ts          shared HTTP pipeline (validation + serialization) used by
                        main.ts AND the API tests, so tests hit the real boundary
  app.module.ts         module wiring + TypeORM + admin-only seed
  common/               domain enums + JWT/RBAC guards + decorators
  auth/                 login/me (no public registration, ADR-004)
  users/                Admin-only account provisioning (the only way to create users)
  tickets/              tickets + history (entities/service/controller);
                        claim, admin assign, admin cancel, status/override
  ai/                   v0.4 advisory AI intake: POST /tickets/ai-suggest,
                        prompt + defensive parsing + domain validation
test/
  setup.ts              deterministic env for tests (in-memory DB, seed admin)
  domain-rules.spec.ts                  business-rule unit test
  tickets.database.integration.spec.ts  backend <-> database integration test
  tickets.api.spec.ts                   HTTP contract/authorization/regression test
  admin-seed.spec.ts                    Admin-seed recovery (a DB is never locked out)
```

## Security
The backend seeds exactly one account (the Admin) and exposes no public
registration. Seeding is self-healing: if a database has no Admin at all, the
next boot creates one (an existing Admin is never duplicated or reset). See
[`../docs/security.md`](../docs/security.md) — set a strong `ADMIN_PASSWORD` and
`JWT_SECRET` before any real deployment.

## Quick start
```bash
mkdir -p .data                                     # DB_FILE's folder (absent in a fresh clone)
npm run build && DB_FILE="$PWD/.data/hub.sqlite" npm start
# wait for: Eurisko Hub API listening on http://localhost:3000
# the web client runs in another terminal: cd ../frontend && npm run dev
# sign in as admin@eurisko.com / Admin123!, then create users from the Users tab
# (or follow "Scenario walk-through" in ../docs/api.md)
```

Without `DB_FILE` the API still runs, but on an **in-memory** database: every
account and ticket is lost when the process stops.
