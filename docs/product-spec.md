# Product Specification: Internal Operations Service Hub (MVP)

## 1. Problem & Context
**What problem are we solving?**
Employees currently ask for IT, HR, or Maintenance help through WhatsApp and scattered emails. Requests get buried, people lose track of what is happening, and support teams have no shared queue. This MVP gives everyone one simple place to submit, follow, and resolve requests.

## 2. Actors & Stakeholders
**Who uses it?**
* **Employee (Requester):** Opens a ticket when they need help and checks its progress.
* **Support Agent (IT / HR / Maintenance):** Works on tickets for their department and records the outcome.
* **Admin / Manager:** Sees every ticket across the company and can spot work that needs attention.

## 3. Functional Requirements
**What must the product do?**
* **Authentication & Authorization:** Only the **Admin** account is seeded; the Admin creates every other account (employees and IT/HR/Maintenance agents) from inside the app ([ADR-004](decisions/ADR-004.md)) — there is **no public registration**. Accounts use **any real email address** (Gmail, Hotmail/Outlook, Yahoo, a company domain) and a password. A user who forgets their password is given a **one-time link by the Admin** (**Users → Reset password**, [ADR-007](decisions/ADR-007.md) / [ADR-009](decisions/ADR-009.md)), and a signed-in user can **change** it by confirming the current one ([ADR-005](decisions/ADR-005.md)). Role-Based Access Control (RBAC) ensures employees, agents, and admins only see the views and tickets they are allowed to access.
* **Ticket Submission:** Employees can create a ticket with a Title, Category (Fixed list: IT, HR, Maintenance), Priority (Low, Medium, High), and Description.
* **AI-Assisted Intake (advisory, [ADR-006](decisions/ADR-006.md) / [week4-production-ai.md](week4-production-ai.md)):** On the New Request form an employee may describe the problem in their own words and ask the AI to **suggest** a Category, Priority and Title. The suggestion only pre-fills editable fields; the employee decides, and the unchanged `POST /tickets` is the only way a ticket is created. The AI never creates or changes a ticket, never writes to the database, and its output is validated against the domain enums. When no model is configured or reachable, a clearly-labelled offline classifier answers instead.
* **Ticket Dashboard (Requester):** Employees can see a list of their own tickets and their current status.
* **Agent Queue:** Agents can view open tickets for their department.
* **Status Updates & Notes:** Agents can claim a ticket, change its status (`Open` -> `In Progress` -> `Resolved`), and add a simple text "Resolution Note" when closing it.
* **Admin Dashboard:** Admins and managers can view all tickets across all departments in one place.
* **Admin Ticket Actions (RBAC, [ADR-002](decisions/ADR-002.md) / [ADR-003](decisions/ADR-003.md)):** An Admin can **assign** an unclaimed ticket to an agent of the matching department, **cancel** a request softly with a required reason (the ticket and its history are kept — never hard-deleted), and change any ticket's status only as an explicit **override** that records a reason. These are the "actions beyond viewing" this spec originally deferred.

## 4. Non-Functional Requirements
**What should using it feel like?**
* **Simplicity:** The interface should use familiar forms and clear lists so that opening or handling a ticket feels straightforward.
* **Responsiveness:** Pages should load quickly, and status changes should be visible immediately.

## 5. Known Facts
**What do we know for sure?**
* This is an internal tool for one company.
* The MVP focuses on the core workflow: open a ticket, track it, and close it.

## 6. Assumptions, Constraints, & Unknowns
* **Assumption:** Accounts are provisioned by an Admin; people sign in with an email address (any real domain) and a password. There is no self-registration.
* **Constraint (Manual Assignment):** Tickets are not automatically assigned to individual agents. Agents choose and claim tickets from their department's open queue.

## 7. Non-Goals
**What is explicitly out of scope for this MVP?**
* No automated email/SMS notifications about tickets (the only transactional
  email the code can send is the optional password-reset link of
  [ADR-008](decisions/ADR-008.md), which is **off by default** per
  [ADR-009](decisions/ADR-009.md) — recovery is Admin-initiated).
* No complex SLA breach background timers.
* **No autonomous AI.** The only AI is the *advisory* Request Intake of
  [ADR-006](decisions/ADR-006.md) / [week4-production-ai.md](week4-production-ai.md):
  it suggests form fields for a human to accept or edit, never creates or changes
  a ticket, and has no database access. No chatbots, no autonomous agents or
  workflow automation, and no external enterprise integrations (ERP/CRM).
* No complex Single Sign-On (SSO).

## 8. Acceptance Criteria (Scenarios)
**How will we know it works?**
* **Scenario 1: Opening & Prioritizing a Ticket**
  * *Action:* An employee (whose account an Admin created) logs in, selects the "IT" category, sets Priority to "High", and writes "My screen is broken."
  * *Result:* The ticket appears in their dashboard as `Open`.
* **Scenario 2: Resolving a Ticket with a Note**
  * *Action:* An IT agent logs in, sees the "broken screen" ticket in the IT queue, claims it, fixes it, adds a note saying "Replaced HDMI cable", and changes status to `Resolved`.
  * *Result:* The ticket moves to the "Resolved" section, and the employee sees the updated status and the resolution note.
* **Scenario 3: Admin Global View & Actions**
  * *Action:* The Admin logs in and opens their dashboard.
  * *Result:* The admin sees tickets from IT, HR, and Maintenance in one combined list, and may act on them under guard: assign an unclaimed ticket to a matching agent, cancel a request with a reason (kept for audit, never deleted), or change a status as a recorded override (ADR-002/ADR-003). Employees and Agents still cannot see other departments or change statuses they do not own.
* **Scenario 4: Recovering a Forgotten Password**
  * *Action:* An employee who cannot remember their password asks the Admin, who opens **Users → Reset password** and hands them a one-time link (or, when the Admin is the locked-out person, an operator runs `scripts/reset-password.mjs` offline). The employee opens the link and chooses a new password. A signed-in user instead uses **Change password**. (A public, emailed "forgot password" variant exists in the code but is off by default — ADR-008/ADR-009.)
  * *Result:* The new password works immediately and the old one stops working; the one-time link expires and cannot be reused, the Admin never sees or chooses the password, and no password is ever displayed or stored in readable form.
* **Scenario 5: AI-Assisted Intake (advisory)**
  * *Action:* On the New Request form the employee types "my laptop screen flickers and I can't work" and presses **AI Suggest**.
  * *Result:* Category, Priority and Title are pre-filled and tagged **AI suggested**; every field stays editable, the tag clears when edited, and **Open ticket** still calls the unchanged `POST /tickets`. If no model answers, the fields come from the clearly-labelled offline classifier instead, and the form still works by hand.