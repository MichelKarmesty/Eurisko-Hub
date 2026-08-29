# Product Specification: Internal Operations Service Hub (MVP)

## 1. Problem & Context
**What problem are you solving?**
Internal communication in companies is often messy. Employees ask for IT, HR, or Maintenance help via WhatsApp or random emails, leading to lost requests and confusion. This Minimum Viable Product (MVP) provides a simple ticketing system where employees can submit requests and support agents can track and resolve them in one place.

## 2. Actors & Stakeholders
**Who is involved?**
* **Employee (Requester):** Submits tickets when they need help.
* **Support Agent (IT / HR / Maintenance):** Receives and fixes the issue for their specific department.
* **Admin / Manager:** Has access to view all tickets across all departments to ensure nothing is ignored.

## 3. Functional Requirements
**What must the product do?**
* **Authentication & Authorization:** Standard self-registration and login, with Role-Based Access Control (RBAC) to ensure users (Employees, Agents, Admins) only access their permitted views.
* **Ticket Submission:** Employees can create a ticket with a Title, Category (Fixed list: IT, HR, Maintenance), Priority (Low, Medium, High), and Description.
* **Ticket Dashboard (Requester):** Employees can see a list of their own tickets and their current status.
* **Agent Queue:** Agents can view a list of open tickets assigned strictly to their category.
* **Status Updates & Notes:** Agents can claim a ticket, change its status (`Open` -> `In Progress` -> `Resolved`), and add a simple text "Resolution Note" when closing it.
* **Admin Dashboard:** Admins/Managers have a global view of all tickets across all categories to monitor overall volume and operations.

## 4. Non-Functional Requirements
**How well must the system perform?**
* **Simplicity:** The UI must be clean and simple, using standard forms and clear tables/lists.
* **Responsiveness:** The app should load fast and provide immediate visual feedback when a status is updated.

## 5. Known Facts
**What is absolutely certain?**
* This is an internal tool only. 
* It focuses strictly on the core workflow of opening, tracking, and closing a ticket.

## 6. Assumptions, Constraints, & Unknowns
* **Assumptions:** Users will self-register with a standard email and password (basic authentication).
* **Constraints (Manual Assignment):** The system does not auto-assign tickets to specific agents. Agents look at the "Open" list and manually claim what they want to work on.

## 7. Non-Goals
**What is explicitly out of scope for this MVP?**
* No automated email/SMS notifications.
* No complex SLA breach background timers.
* No AI, Chatbots, or external enterprise integrations.
* No complex Single Sign-On (SSO).

## 8. Acceptance Criteria (Scenarios)
**How do we know it works?**
* **Scenario 1: Opening & Prioritizing a Ticket**
  * *Action:* An employee logs in, selects the "IT" category, sets Priority to "High", and writes "My screen is broken."
  * *Result:* The ticket appears in their dashboard as `Open`.
* **Scenario 2: Resolving a Ticket with a Note**
  * *Action:* An IT agent logs in, sees the "broken screen" ticket in the IT queue, claims it, fixes it, adds a note saying "Replaced HDMI cable", and changes status to `Resolved`.
  * *Result:* The ticket moves to the "Resolved" section, and the employee sees the updated status and the resolution note.
* **Scenario 3: Admin Global View**
  * *Action:* The Admin logs in and opens their dashboard.
  * *Result:* The Admin successfully views all tickets from IT, HR, and Maintenance in one combined list.(can be modified later on to take action)