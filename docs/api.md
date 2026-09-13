# API Reference: Internal Operations Service Hub (NestJS)

**Related docs:** [Product Specification](product-spec.md) | [Architecture](architecture.md) | [Data Model](data-model.md) | [ADR-001](decisions/ADR-001.md) | [ADR-002](decisions/ADR-002.md) | [ADR-003](decisions/ADR-003.md) | [Security](security.md)

The backend lives in `backend/` (NestJS + TypeORM, modular monolith per
architecture.md §2). This reference maps every requirement in the product spec
to the HTTP API. Roles are enforced server-side (architecture.md §3 — the
client is never trusted to enforce permissions).

## Conventions

* Base URL: `http://localhost:3000` (no prefix — routes match ADR-001 exactly).
* Auth: `Authorization: Bearer <accessToken>` returned by login/register.
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

### POST /auth/register  — public
Self-registration; **always creates an `Employee`**. Agent/Admin accounts are
provisioned by an Admin through `POST /users` (RBAC, product-spec §3).

```json
{ "name": "Rana Khoury", "email": "rana.khoury@eurisko.com", "password": "password123" }
```
→ `201` `{ "accessToken": "...", "user": { id, name, email, role } }`

### POST /auth/login  — public
```json
{ "email": "rana.khoury@eurisko.com", "password": "password123" }
```
→ `200` `{ "accessToken": "...", "user": { ... } }`

### GET /auth/me
→ current user profile `{ id, email, role }`.

### GET /demo/accounts  — public, development only
Returns the seeded demo accounts so the login card, `scripts/verify-slice.mjs`
and the E2E harnesses share one source of truth (`backend/src/common/demo-accounts.ts`):
```json
{ "accounts": [ { "label": "Admin", "name": "Rami Fares", "email": "…",
                  "password": "Admin123!", "role": "Admin", "hint": "…" }, … ] }
```
Returns `{ "accounts": [] }` when demo seeding is disabled
(`NODE_ENV=production` or `SEED_DEMO_DATA=false`); the Admin password is `null`
if `ADMIN_PASSWORD` was overridden. See [security.md](security.md).

## User management (Admin only)

### GET /users · POST /users · PATCH /users/:id/role
`POST /users` creates accounts with an explicit role (used to provision agents):

```json
{ "name": "Karim Haddad", "email": "karim.haddad@eurisko.com", "password": "password123", "role": "IT_Agent" }
```
`PATCH /users/3/role` body: `{ "role": "HR_Agent" }`

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

## Admin dashboard

### GET /admin/stats — Admin only
Global metrics (computed on read per data-model §3):
```json
{ "total": 12, "byStatus": { "Open": 5, "In Progress": 3, "Resolved": 3, "Cancelled": 1 },
  "byCategory": { "IT": 6, "HR": 4, "Maintenance": 2 },
  "openUnclaimed": 4, "highPriorityOpen": 2 }
```

## Scenario walk-through (acceptance criteria)

1. **Opening a ticket** — Rana logs in, `POST /tickets` (IT, High). It appears in her `GET /tickets` as `Open`.
2. **Resolving with a note** — Karim (IT agent) sees it in his queue, `PATCH /tickets/1/claim`, then `PATCH /tickets/1/status` with `{ "status": "Resolved", "resolutionNote": "Replaced HDMI cable" }`. Rana now sees `Resolved` + the note.
3. **Admin global view** — Admin's `GET /tickets` returns tickets from all three departments; `GET /admin/stats` shows the aggregates.
4. **Admin assigning an urgent ticket** — an `Open`, unclaimed ticket is assigned with `PATCH /tickets/2/assign` `{ "assigneeId": 3 }`; it becomes `In Progress` with an owner and an `ASSIGNED` event (ADR-003).
5. **Admin retiring a duplicate** — `PATCH /tickets/2/cancel` `{ "reason": "Duplicate" }` moves it to the terminal `Cancelled` status; the ticket and its history remain readable (ADR-003).

## Getting started

```bash
cd backend
npm install
npm run build && npm start        # http://localhost:3000
npm run start:dev                 # watch mode (ts-node)
```

First boot seeds an Admin (`rami.fares@eurisko.com` / `Admin123!` — override via
`ADMIN_EMAIL` / `ADMIN_PASSWORD`) and, in development, the demo personas
(`GET /demo/accounts`) — see [security.md](security.md). By default the API uses
an in-memory SQLite database (TypeORM `sqljs` driver — zero setup); set
`DB_FILE=/path/db.sqlite` to persist it, or swap the TypeORM config for
PostgreSQL later.
