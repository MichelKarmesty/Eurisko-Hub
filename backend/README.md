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
- **Password recovery & change** (v0.5, ADR-005/007/008/009): **Admin-initiated**
  recovery — the Admin mints a one-time link (`POST /users/:id/reset-password`)
  and hands it over, so nothing external is needed — plus an authenticated change
  that requires the current password. The public, emailed self-service route is
  **off by default** (`PASSWORD_RESET_SELF_SERVICE=true` turns it back on; the
  link then goes through `src/mail/`: built-in SMTP, backup SMTP, webhook, Resend
  or the console)
- **Any real email address is accepted** (Gmail, Hotmail/Outlook, Yahoo, a
  company domain); `@eurisko.com` is only the development default for the Admin
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
npm test                 # also runs auth-password.spec.ts (v0.5 recovery/change)
npm run test:watch       # watch mode
```

## Environment
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | dev value | JWT signing secret (set in prod!) |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `DB_FILE` | *(in-memory)* | SQLite file path for persistence |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@eurisko.com` / `Admin123!` | The one seeded Admin account (any valid email domain works) |
| `APP_BASE_URL` | `http://localhost:5173` | Front of the password-reset link (`…/?resetToken=…`) |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | How long a reset link stays valid |
| `PASSWORD_RESET_SELF_SERVICE` | `false` | Serve the public, emailed `POST /auth/forgot-password`; while off it answers `404` (ADR-009) |
| `PASSWORD_RESET_RETURN_TOKEN` | `true` outside production | Return the one-time token in the response (development; **always off** when `NODE_ENV=production`) |
| `PASSWORD_RESET_COOLDOWN_SECONDS` | `60` | At most one forgot-password email per address in this window (anti mail-bomb) |
| `SMTP_HOST` / `SMTP_PORT` | *(unset)* / `587` | Standard SMTP (Gmail, Outlook/Hotmail, company); `SMTP_SECURE=true` for port 465 |
| `SMTP_ALT_HOST` / `SMTP_ALT_PORT` | *(unset)* / `587` | Optional **second** sender, tried when the first fails (ADR-008); same `SMTP_ALT_*` variables plus `SMTP_ALT_FROM` |
| `SMTP_USER` / `SMTP_PASS` | *(unset)* | SMTP login — use an **App Password** when 2FA is on |
| `MAIL_WEBHOOK_URL` / `MAIL_WEBHOOK_TOKEN` | *(unset)* | Optional: POST `{ to, subject, text }` to an HTTPS mail relay |
| `RESEND_API_KEY` | *(unset)* | Optional: real delivery through Resend's HTTP API |
| `MAIL_FROM` | `Eurisko Hub <no-reply@eurisko.local>` | From address on outgoing mail |
| `AI_ENABLED` | `true` | `false` switches the AI intake feature off |
| `AI_PROVIDER_URL` | `https://api.groq.com/openai/v1` | OpenAI-compatible base URL (Groq's free cloud API by default; a local Ollama is `http://localhost:11434/v1`) |
| `AI_MODEL` | `openai/gpt-oss-20b` | Model name sent to the provider (Groq's free model names change; list them at `/openai/v1/models`) |
| `AI_TIMEOUT_MS` | `15000` | Hard cap on the provider call (a transient blip is retried once) |
| `AI_FALLBACK_MODEL` | *(unset)* | Comma-separated models tried when the primary fails (429/5xx/retired) instead of dropping to the offline rules |
| `AI_RETRY_DELAY_MS` | `1500` | Wait before the one retry of a rate-limited / transient call |
| `AI_OFFLINE_FALLBACK` | `true` | Answer from the built-in keyword classifier (always labelled `source: "offline"`) when no model is available; `false` = strict `{ suggestion: null, error }` |
| `AI_API_KEY` | *(unset)* | **Required for Groq** — free key from console.groq.com (a keyless local provider needs none) |

## Layout
```
src/
  main.ts               bootstrap (listens on PORT)
  app.setup.ts          shared HTTP pipeline (validation + serialization) used by
                        main.ts AND the API tests, so tests hit the real boundary
  app.module.ts         module wiring + TypeORM + admin-only seed
  common/               domain enums + JWT/RBAC guards + decorators
  auth/                 login + forgot/reset/change password (no public
                        registration, ADR-004/ADR-005)
  mail/                 console-first email delivery (optional SMTP / webhook /
                        Resend, no npm dependency) used by the password reset
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
  admin-role-change.spec.ts             role changes + the last-active-Admin guard
  admin-user-deletion.spec.ts           DELETE /users/:id: contract, audit rule,
                                        foreign-key enforcement
  auth-password.spec.ts                 v0.5 forgot/reset/change + any-email rule
  admin-reset-password.spec.ts          ADR-007/ADR-009: Admin-issued reset link
  mail-smtp.spec.ts                     SMTP transport selection + console fallback
  ai-intake-eval.spec.ts                AI intake evals: five run for real when a
                                        provider answers (they skip otherwise),
                                        the rest are mocked and always run
```

## Security
The backend seeds exactly one account (the Admin) and exposes no public
registration. Seeding is self-healing: if a database has no Admin at all, the
next boot creates one (an existing Admin is never duplicated or reset). See
[`../docs/security.md`](../docs/security.md) — set a strong `ADMIN_PASSWORD` and
`JWT_SECRET` before any real deployment.

Passwords are bcrypt-hashed and can never be retrieved; recovery issues a
one-time link whose **hash** (never the token) and 30-minute expiry are stored,
and `POST /auth/change-password` re-checks the current password. Forgot-password
answers identically for unknown emails, so accounts cannot be enumerated, and a
per-address cooldown stops it being used to mail-bomb someone. With no mail
provider configured the reset message is printed to this process's console —
set `SMTP_HOST` (Gmail/Outlook/company), `MAIL_WEBHOOK_URL` or
`RESEND_API_KEY` before deployment so it reaches the user instead. An Admin can
also mint a one-time link for a colleague (`POST /users/:id/reset-password`) with
no mail at all, and a locked-out lone Admin uses `scripts/reset-password.mjs`
offline. See [ADR-005](../docs/decisions/ADR-005.md),
[ADR-007](../docs/decisions/ADR-007.md) and
[ADR-008](../docs/decisions/ADR-008.md).

## Quick start
```bash
mkdir -p .data                                     # DB_FILE's folder (absent in a fresh clone)
npm run build && DB_FILE="$PWD/.data/hub.sqlite" npm start
# wait for: Eurisko Hub API listening on http://localhost:3000
# the web client runs in another terminal: cd ../frontend && npm run dev
# sign in as admin@eurisko.com / Admin123!, then create users from the Users tab
# accounts accept any real email address (gmail.com, hotmail.com, a company domain…);
# `admin@eurisko.com` is only the development default — override it with ADMIN_EMAIL
# (or follow "Scenario walk-through" in ../docs/api.md)
```

Without `DB_FILE` the API still runs, but on an **in-memory** database: every
account and ticket is lost when the process stops.
