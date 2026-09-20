# API Reference: Internal Operations Service Hub (NestJS)

**Related docs:** [Product Specification](product-spec.md) | [Architecture](architecture.md) | [Data Model](data-model.md) | [ADR-001](decisions/ADR-001.md) | [ADR-002](decisions/ADR-002.md) | [ADR-003](decisions/ADR-003.md) | [Security](security.md)

The backend lives in `backend/` (NestJS + TypeORM, modular monolith per
architecture.md §2). This reference maps every requirement in the product spec
to the HTTP API. Roles are enforced server-side (architecture.md §3 — the
client is never trusted to enforce permissions).

## Conventions

* Base URL: `http://localhost:3000` (no prefix — routes match ADR-001 exactly).
* Auth: `Authorization: Bearer <accessToken>` returned by login.
* Request/response bodies are JSON.
* Errors follow NestJS conventions: `{ "message": ..., "error": ..., "statusCode": ... }`.

## Roles & mapping (repo README, data-model.md)

| Role | Department (category they may serve) | Can see |
|---|---|---|
| `Employee` (Requester) | — | own tickets only |
| `IT_Agent` | IT | IT queue + claimed tickets |
| `HR_Agent` | HR | HR queue + claimed tickets |
| `Maintenance_Agent` | Maintenance | Maintenance queue + claimed tickets |
| `Admin` | all | every ticket company-wide + stats + user management; may **assign** unclaimed tickets (ADR-003), **cancel** them softly (ADR-003), and change status only as a recorded **override** (ADR-002) |

## Authentication

There is **no public registration** (ADR-004). The backend seeds exactly one
account — the Admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, default
`admin@eurisko.com` / `Admin123!`) — and the Admin creates every other account
through `POST /users` (below).

**Any real email address is accepted** (ADR-005). Every email field is validated
with `@IsEmail()` and nothing else, so a personal provider
(`someone@gmail.com`, `someone@hotmail.com`, `someone@outlook.com`,
`someone@yahoo.com`…) and a company domain behave identically for login and
account creation. `@eurisko.com` is only the development default for the seeded
Admin; a malformed address is the only thing rejected (`400`).

### POST /auth/login  — public
```json
{ "email": "admin@eurisko.com", "password": "Admin123!" }
```
→ `200` `{ "accessToken": "...", "user": { ... } }`

A wrong email and a wrong password both return the same generic
`401 Invalid credentials.`, so the endpoint cannot be used to discover accounts.

### POST /auth/forgot-password  — public, **off by default** (ADR-008, ADR-009)

Recovery is **Admin-initiated** (ADR-007): an Admin mints a one-time link with
`POST /users/:id/reset-password` (below) and hands it over, so no mail server is
needed anywhere. This public, emailed path is **disabled unless**
`PASSWORD_RESET_SELF_SERVICE=true`; while it is off **any well-formed request**
answers `404 {"message":"Cannot POST /auth/forgot-password"}`, exactly as if the
route did not exist. (A malformed address or unknown body field still fails DTO
validation with `400` first, as on every other endpoint.)

With the switch on it is step 1 of self-service recovery. The answer is **always**
the same generic message — the address being registered or not, active or not —
so the endpoint cannot be used to enumerate accounts:

```json
{ "email": "someone@gmail.com" }
```
→ `200` `{ "message": "If that email is registered, a password reset link has been sent." }`

When the account exists and is active, a single-use, 30-minute token is minted
(stored only as a SHA-256 hash) and the reset link is emailed to the account's
address through `MailService` — the primary SMTP server (`SMTP_HOST`…), then the
**backup SMTP server** (`SMTP_ALT_HOST`…, e.g. Gmail then Outlook), then
`MAIL_WEBHOOK_URL`, then `RESEND_API_KEY`, and finally the backend console when
no provider is configured. Outside production the response additionally carries
the token so the flow is demonstrable with no mail server
(`PASSWORD_RESET_RETURN_TOKEN`, **always off** when `NODE_ENV=production`):

```json
{ "message": "If that email is registered, a password reset link has been sent.",
  "resetToken": "9f2c…", "resetUrl": "http://localhost:5173/?resetToken=9f2c…",
  "delivery": "smtp" | "smtp-alt" | "webhook" | "resend" | "console" }
```

* `400` — malformed email address or an unknown body field.
* At most one email per address per `PASSWORD_RESET_COOLDOWN_SECONDS` (default
  60): a repeat request inside the window gets the same generic answer but mints
  and sends nothing (anti mail-bomb).

### POST /auth/reset-password  — public
Complete a reset with the one-time token from an **Admin-issued** link (ADR-007,
`POST /users/:id/reset-password` below — or, for a locked-out lone Admin, the
offline `scripts/reset-password.mjs`) or from an **emailed** one when the optional
self-service path is enabled (ADR-008, `POST /auth/forgot-password`).

```json
{ "token": "64-char hex token from the reset link", "password": "new-password-8+" }
```
→ `200` `{ "message": "Your password has been changed. You can sign in with your new password." }`

* The token is **single-use**: on success it is consumed, so the same link cannot
  be replayed. Changing the password also invalidates any other outstanding token.
* `400` — unknown, already-used or expired token (`"This password reset link is
  invalid or has expired."`); token shorter than 20 characters; password shorter
  than 8 characters; unknown body field.

### POST /auth/change-password  — authenticated
Change **your own** password while signed in (`Authorization: Bearer …`).

```json
{ "currentPassword": "password123", "newPassword": "new-password-8+" }
```
→ `200` `{ "message": "Your password has been changed." }`

* The current password is required, so a session token alone cannot take the
  account over.
* `401` — no/invalid bearer token; `400` — wrong current password
  (`"Your current password is incorrect."`), a new password shorter than 8
  characters, or an unknown body field.

### GET /auth/me
→ current user profile `{ id, email, role }`.

> `POST /auth/register` does **not** exist: an outsider cannot create an account
> (ADR-004); any request to it returns `404 Not Found`.

## User management (Admin only) — the only way to create accounts

### GET /users · POST /users · PATCH /users/:id/role
`POST /users` creates an account with an explicit role and password:

```json
{ "name": "Karim Haddad", "email": "karim.haddad@eurisko.com", "password": "password123", "role": "IT_Agent" }
```
→ `201` with the created user (never its password hash). A duplicate email →
`409`; a non-Admin caller → `403`. `email` may be **any real address**
(`karim.haddad@gmail.com`, `karim@hotmail.com`, `k.haddad@acme-corp.com`…): no
domain restriction is applied anywhere in the system (ADR-005).
`PATCH /users/3/role` body: `{ "role": "HR_Agent" }` → `200` with the updated
user.
* `400` — an invalid role; changing **your own** Admin role
  (`"You cannot change your own Admin role."`); or demoting the **last active
  Admin** (`"The last active Admin cannot be demoted — the hub would be locked
  out."`). A demotion must never be able to empty the Admin seat, exactly like a
  deletion (ADR-004).
* `404` — unknown account; non-Admin caller → `403`.

### DELETE /users/:id — Admin deletes an account
Deletes **any** account — an Employee, an IT/HR/Maintenance agent, or another
Admin. `GET /users` only ever lists active accounts, so a removed account
disappears from the Users list immediately and can no longer sign in
(`POST /auth/login` → `401`).

```json
// 200 response
{ "id": 4, "email": "layla.nassar@eurisko.com", "mode": "deleted" }
```

* `mode: "deleted"` — the account had **no tickets and no history**, so the row
  is really deleted — and its **email becomes reusable**: an Admin can create a
  new account with that address afterwards (a *different* user id).
* `mode: "deactivated"` — the account appears in tickets/history, so the row is
  kept for audit and only deactivated (login revoked, hidden from the list).
  The email therefore stays in use: `POST /users` with it returns `409`.
  This is the same "never destroy the audit trail" rule as ADR-003's soft
  `Cancelled`.
* The Users tab's confirmation dialog states both outcomes before the Admin
  confirms, because only the response reveals which one applies.
* `400` — deleting **your own** account, or deleting the **last active Admin**
  (`"The last active Admin cannot be deleted — the hub would be locked out."`).
* `404` — unknown account; non-Admin caller → `403`.

### POST /users/:id/reset-password — Admin only (ADR-007)
Admin-initiated recovery for a colleague who forgot their password. It needs
**no mail server**: the Admin mints the same single-use, hashed, expiring token
the email flow uses and receives the link to hand over — the employee sets their
own new password with `POST /auth/reset-password`, so the Admin never sees or
chooses it (docs/security.md §"Admin-initiated reset").

```json
// 200 response
{ "id": 4, "email": "layla.nassar@eurisko.com",
  "resetToken": "9f2c…", "resetUrl": "http://localhost:5173/?resetToken=9f2c…",
  "expiresAt": "2026-09-20T21:45:00.000Z", "expiresInMinutes": 30 }
```

* Single-use and time-limited exactly like an emailed link
  (`PASSWORD_RESET_TTL_MINUTES`, default 30): issuing a new link invalidates the
  previous one, and using it clears it.
* `400` — the account is deactivated (it cannot sign in, so a link would be
  misleading).
* `404` — unknown account; non-Admin caller → `403`; no token → `401`.
* The action is logged (which Admin issued a link for which account), and the
  token hash/expiry never appear in any response.

## Tickets

### POST /tickets — any authenticated user (as Requester)
product-spec §3: Title, Category (IT|HR|Maintenance), Priority (Low|Medium|High), Description.

```json
{ "title": "My screen is broken", "description": "...",
  "category": "IT", "priority": "High" }
```
→ `201` ticket with `status: "Open"`, `assignedToId: null` (ADR-001). A
`CREATED` history event is recorded.

### GET /tickets — RBAC-scoped list (data-model §4 access patterns)
| Caller | Returns |
|---|---|
| Employee | `WHERE requester_id = me` |
| Agent | queue of their department: `WHERE category = my dept AND status = Open`, plus `?mine=true` for tickets they claimed |
| Admin | all tickets, any filters |

Optional query filters: `?status=Open&category=IT&priority=High&mine=true`
(agents may only query their own category — anything else → `403`).

### GET /tickets/:id
Requester (owner), an agent of the ticket's category, or Admin. Others → `403`.

### GET /tickets/:id/history
Durable event log (architecture §2: DB stores "ticket history"):
`CREATED → CLAIMED/ASSIGNED → STATUS_CHANGED/RESOLVED`, plus `ADMIN_OVERRIDE`
(ADR-002) and `CANCELLED` (ADR-003) where applicable — each with actor + note.

### PATCH /tickets/:id/claim — agent only (ADR-001)
Agent of the matching department claims an `Open`, unclaimed ticket from their
queue. Sets `assignedToId` and moves status → `In Progress` (`CLAIMED` event).
Already-claimed or non-Open tickets are rejected.
* `403` — the caller is not an agent of the ticket's category, **or is the agent
  who opened the ticket**: claiming your own request is refused (separation of
  duties), so the person who reported a problem cannot resolve it unassigned-to.
* `400` — the ticket is already claimed or not `Open`.

### PATCH /tickets/:id/status — assigned agent, or Admin override (ADR-002)
Body: `{ "status": "In Progress" | "Resolved", "resolutionNote": "...", "overrideReason": "..." }`

* Allowed transitions only: `Open → In Progress → Resolved` (data-model §2).
* Moving to `Resolved` **requires** a non-empty `resolutionNote`
  (data-model §2 rule) — an empty/missing note → `400 Bad Request`.
* A `status` outside the allowed set → `400 Bad Request` (DTO validation).
* Anyone else (including the requester, or another agent) → `403`.
* **Admin override (ADR-002):** when the acting user is an Admin and the ticket
  is **not assigned to them**, the request must also include a non-empty
  `overrideReason`; otherwise → `400 Bad Request`. The change is recorded as an
  `ADMIN_OVERRIDE` history event and the ticket stays unassigned — an unclaimed
  ticket is never silently closed. The regular agent path is unchanged and does
  not send `overrideReason`.

### PATCH /tickets/:id/assign — Admin only (ADR-003)
Gives an `Open`, unclaimed ticket a named owner by assigning it to an agent of
the matching department. The ticket moves `Open → In Progress` and an `ASSIGNED`
event records the Admin and the assignee.

```json
{ "assigneeId": 3, "note": "Urgent — please take this." }
```

* Non-agent assignee, or an agent from another department → `400 Bad Request`.
* Already-claimed or non-`Open` ticket → `403 Forbidden`.
* Non-Admin caller → `403 Forbidden`.

### PATCH /tickets/:id/cancel — Admin only (ADR-003)
Retires a request that should not be worked (duplicate, obsolete, withdrawn).
**Soft cancel:** the ticket keeps its row and full history with status
`Cancelled`; tickets are never hard-deleted.

```json
{ "reason": "Duplicate of an existing request." }
```

* A non-empty `reason` is **required** → otherwise `400 Bad Request`.
* Cancelling a `Resolved` or already `Cancelled` ticket → `403 Forbidden`.
* Non-Admin caller → `403 Forbidden`.

## AI-assisted intake (v0.4)

Full design rationale: [week4-production-ai.md](week4-production-ai.md).

### POST /tickets/ai-suggest — any authenticated user, advisory only
Classifies a free-form problem description into the structured ticket fields.
It is a **read-only advisory call**: it never creates a ticket, never writes to
the database, and its answer is never stored. The employee accepts, edits or
ignores it, and `POST /tickets` (unchanged) remains the only way to open a
ticket.

```json
{ "text": "My laptop screen is flickering and I can't work" }
```

→ `200` with a suggestion whose values are always inside the domain enums:

```json
{ "suggestion": { "category": "IT", "priority": "High",
                  "title": "Laptop screen flickering", "confidence": 0.92,
                  "relevant": true },
  "source": "ai" }
```

→ `200` when **no model answers** (disabled, unreachable, too slow, or an
unparseable reply). By default the built-in offline classifier answers, and the
response says so — `source: "offline"` plus a `notice`:

```json
{ "suggestion": { "category": "IT", "priority": "Medium",
                  "title": "Laptop will not charge", "confidence": 0.4,
                  "relevant": true },
  "source": "offline",
  "notice": "AI provider unavailable — this suggestion comes from the offline keyword classifier…" }
```

→ `200` when the text is **not a support request at all** (v0.6) — random
characters, a greeting, a test message, something unrelated to work. The answer
still carries a usable body, but says it could not read a request and why, so the
UI pre-fills nothing:

```json
{ "suggestion": { "category": "IT", "priority": "Low",
                  "title": "Not a support request", "confidence": 0.1,
                  "relevant": false,
                  "reason": "the text is random characters, not a request" },
  "source": "ai",
  "notice": "This does not look like a support request (the text is random characters, not a request) — add a few details about the problem, or fill in the fields by hand." }
```

`relevant` is a signal, not an error: the status stays `200` because the AI call
succeeded — it is the *input* that could not be read as a request. A missing or
wrong-typed `relevant` means `true`, so an older or sloppier provider can never
make the form tell an employee their real request is nonsense.

→ `200` with the strict provider-only shape when `AI_OFFLINE_FALLBACK=false`:

```json
{ "suggestion": null, "error": "AI provider unavailable" }
```

The offline path never pretends to be the model: it is flagged in the payload
(`source`, `notice`) and in the UI (the fields are tagged "Suggested (offline)")
and its confidence is capped at 0.6. Nothing here is ever a `500`, so ticket
creation is never blocked.

The offline classifier can also return `relevant: false`, but only to report the
weaker thing it can verify — *no service-desk keyword matched* — which it says in
`reason` ("no service-desk keywords were found in the text") and in a
correspondingly softer `notice` ("There is not enough here for the offline
classifier to go on…"). A keyword miss is not a judgement that the employee wrote
nonsense: the same classifier reports it for a perfectly good `"help"`. The
model's own "this is not a support request" verdict is the stronger claim, and
only the model path words it that way.

* `400` — `text` missing or shorter than 3 characters (DTO validation).
* `401` — no or invalid bearer token (any signed-in user may call it).
* Configuration: `AI_ENABLED`, `AI_PROVIDER_URL` (default
  `https://api.groq.com/openai/v1`), `AI_MODEL` (default
  `openai/gpt-oss-20b`, free model names change over time), `AI_TIMEOUT_MS` (default `15000`),
  `AI_FALLBACK_MODEL` (unset — comma-separated models tried when the primary
  fails), `AI_RETRY_DELAY_MS` (default `1500` — wait before the one retry),
  `AI_OFFLINE_FALLBACK` (default `true`), and `AI_API_KEY` — **required for
  Groq** (free key from console.groq.com); a keyless local provider such as
  Ollama needs none.

### GET-free check script
`node scripts/verify-ai-intake.mjs` drives six descriptions (five realistic ones
plus deliberately meaningless text) through this endpoint against a running API
and reports the category, priority, title, confidence, source and relevance of
each — with or without a model installed.

## Admin dashboard

### GET /admin/stats — Admin only
Global metrics (computed on read per data-model §3):
```json
{ "total": 12, "byStatus": { "Open": 5, "In Progress": 3, "Resolved": 3, "Cancelled": 1 },
  "byCategory": { "IT": 6, "HR": 4, "Maintenance": 2 },
  "openUnclaimed": 4, "highPriorityOpen": 2 }
```

## Scenario walk-through (acceptance criteria)

0. **Provisioning** — the Admin signs in and creates the people who will use the app (`POST /users`): an Employee, IT/HR/Maintenance agents, etc. There is no self-registration (ADR-004).
1. **Opening a ticket** — the Employee signs in, `POST /tickets` (IT, High). It appears in their `GET /tickets` as `Open`.
2. **Resolving with a note** — Karim (IT agent) sees it in his queue, `PATCH /tickets/1/claim`, then `PATCH /tickets/1/status` with `{ "status": "Resolved", "resolutionNote": "Replaced HDMI cable" }`. The Employee now sees `Resolved` + the note.
3. **Admin global view** — Admin's `GET /tickets` returns tickets from all three departments; `GET /admin/stats` shows the aggregates.
4. **Admin assigning an urgent ticket** — an `Open`, unclaimed ticket is assigned with `PATCH /tickets/2/assign` `{ "assigneeId": 3 }`; it becomes `In Progress` with an owner and an `ASSIGNED` event (ADR-003).
5. **Admin retiring a duplicate** — `PATCH /tickets/2/cancel` `{ "reason": "Duplicate" }` moves it to the terminal `Cancelled` status; the ticket and its history remain readable (ADR-003).

## Getting started

```bash
cd backend
npm install
mkdir -p .data                                             # DB_FILE's folder (absent in a fresh clone)
npm run build && DB_FILE="$PWD/.data/hub.sqlite" npm start  # http://localhost:3000
npm run start:dev                 # watch mode (ts-node)
```

Wait for `Eurisko Hub API listening on http://localhost:3000`; the web client
(`cd ../frontend && npm run dev`) runs in a second terminal.

First boot seeds exactly **one** account — the Admin
(`admin@eurisko.com` / `Admin123!`, override via `ADMIN_EMAIL` / `ADMIN_PASSWORD`).
Sign in with it and create everyone else from the **Users** tab (ADR-004); there
is no public registration and no demo data. Any real email domain is accepted
(Gmail, Hotmail/Outlook, Yahoo, company domains — ADR-005); `@eurisko.com` is
only the development default. By default the API uses an in-memory SQLite
database (TypeORM `sqljs` driver — zero setup); set `DB_FILE=/path/db.sqlite` to
persist it, or swap the TypeORM config for PostgreSQL later. Password recovery
needs **no mail server at all** (ADR-007): an Admin mints a one-time link in the
app, and `scripts/reset-password.mjs` is the offline break-glass.
