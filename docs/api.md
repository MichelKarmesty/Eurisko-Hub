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

### POST /auth/login  — public
```json
{ "email": "admin@eurisko.com", "password": "Admin123!" }
```
→ `200` `{ "accessToken": "...", "user": { ... } }`

A wrong email and a wrong password both return the same generic
`401 Invalid credentials.`, so the endpoint cannot be used to discover accounts.

### GET /auth/me
→ current user profile `{ id, email, role }`.

> `POST /auth/register` does **not** exist: an outsider cannot create an
> account, and any request to it returns `404 Not Found`.

## User management (Admin only) — the only way to create accounts

### GET /users · POST /users · PATCH /users/:id/role
`POST /users` creates an account with an explicit role and password:

```json
{ "name": "Karim Haddad", "email": "karim.haddad@eurisko.com", "password": "password123", "role": "IT_Agent" }
```
→ `201` with the created user (never its password hash). A duplicate email →
`409`; a non-Admin caller → `403`.
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
  is really deleted.
* `mode: "deactivated"` — the account appears in tickets/history, so the row is
  kept for audit and only deactivated (login revoked, hidden from the list).
  This is the same "never destroy the audit trail" rule as ADR-003's soft
  `Cancelled`.
* `400` — deleting **your own** account, or deleting the **last active Admin**
  (`"The last active Admin cannot be deleted — the hub would be locked out."`).
* `404` — unknown account; non-Admin caller → `403`.

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
                  "title": "Laptop screen flickering", "confidence": 0.92 } }
```

→ `200` when the AI is unavailable, too slow, disabled or answers unusably —
a graceful fallback, never a `500`, so ticket creation is never blocked:

```json
{ "suggestion": null, "error": "AI provider unavailable" }
```

* `400` — `text` missing or shorter than 3 characters (DTO validation).
* `401` — no or invalid bearer token (any signed-in user may call it).
* Configuration: `AI_ENABLED`, `AI_PROVIDER_URL` (default
  `http://localhost:11434/v1`), `AI_MODEL` (default `llama3.2`),
  `AI_TIMEOUT_MS` (default `5000`), optional `AI_API_KEY`.

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
is no public registration and no demo data. By default the API uses an in-memory
SQLite database (TypeORM `sqljs` driver — zero setup); set
`DB_FILE=/path/db.sqlite` to persist it, or swap the TypeORM config for
PostgreSQL later.
