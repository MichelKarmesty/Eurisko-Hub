# Architecture Draft: Internal Operations Service Hub

**Related Documents:** [Product Specification](product-spec.md) | [Data Model](data-model.md) | [ADR-001: Ticket Assignment](decisions/ADR-001.md)

---

## 1. Purpose & Scope
### Why are we building it this way?
This document turns the product specification into a practical system design. The goal is simple: give IT, HR, and Maintenance one reliable place to receive, track, and resolve requests instead of relying on scattered messages and emails.

### Actors & System Boundary
* **Inside the boundary:** The system consists of a web client, a backend API, and one relational database. It is entirely internal.
## Outside the Boundary (Actors):
  * **Requester (Employee):** Submits tickets and checks their status.
  * **Support Agent:** Works from a department-specific queue and updates ticket status.
  * **Admin/Manager:** Views all tickets across all departments and manages user accounts. May also **assign** an unclaimed ticket to a matching agent, **cancel** a request softly (audited, never deleted), delete a `Resolved` ticket outright ([ADR-010](decisions/ADR-010.md)), or change a ticket's status only as a recorded **override** with a reason ([ADR-002](decisions/ADR-002.md) / [ADR-003](decisions/ADR-003.md)).
  * **External dependencies:** None required for the Phase 1 MVP, and none for password recovery. There is no SSO or ERP integration. A forgotten password is recovered by the **Admin**, who mints a one-time link inside the app ([ADR-007](decisions/ADR-007.md), [ADR-009](decisions/ADR-009.md)) (no mail server is involved) and a lone Admin who is locked out uses the offline `scripts/reset-password.mjs` break-glass. The public, emailed self-service path exists but is off by default ([ADR-008](decisions/ADR-008.md)). The AI-assisted intake's model provider is **optional**: with no key or provider configured the service answers from a local keyword classifier and labels the result `source: "offline"`, so a cloud model (the default is Groq's free OpenAI-compatible API) is never required to run the app ([ADR-006](decisions/ADR-006.md)).

## 2. Structure & Flow
### Components & Responsibilities
To keep the system easy to understand and operate, the first version is a modular monolith with three main parts:
1. Web Client (Frontend App): Renders the submission forms, requester dashboard, agent queue, and admin view. It presents data but does not enforce business rules.
2. Backend API (Core Server): Enforces the rules and exposes the application operations. It contains three main modules:
  * **Auth Module:** Handles login, identifies each user's role, and provides password recovery/change (one-time reset links and an authenticated change, [ADR-005](decisions/ADR-005.md)). There is no public registration (ADR-004); accounts are provisioned by an Admin through the Users API. Recovery is **Admin-initiated** (the Admin hands over a one-time link ([ADR-007](decisions/ADR-007.md), [ADR-009](decisions/ADR-009.md))) so no external service is required. An optional `MailModule` (primary SMTP → backup SMTP → webhook → Resend → console) can email the link instead; the public, self-service route is **off by default** (`PASSWORD_RESET_SELF_SERVICE`).
  * **Ticket Module:** Handles ticket operations, limits agents to their department, and processes status changes.
  * AI Intake Module (advisory): Classifies a free-form problem description into a suggested Category/Priority/Title through an OpenAI-compatible provider. It has **no database access**, returns a candidate only, and validates every value against the domain enums; the Ticket Module remains the only writer ([ADR-006](decisions/ADR-006.md)).
3. **Primary Database:** The source of truth for user credentials, tickets, and ticket history.

### Important Data Flows (Traceability to Spec):
* **Requirement:** Route tickets by department.
* **Flow:** The Web Client sends a `POST` request with the ticket details, including `category`. The Ticket Module stores the ticket in that department's queue. When an agent sends a `GET` request, the API filters the response using the agent's department role.

## 3. Trust & Resilience
### Trust & Authorization Boundaries
* **Client vs. Server:** The Web Client cannot be trusted to enforce permissions. Every authorization check, such as preventing an IT agent from reading HR tickets, must happen at the Backend API boundary.
* Role-Based Access Control (RBAC): The Auth Module applies permissions using the user's role from the database.
* Admin actions are governed, not unlimited: assignment is checked against the ticket's department, cancellation is soft (the row and history survive), and any status change on a ticket the Admin is not assigned to is an explicit override that requires a recorded reason. All three are enforced in the Ticket Module, never in the client.
* AI output is untrusted input: the model's answer is treated like a request body from the internet (parsed defensively and then coerced to the domain enums before it is ever returned) and it can never reach the database because the AI Intake Module has no repository. The employee accepts, edits or ignores the suggestion ([ADR-006](decisions/ADR-006.md)).

### Failure Scenarios (Component & In-Between Network Level):
* **Web Client failure:** If the browser tab freezes or crashes, the user can refresh the page. Unsaved form data will be lost, but saved tickets remain safe.
* **Network failure:** If the connection drops or the server times out, the UI shows a "Check your connection" message instead of hanging indefinitely.
* **Backend API failure:** An unexpected server error returns a standard `500 Internal Server Error`. The UI shows "Something went wrong," and a process manager such as PM2 can restart the server.
* **Database failure:** The API logs the technical connection error on the server and returns a generic `500 Internal Server Error`. The UI shows "System Offline - Please try again."

### Scalability & Reliability:
This is an internal tool for one company, so traffic should be predictable and low-volume. One API instance and one database are enough for Phase 1. If usage grows, we can scale vertically first.

## 4. Decisions
### Communication Decisions:
* **Synchronous REST API:** The frontend and backend communicate through standard synchronous HTTP requests. Because SLA timers and email notifications are outside the MVP, we do not need message queues such as Kafka or RabbitMQ or background workers yet.

### Major Architecture Decisions:
* Monolith instead of microservices: The system is built as a monolith. Microservices would add operational overhead without solving a problem in this small, straightforward workflow.

* **Manual ticket assignment:** Assignment is manual, as described in the product constraints. Agents claim tickets themselves, so the API does not need stateful load-balancing or assignment algorithms. It only updates the ticket's `assignedToId` when an agent claims it.