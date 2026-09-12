# Week 3 — v0.3 Integrated Product Slice

**Project:** Internal Operations Service Hub (Eurisko Hub)
**Slice:** an assigned Support Agent resolves a Service Request end to end
**Stack:** React (Vite) → NestJS → SQLite (TypeORM), one repository

This document is the delivery record for the Week 3 assignment. It states
exactly what the narrow user-facing flow is, the explicit API request/response
contract behind it, the authorization rule and its allowed/denied cases, the
invalid request and the expected failure we handle on purpose, and the
automated tests that protect the behaviour. Every claim here maps to a file in
this repository and to a command you can run.

---

## 1. The slice

> **A requester opens a Service Request, the responsible department agent claims
> it, the agent resolves it with a resolution note, and the requester sees the
> ticket as Resolved with the note.**

This is one narrow flow across all three tiers — React action, NestJS rule
enforcement, durable database state — not a collection of unrelated screens.
It is the same repository and the same product design from Weeks 1–2
(`docs/product-spec.md`, `docs/architecture.md`, `docs/data-model.md`,
`docs/decisions/ADR-001.md`); Week 3 hardens it and proves it.

```
Requester (Employee)          IT Agent                     Database (SQLite)
        |                          |                              |
        |-- POST /tickets -------->|                              |
        |   { title, description,  |-- INSERT ticket (Open) ----->|
        |     category, priority } |-- INSERT event CREATED ----->|
        |<-- 201 Open, #id --------|                              |
        |                          |                              |
        |                          |-- PATCH /tickets/:id/claim ->|
        |                          |   (Open -> In Progress)      |
        |                          |-- INSERT event CLAIMED ----->|
        |                          |<-- 200 In Progress ----------|
        |                          |                              |
        |                          |-- PATCH /tickets/:id/status->|
        |                          |   { status: "Resolved",      |
        |                          |     resolutionNote }         |
        |                          |-- UPDATE ticket (Resolved) -->|
        |                          |-- INSERT event RESOLVED ---->|
        |                          |<-- 200 Resolved + note ------|
        |                          |                              |
        |-- GET /tickets --------->|                              |
        |<-- [ ... Resolved, note ]|                              |
```

| Layer | Where |
|---|---|
| React UI | [`frontend/src/components/RequesterView.tsx`](../frontend/src/components/RequesterView.tsx), [`AgentView.tsx`](../frontend/src/components/AgentView.tsx), [`ResolveControl.tsx`](../frontend/src/components/ResolveControl.tsx) |
| API client (contract) | [`frontend/src/api.ts`](../frontend/src/api.ts) |
| NestJS backend | [`backend/src/tickets/`](../backend/src/tickets/), [`backend/src/common/domain.ts`](../backend/src/common/domain.ts) |
| Database | SQLite via TypeORM `sqljs`; entities `User`, `Ticket`, `TicketEvent` |

---

## 2. Explicit API request / response contract

Base URL `http://localhost:3000`. All bodies are JSON. Authenticated calls send
`Authorization: Bearer <accessToken>`. Errors use the NestJS shape
`{ statusCode, message, error }`. The full reference is
[`docs/api.md`](api.md); the slice contract is:

### `POST /tickets` — open a request (any authenticated user)

```jsonc
// request
{ "title": "External monitor flickers", "description": "…", "category": "IT", "priority": "High" }
// 201 response
{ "id": 7, "title": "…", "status": "Open", "category": "IT", "priority": "High",
  "requesterId": 2, "assignedToId": null, "resolutionNote": null, "requester": {…} }
```

* `400` — missing/short fields, an unknown `category`, an unknown `priority`,
  or any field outside the contract (unknown fields are rejected, not ignored).

### `PATCH /tickets/:id/claim` — claim from the department queue (agent only)

```jsonc
// no body
// 200 response
{ "id": 7, "status": "In Progress", "assignedToId": 3, … }
```

* `403` — non-agent, wrong department, already claimed, or claim of one's own request.
* `404` — unknown ticket.

### `PATCH /tickets/:id/status` — advance the lifecycle (assigned agent or Admin)

```jsonc
// request  (the slice's action)
{ "status": "Resolved", "resolutionNote": "Resolved the flicker; replaced the cable." }
// 200 response
{ "id": 7, "status": "Resolved", "resolutionNote": "…", "assignedToId": 3, … }
```

* `400` — `status` not in `{"In Progress", "Resolved"}`, or `Resolved` with a
  missing/blank `resolutionNote`.
* `403` — the requester, a different agent, or an agent from another department
  attempts to change the status; also any attempt to skip or reverse a step.
* `404` — unknown ticket.

### `GET /tickets` — role-scoped list

* Employee → own tickets; Agent → their department's `Open` queue
  (`?mine=true` → tickets they claimed); Admin → all tickets, optional
  `?status=&category=&priority=` filters.
* `403` — an agent asking for another department's queue.

### `GET /tickets/:id/history` — durable audit trail

`200` with `CREATED → CLAIMED → STATUS_CHANGED/RESOLVED`, each row carrying the
actor and note. Access follows the same read rule as the ticket.

---

## 3. Meaningful authorization rule

**Rule:** *only the agent the ticket is assigned to — or an Admin — may change a
ticket's status; an agent may only read and claim tickets from their own
department.* Enforced server-side in
[`tickets.service.ts`](../backend/src/tickets/tickets.service.ts)
(`getById`, `claim`, `changeStatus`), never in the client.

| Case | Actor | Request | Result |
|---|---|---|---|
| **ALLOWED** | Bob, the assigned `IT_Agent` | `PATCH /tickets/7/status` `{status:"Resolved", resolutionNote:"…"}` | `200`, ticket becomes `Resolved` |
| **DENIED** | Alice, the `Employee` who opened ticket 7 | same request | `403 Forbidden`, ticket stays `In Progress` |
| **DENIED** | Dave, a *different* `IT_Agent` | same request | `403 Forbidden` |
| **DENIED** | Carol, an `HR_Agent` | `GET /tickets/7` (an IT ticket) | `403 Forbidden` |

The allowed and denied cases are asserted at both the service/database layer and
the HTTP layer (see §5).

---

## 4. Invalid request and expected failure, on purpose

**Invalid request we reject on purpose.** `PATCH /tickets/:id/status` with
`status: "Resolved"` but no usable `resolutionNote` is rejected with
`400 Bad Request` — "A resolution note is required before resolving a ticket."
A `status` outside the enumeration (e.g. `"Cancelled"`) is rejected with `400`
by the validation pipe. Unknown extra fields are rejected with `400`
(`forbidNonWhitelisted`), so the contract is closed rather than permissive.
The database is left untouched when a request is rejected.

**Expected failure we handle on purpose.** The UI expects the backend to refuse
an empty note, so it renders the server's `400` message inline instead of
silently failing or crashing:

* [`ResolveControl.tsx`](../frontend/src/components/ResolveControl.tsx) catches
  the `ApiError` and shows it in `.form-error` next to the "Mark Resolved" button;
* [`RequesterView.tsx`](../frontend/src/components/RequesterView.tsx) and
  `AgentView.tsx` show a "check the connection" notice when the API cannot be
  reached, and a message when an action is refused.

The E2E test clicks **Mark Resolved** with an empty note and asserts that the
backend's validation message appears in the form before continuing with a
successful resolve.

---

## 5. Automated confidence

The Week 3 requirement is *"it is not lots of code and it is not lots of tests
— automate confidence."* Four focused layers cover the slice:

| # | Assignment requirement | Artifact | How to run |
|---|---|---|---|
| 1 | Automated test for a business rule | [`backend/test/domain-rules.spec.ts`](../backend/test/domain-rules.spec.ts) | `cd backend && npm run test:unit` |
| 2 | Integration test between backend and database | [`backend/test/tickets.database.integration.spec.ts`](../backend/test/tickets.database.integration.spec.ts) | `cd backend && npm run test:integration` |
| 3 | HTTP contract + authorization + regression | [`backend/test/tickets.api.spec.ts`](../backend/test/tickets.api.spec.ts) | `cd backend && npm run test:api` |
| 4 | Meaningful E2E test (real UI → real API → DB) | [`e2e/dom/resolve-slice.ui.test.tsx`](../e2e/dom/resolve-slice.ui.test.tsx) | `cd e2e && npm run test:ui` |
| | everything, isolated and automated | [`scripts/run-tests.mjs`](../scripts/run-tests.mjs) | `node scripts/run-tests.mjs` |

**1 — Business rule (pure, fast).** Proves the lifecycle rule
`Open → In Progress → Resolved` moves *exactly one step*: single forward steps
are allowed; skipping (`Open → Resolved`), reversing, and no-op transitions are
denied. Also pins the role→department mapping.

**2 — Backend ↔ database integration.** Boots the real `TicketsModule` +
`UsersModule` against a real SQL database (TypeORM `sqljs`, the same driver the
app uses) and asserts through TypeORM repositories, so it proves data is
**actually written to and read from** the database: ticket rows, `assignedToId`,
`resolutionNote`, and one `ticket_events` row per action. It also covers the
authorization allowed/denied cases and that an invalid resolution attempt writes
nothing.

**3 — HTTP boundary and regression.** Boots the full `AppModule` over the exact
same pipeline as `src/main.ts` (`configureApp`) and drives it with `supertest`:
`401` without a token, the full `open → claim → resolve → read back` flow,
`400` for invalid requests, `403` for denied actors, and `200` for the allowed
actor. Its `regression protection` block locks in behaviour that already worked
before this slice: requester/agent/admin listing scopes, department isolation,
self-registration rules, duplicate-email `409`, bad-credential `401`, and the
fact that password hashes never appear in responses.

**4 — E2E.** Renders the **real React app** in jsdom and drives it like a user,
with every request proxied to a **live NestJS backend** over HTTP, so the whole
loop `React action → PATCH /tickets/:id/status → SQLite → React result` is
exercised and the requester's list visibly ends up `Resolved` with the note.
A Playwright browser script ([`e2e/scripts/resolve-slice.e2e.mjs`](../e2e/scripts/resolve-slice.e2e.mjs))
offers the same journey in a real browser with screenshots when a Chromium
binary is available.

**Regression protection** is therefore explicit in two places (the `regression
protection` describe-block in the HTTP suite, and the regression block in the
integration suite), plus [`scripts/verify-slice.mjs`](../scripts/verify-slice.mjs),
which re-checks the live definition of done over HTTP — including the
restart-proof persistence check (`node scripts/verify-slice.mjs persist`).

### One command

```bash
node scripts/run-tests.mjs
```

This builds the backend, runs the three backend suites, starts an isolated
backend on a free port with a throwaway SQLite file, runs the live HTTP checks,
runs the UI E2E, then tears everything down and deletes the throwaway database.
It exits non-zero if anything fails.

---

## 6. How it was verified

The suite was executed in this repository; representative results:

```text
$ cd backend && npm test
 ✓ test/domain-rules.spec.ts                  ( 7 tests)  business rule
 ✓ test/tickets.database.integration.spec.ts  (12 tests)  backend <-> database
 ✓ test/tickets.api.spec.ts                   ( 8 tests)  HTTP contract + regression
 Test Files  3 passed (3)   Tests  27 passed (27)

$ node scripts/verify-slice.mjs full
 20/20 checks passed   (live HTTP definition of done, fresh database)

$ cd e2e && npm run test:ui
 ✓ dom/resolve-slice.ui.test.tsx (1 test)   React -> API -> SQLite
 Test Files  1 passed (1)   Tests  1 passed (1)
```

> The exact pass counts are asserted by the suite; re-run the commands above on
> your machine to reproduce them. A fresh clone needs only `npm install` in
> `backend/`, `frontend/`, and `e2e/` (see the top-level
> [`README.md`](../README.md)).

---

## 7. Requirements traceability

| Assignment requirement | Status | Evidence |
|---|---|---|
| One narrow, user-facing Service Request flow | ✅ | §1; `frontend/` + `backend/src/tickets/` |
| React frontend | ✅ | `frontend/src/components/` |
| NestJS backend | ✅ | `backend/src/` (modular monolith) |
| Real database persistence | ✅ | SQLite/TypeORM; restart-proof check in `verify-slice persist` |
| Explicit API request/response contract | ✅ | §2; `docs/api.md`; typed client in `frontend/src/api.ts` |
| Meaningful authorization rule (allowed + denied) | ✅ | §3; service + HTTP tests |
| Invalid request rejected on purpose | ✅ | §4; `400` tests in integration + HTTP suites |
| Expected failure handled on purpose | ✅ | §4; `ResolveControl` + E2E empty-note step |
| Automated test for a business rule | ✅ | `backend/test/domain-rules.spec.ts` |
| Integration test backend ↔ database | ✅ | `backend/test/tickets.database.integration.spec.ts` |
| Meaningful E2E test | ✅ | `e2e/dom/resolve-slice.ui.test.tsx` |
| Regression protection | ✅ | `tickets.api.spec.ts` + integration spec + `verify-slice.mjs` |
| `docs/week3-full-stack-delivery.md` | ✅ | this file |
| README a new engineer can follow | ✅ | top-level [`README.md`](../README.md) |

---

## 8. Boundaries

In scope for Week 3: the slice above, its boundaries, and its automated
confidence. Explicitly **not** included, per the assignment: external
integrations, runtime AI/RAG/MCP, CI/CD, deployment, monitoring, and production
infrastructure. The database is a local SQLite file (swappable for PostgreSQL
behind the same TypeORM repositories); there is no cloud dependency.

---

## Appendix — submission checklist

* Repository: `https://github.com/MichelKarmesty/Eurisko-Hub`
* Email subject, exactly:
  `AI Academy 2026 - Week 3 Submission - Full Name`
* Recipients (all four):
  `fouad.b@euriskomobility.com`, `toni.tannoury@eurisko.net`,
  `fawzi.c@euriskomobility.com`, `academy@eurisko.net`
