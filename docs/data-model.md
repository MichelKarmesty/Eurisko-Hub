# Data Model: Internal Operations Service Hub

**Related Documents:** [Product Specification](product-spec.md) | [Architecture Design](architecture.md) | [ADR-001: Ticket Assignment](decisions/ADR-001.md)

---

## 1. Domain: Entities & Relationships
*   **User:** Anyone who uses the system. A user has login credentials and one defined role: Employee, IT_Agent, HR_Agent, Maintenance_Agent, or Admin.
*   **Ticket:** A request for help. It contains a title, description, category, priority, status, and resolution note.
*   **Relationships:**
    *   A requester can own many tickets (1-to-M).
    *   Each ticket belongs to exactly one requester.
    *   A ticket can be claimed by zero or one agent.

## 2. Lifecycle & Rules
*   **Status flow:** A ticket moves from `Open` to `In Progress` to `Resolved`.
*   **Rules:**
    *   A ticket needs a valid category: IT, HR, or Maintenance.
    *   A ticket cannot move to `Resolved` without a resolution note.
*   **Permission rule:** An agent can read or claim a ticket only when its category matches the agent's department.

## 3. Storage
*   **Why SQL:** The system has clear schemas, predictable User-to-Ticket relationships, and needs strong consistency (ACID properties) so ticket data is not lost or corrupted.
*   **Stored vs. calculated:** Ticket details, user roles, and status changes are stored durably. Admin volume metrics are calculated when the dashboard reads the data.

## 4. Access Patterns
*   **Important queries:**
    *   *Requester Pattern:* `SELECT * FROM Tickets WHERE requester_id = [Current User]`
    *   *Agent Pattern:* `SELECT * FROM Tickets WHERE category = [Agent's Category] AND status = 'Open'`
    *   *Admin Pattern:* `SELECT * FROM Tickets` (Global view)
*   **Indexes:** An index is justified on the `category` and `status` columns, as these are the primary filters used by Agents to constantly refresh their queues.