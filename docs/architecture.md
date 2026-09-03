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
  * **Admin/Manager:** Can view all tickets across all departments. Actions beyond viewing can be added later.
  * **External dependencies:** None in the Phase 1 MVP. There is no SSO, external email service, or ERP integration, which keeps the first release isolated and straightforward to deliver.

## 2. Structure & Flow
### Components & Responsibilities
To keep the system easy to understand and operate, the first version is a modular monolith with three main parts:
1. **Web Client (Frontend App):** Renders the submission forms, requester dashboard, agent queue, and admin view. It presents data but does not enforce business rules.
2. **Backend API (Core Server):** Enforces the rules and exposes the application operations. It contains two main modules:
  * **Auth Module:** Handles login and identifies each user's role.
  * **Ticket Module:** Handles ticket operations, limits agents to their department, and processes status changes.
3. **Primary Database:** The source of truth for user credentials, tickets, and ticket history.

### Important Data Flows (Traceability to Spec):
* **Requirement:** Route tickets by department.
* **Flow:** The Web Client sends a `POST` request with the ticket details, including `category`. The Ticket Module stores the ticket in that department's queue. When an agent sends a `GET` request, the API filters the response using the agent's department role.

## 3. Trust & Resilience
### Trust & Authorization Boundaries
* **Client vs. Server:** The Web Client cannot be trusted to enforce permissions. Every authorization check, such as preventing an IT agent from reading HR tickets, must happen at the Backend API boundary.
* **Role-Based Access Control (RBAC):** The Auth Module applies permissions using the user's role from the database.

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
* **Monolith instead of microservices:** The system is built as a monolith. Microservices would add operational overhead without solving a problem in this small, straightforward workflow.

* **Manual ticket assignment:** Assignment is manual, as described in the product constraints. Agents claim tickets themselves, so the API does not need stateful load-balancing or assignment algorithms. It only updates `assigned_to` when an agent claims a ticket.