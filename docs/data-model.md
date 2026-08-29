# Data Model: Internal Operations Service Hub

**Related Documents:** [Product Specification](product-spec.md) | [Architecture Design](architecture.md) | [ADR-001: Ticket Assignment](decisions/ADR-001.md)

---

## 1. DOMAIN (Entities & Relationships)
*   **User:** Represents all individuals interacting with the system. Contains credentials and a strictly defined Role (Employee, IT_Agent, HR_Agent, Maintenance_Agent, Admin).
*   **Ticket:** The core entity representing a request. Contains Title, Description, Category, Priority, Status, and Resolution Note.
*   **Relationships & Cardinality:** 
    *   A User (Requester) can own *many* Tickets (1-to-M).
    *   A Ticket belongs to exactly *one* Requester.
    *   A Ticket is claimed by *zero or one* User (Agent).

## 2. LIFECYCLE & RULES (State & Invariants)
*   **State Transitions:** A Ticket's status strictly flows as: `Open` -> `In Progress` -> `Resolved`.
*   **Invariants:** 
    *   A Ticket cannot be created without a valid Category (IT, HR, Maintenance).
    *   A Ticket cannot transition to `Resolved` without a Resolution Note attached.
*   **Authorization-Sensitive Rules:** 
    *   An Agent can only read or claim a ticket if the Ticket's Category matches the Agent's Role.

## 3. STORAGE (Implementation Input)
*   **Relational Reasoning:** The system will use a Relational Database (SQL). The domain has strict schemas, predictable relationships (Users -> Tickets), and requires strong consistency (ACID properties) to ensure no ticket state is corrupted or lost.
*   **Durable vs. Derived:** All ticket details, user roles, and status changes are highly durable and persisted to disk. Ticket volume metrics for the Admin view are derived (calculated dynamically via SQL aggregations on read).

## 4. ACCESS (Implementation Input)
*   **Important Queries / Access Patterns:**
    *   *Requester Pattern:* `SELECT * FROM Tickets WHERE requester_id = [Current User]`
    *   *Agent Pattern:* `SELECT * FROM Tickets WHERE category = [Agent's Category] AND status = 'Open'`
    *   *Admin Pattern:* `SELECT * FROM Tickets` (Global view)
*   **Indexes:** An index is justified on the `category` and `status` columns, as these are the primary filters used by Agents to constantly refresh their queues.