# Security Notes

This project is an internal MVP. The security-relevant decisions are small and
deliberate.

## One bootstrap account, no public registration

On an **empty** database the backend seeds exactly **one** account:

| Account | Email | Password |
|---|---|---|
| Admin | `admin@eurisko.com` (or `ADMIN_EMAIL`) | `Admin123!` (or `ADMIN_PASSWORD`) |

Everything else is created **from inside the app** by that Admin, on the
**Users** tab (`POST /users`, Admin-only), with an explicit role and password.
The same tab lets the Admin **delete** an account (`DELETE /users/:id`) — see
the authorization model below for exactly what deletion does.
See [ADR-004](decisions/ADR-004.md).

* **There is no public registration.** `POST /auth/register` does not exist
  (it returns `404`), so someone with network access cannot create an account.
* **There is no demo seeding and no demo-account endpoint**
  (`GET /demo/accounts` is gone). Nothing with a well-known password ships in
  the application.
* The seed can never lock a database out. It creates the Admin when the
  configured `ADMIN_EMAIL` does not exist and the database has **no Admin at
  all** — that is an empty database (the normal bootstrap) or a database that
  already has users (recovering an instance whose Admin email changed, e.g. a
  pre-ADR-004 database). It never duplicates an account and never resets the
  password of an existing Admin; if an Admin already exists under another email
  the running deployment is left alone.

**Before any real deployment:** set a strong `ADMIN_PASSWORD` and a real
`JWT_SECRET` (the default is a development value), and preferably change the
seeded Admin password after first login.

## Authorization model

Every rule is enforced at the API boundary, never in the client. The two global
guards are `JwtAuthGuard` (a valid bearer token is required unless a route is
`@Public`) and `RolesGuard` (`@Roles('Admin')` routes).

* **Employees** see only their own tickets and cannot change status.
* **Agents** see and claim only their own department's queue, and may resolve
  only tickets assigned to them.
* **Admins** see everything and manage users. They may **assign** an unclaimed
  ticket to a matching agent, **cancel** a request softly (with a required
  reason, never a hard delete), or change a status — but a change to a ticket
  they are not assigned to is an **override** that requires a recorded reason
  (ADR-002).
* **Admins can also delete an account** — an Employee, an IT/HR/Maintenance
  agent, or another Admin (`DELETE /users/:id`). A deleted account disappears
  from the Users list and can no longer sign in. An account with **no tickets
  and no history** is really deleted; an account that appears in tickets or
  history is **deactivated** instead, so the audit trail stays intact. Two
  guard-rails protect the hub itself: an Admin cannot delete **their own**
  account, and the **last active Admin** can never be deleted (400), so a
  database can never be locked out (ADR-004).
* Tickets are **never hard-deleted**: `Cancelled` is a terminal, fully audited
  status (ADR-003).

## Credentials and data

* Passwords are bcrypt-hashed and never returned by the API
  (`@Exclude()` on `passwordHash` plus a global serializer).
* Login failures are generic (`401 Invalid credentials.`) for both a wrong email
  and a wrong password, so the endpoint cannot be used to enumerate accounts.
* The request contract is closed: the global `ValidationPipe` rejects unknown
  fields (`forbidNonWhitelisted`).

## Test fixtures are not an application feature

The automated suites need accounts to drive the UI. They create them through the
**same Admin API** a human would use (`e2e/global-setup.ts`,
`scripts/verify-slice.mjs`). Those fixture credentials (`rana.khoury@…`,
`karim.haddad@…`, …) exist only inside the test harnesses and are never seeded
by the application.
