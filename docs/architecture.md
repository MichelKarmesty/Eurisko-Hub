# Architecture Draft: Internal Operations Service Hub

**Related Documents:** [Product Specification](product-spec.md) | [Data Model](data-model.md) | [ADR-001: Ticket Assignment](decisions/ADR-001.md)

---

## 1. Purpose & Scope
### What is driving the design?
This architecture directly translates the "Internal Operations Service Hub" product specification into a structural design. The core goal is to replace chaotic internal communication (WhatsApp, emails) with a centralized, auditable tracking system for IT, HR, and Maintenance requests.

### Actors & System Boundary:
* System Boundary:  The system consists of a web client, a centralized backend API, and a single relational database. It is entirely internal.
## Outside the Boundary (Actors):
  * Requester (Employee): Submits tickets and reads their own statuses.
  * Support Agent: Reads department-specific queues and updates ticket statuses.
  * Admin/Manager: Reads all tickets across all departments globally.(can be modified later on to take action)
  * External Dependencies: None for Phase 1 MVP (no SSO, no external email services, no Core Banking/ERP integrations) to ensure high isolation and simple delivery.

## 2. Structure & Flow
### Components & Responsibilities:
Based on the principle of keeping it explainable, the system is designed as a modular monolith with three major parts:
1. Web Client (Frontend App): Responsible for the UI. It renders the submission forms, the Requester dashboard, the Agent queue, and the Admin global view. It holds no business logic.
2. Backend API (Core Server): Responsible for enforcing rules. It contains two main modules:
   * Auth Module: Handles login and role identification (Employee vs. Agent vs. Admin).
   * Ticket Module: Handles the CRUD operations, ensures agents only see their category, and processes status changes.
3. Primary Database:** The sole source of truth, persisting user credentials and ticket history.

### Important Data Flows (Traceability to Spec):
* Requirement:* "Automated Routing (By Department)".
* Flow: The Web Client sends a `POST` request with the ticket payload (including `category`). The Backend API's Ticket Module receives it, inherently assigning it to the matching department bucket in the database. The Agent Client later sends a `GET` request, and the API filters the response based on the Agent's category role.

## 3. Trust & Resilience
### Trust & Authorization Boundaries:
* Client vs. Server: The Web Client is entirely untrusted. All authorization checks (e.g., verifying an IT Agent is not trying to read HR tickets) must happen at the Backend API boundary.
* Role-Based Access Control (RBAC): The Auth Module enforces strict boundaries based on the user's role retrieved from the database, satisfying the "Role-Based Access" privacy requirement from the spec.

### Failure Scenarios (Component & In-Between Network Level):
* What happens if the Web Client (UI) fails?
  If the user's browser tab freezes or crashes, the fix is a simple page refresh. Unsaved form data is lost, but the system's core data remains safe and untainted.
* What happens during a Network Failure (UI <-> API)? 
  If the user loses WiFi or the server takes too long to respond (timeout), the UI catches the network error and displays a "Check your connection" alert to prevent a silent freeze or an infinite loading spinner.
* What happens if the Backend API (Server) fails?*
  If an unexpected code bug causes the server to fail, it returns a standard `500 Internal Server Error`. The UI catches this and shows a friendly "Something went wrong" message. A process manager (e.g., PM2) will automatically restart the server in the background.
* What happens if the Database goes down (API <-> DB)?
  The Backend API will fail to read/write. It will catch the connection error, log the technical details securely on the server, and return a safe, generic `500 Internal Server Error` to the Web Client instead of crashing the entire backend application. The Web Client will gracefully display a "System Offline - Please try again" message.

### Scalability & Reliability:
Since this is an internal tool for a single company, traffic is predictable and low-volume. A single instance of the Backend API and a single Database are perfectly realistic and sufficient for Phase 1. Scalability will be achieved vertically if needed.

## 4. Decisions
### Communication Decisions:
* Synchronous REST API: The frontend and backend will communicate via standard synchronous HTTP requests. Since automated SLA timers and email notifications were explicitly moved to "Non-Goals" in the spec, there is no need for asynchronous message queues (like Kafka or RabbitMQ) or background workers.

### Major Architecture Decisions:
* Monolithic Architecture vs. Microservices: The system is built as a monolith. Introducing microservices for this MVP would violate the requirement to avoid "unnecessary microservices" and would add unjustified operational overhead for a simple ticketing flow.

* Manual Ticket Assignment:** As stated in the spec's constraints, assignment is manual. This architecturally removes the need for complex, stateful load-balancing logic or assignment algorithms within the Backend API; the database simply updates the `assigned_to` field when an Agent explicitly claims a ticket.