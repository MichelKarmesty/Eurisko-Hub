# Data Model: Internal Operations Service Hub

**Related Documents:** [Product Specification](product-spec.md) | [Architecture Design](architecture.md) | [ADR-001: Ticket Assignment](decisions/ADR-001.md)

---

## 1. Domain: Entities & Relationships
*   **User:** Anyone who uses the system. A user has login credentials and one defined role: Employee, IT_Agent, HR_Agent, Maintenance_Agent, or Admin.
    *   `email` is unique and validated as an email only - **any real domain** is
        accepted (Gmail, Hotmail/Outlook, Yahoo, a company domain); no domain is
        privileged (ADR-005).
    *   `passwordHash` is a bcrypt hash (never exposed). Password **recovery**
        (ADR-005) adds two transient fields: `passwordResetTokenHash` (SHA-256 of
        a one-time token - the raw token is never stored) and
        `passwordResetExpiresAt` (epoch ms, default +30 minutes). Both are cleared
        whenever the password changes, and both are excluded from API responses.
    *   `isActive` (boolean, default `true`) is the soft-removal flag: an account
        that appears on any ticket or history row is **deactivated** instead of
        deleted, so the audit trail survives (`DELETE /users/:id`, ADR-004).
    *   `createdAt` records when the account was created.
*   **Ticket:** A request for help. It contains a title, description, category,
    priority, status, and resolution note, plus the three user references -
    `requesterId` (required, `ON DELETE RESTRICT`), `assignedToId` and
    `resolvedById` (both nullable, `ON DELETE SET NULL`) - and `createdAt` /
    `updatedAt` timestamps.
*   **TicketEvent:** one row per thing that happened to a ticket - `ticketId`,
    `actorId`, `action` (`CREATED` / `CLAIMED` / `ASSIGNED` / `STATUS_CHANGED` /
    `RESOLVED` / `ADMIN_OVERRIDE` / `CANCELLED`), optional `fromStatus` /
    `toStatus` / `note`,
    and `createdAt`. It is the durable audit trail behind
    `GET /tickets/:id/history` and is never edited (`ON DELETE CASCADE` from the
    ticket, `RESTRICT` from the actor).
*   **Relationships:**
    *   A requester can own many tickets (1-to-M).
    *   Each ticket belongs to exactly one requester.
    *   A ticket can be claimed by zero or one agent.
    *   A ticket has zero-to-many history events; each event has exactly one actor.

    These `ON DELETE` actions are real, not decorative: SQLite honours them only
    while `PRAGMA foreign_keys` is ON, which `AppModule` sets on its connection at
    bootstrap (`backend/test/admin-user-deletion.spec.ts` pins it).

    One more delete path exists on tickets themselves ([ADR-010](decisions/ADR-010.md)):
    an Admin may permanently delete a `Resolved` ticket, which removes the
    ticket row and, with it, every `TicketEvent` that referenced it - deliberately,
    in a single transaction. Nothing else in the schema references a ticket, so no
    other row is affected.

## 2. Lifecycle & Rules
*   **Status flow:** A ticket moves from `Open` to `In Progress` to `Resolved`.
    *   `Cancelled` is a separate **terminal** status an Admin can set directly
        (ADR-003). It is not part of the linear flow, so a normal status change
        can never skip to it.
*   **Rules:**
    *   A ticket needs a valid category: IT, HR, or Maintenance.
    *   A ticket cannot move to `Resolved` without a resolution note.
    *   A ticket records who actually resolved it (`resolvedById`) - the assigned
        agent, or the Admin in an override.
*   **Permission rule:** An agent can read or claim a ticket only when its category matches the agent's department. An Admin may **assign** an `Open`, unclaimed ticket to a matching agent, **override** with a recorded reason (ADR-002), or **cancel** it softly (ADR-003) - but never delete it.

## 3. Storage
*   **Why SQL:** The system has clear schemas, predictable User-to-Ticket relationships, and needs strong consistency (ACID properties) so ticket data is not lost or corrupted.
*   **Stored vs. calculated:** Ticket details, user roles, and status changes are stored durably. Admin volume metrics are calculated when the dashboard reads the data.

## 4. Access Patterns
*   **Important queries:**
    *   *Requester Pattern:* `SELECT * FROM Tickets WHERE requester_id = [Current User]`
    *   *Agent Pattern:* `SELECT * FROM Tickets WHERE category = [Agent's Category] AND status = 'Open'`
    *   *Admin Pattern:* `SELECT * FROM Tickets` (Global view)
*   **Indexes:** A single composite index on `(category, status)` backs the agent
    queue - the list agents refresh most often. Being composite, it does not serve
    a filter on `status` alone; nothing queries that way today.