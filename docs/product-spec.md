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
* **Authentication & Authorization:** Users can register and log in. Role-Based Access Control (RBAC) ensures employees, agents, and admins only see the views and tickets they are allowed to access.
* **Ticket Submission:** Employees can create a ticket with a Title, Category (Fixed list: IT, HR, Maintenance), Priority (Low, Medium, High), and Description.
* **Ticket Dashboard (Requester):** Employees can see a list of their own tickets and their current status.
* **Agent Queue:** Agents can view open tickets for their department.
* **Status Updates & Notes:** Agents can claim a ticket, change its status (`Open` -> `In Progress` -> `Resolved`), and add a simple text "Resolution Note" when closing it.
* **Admin Dashboard:** Admins and managers can view all tickets across all departments in one place.

## 4. Non-Functional Requirements
**What should using it feel like?**
* **Simplicity:** The interface should use familiar forms and clear lists so that opening or handling a ticket feels straightforward.
* **Responsiveness:** Pages should load quickly, and status changes should be visible immediately.

## 5. Known Facts
**What do we know for sure?**
* This is an internal tool for one company.
* The MVP focuses on the core workflow: open a ticket, track it, and close it.

## 6. Assumptions, Constraints, & Unknowns
* **Assumption:** Users will register with an email address and password.
* **Constraint (Manual Assignment):** Tickets are not automatically assigned to individual agents. Agents choose and claim tickets from their department's open queue.

## 7. Non-Goals
**What is explicitly out of scope for this MVP?**
* No automated email/SMS notifications.
* No complex SLA breach background timers.
* No AI, Chatbots, or external enterprise integrations.
* No complex Single Sign-On (SSO).

## 8. Acceptance Criteria (Scenarios)
**How will we know it works?**
* **Scenario 1: Opening & Prioritizing a Ticket**
  * *Action:* An employee logs in, selects the "IT" category, sets Priority to "High", and writes "My screen is broken."
  * *Result:* The ticket appears in their dashboard as `Open`.
* **Scenario 2: Resolving a Ticket with a Note**
  * *Action:* An IT agent logs in, sees the "broken screen" ticket in the IT queue, claims it, fixes it, adds a note saying "Replaced HDMI cable", and changes status to `Resolved`.
  * *Result:* The ticket moves to the "Resolved" section, and the employee sees the updated status and the resolution note.
* **Scenario 3: Admin Global View**
  * *Action:* The Admin logs in and opens their dashboard.
  * *Result:* The admin sees tickets from IT, HR, and Maintenance in one combined list. Admin actions beyond viewing can be added later.