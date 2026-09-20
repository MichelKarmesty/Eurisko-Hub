# Security Notes

This project is an internal MVP. The security-relevant decisions are small and
deliberate.

## One bootstrap account, no public registration

On an **empty** database the backend seeds exactly **one** account:

| Account | Email | Password |
|---|---|---|
| Admin | `admin@eurisko.com` (or `ADMIN_EMAIL`) | `Admin123!` (or `ADMIN_PASSWORD`) |

`admin@eurisko.com` is only the development default: the application accepts
**any real email address** — a personal provider (Gmail, Hotmail/Outlook, Yahoo)
or a company domain. Every account email is validated with `@IsEmail()` and
nothing else, so no domain is privileged or blocked (ADR-005). Use a deliverable
address for the Admin, and for anyone who must receive reset emails **if** the
opt-in self-service route is enabled (`PASSWORD_RESET_SELF_SERVICE=true`); by
default the Admin hands the one-time link over directly, so no mailbox is needed
(ADR-009).

Everything else is created **from inside the app** by that Admin, on the
**Users** tab (`POST /users`, Admin-only), with an explicit role and password.
The same tab lets the Admin **delete** an account (`DELETE /users/:id`) — see
the authorization model below for exactly what deletion does.
See [ADR-004](decisions/ADR-004.md).

* **There is no public registration.** `POST /auth/register` does not exist
  (it returns `404`), so someone with network access cannot create an account.
* **There is no demo seeding and no demo-account endpoint**
  (`GET /demo/accounts` is gone). No demo *accounts* ship: the only account the
  application ever creates by itself is the bootstrap Admin, whose password comes
  from `ADMIN_PASSWORD` — the `Admin123!` development default is a placeholder to
  be replaced before any real deployment, not a shipped credential.
* The seed can never lock a database out. It creates the Admin when the
  configured `ADMIN_EMAIL` does not exist and the database has **no Admin at
  all** — that is an empty database (the normal bootstrap) or a database that
  already has users (recovering an instance whose Admin email changed, e.g. a
  pre-ADR-004 database). It never duplicates an account and never resets the
  password of an existing Admin; if an Admin already exists under another email
  the running deployment is left alone.

**Before any real deployment:** set a strong `ADMIN_PASSWORD` and a real
`JWT_SECRET` (the default is a development value), give the Admin a deliverable
email address, and preferably change the seeded Admin password after first login.
Password recovery works with **no** mail provider (ADR-007/ADR-009): an Admin
issues one-time links from the app, and `scripts/reset-password.mjs` covers a
locked-out lone Admin. The public, self-service path stays **off** unless you set
`PASSWORD_RESET_SELF_SERVICE=true` and a provider (`SMTP_HOST` /
`MAIL_WEBHOOK_URL` / `RESEND_API_KEY`).

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
  history is **deactivated** instead, so the audit trail stays intact — "appears"
  covers every way an account can be attached to a ticket: the requester, the
  **assignee**, the **resolver**, or the actor of a history event (`assignedToId`
  / `resolvedById` are counted too, so an Admin-assigned agent is never deleted
  out from under a live ticket). Two
  guard-rails protect the hub itself: an Admin cannot delete **their own**
  account, and the **last active Admin** can never be deleted (400), so a
  database can never be locked out (ADR-004).
* **A deactivated account keeps its email — and creating it again revives the
  same row** (`POST /users`, `PATCH /users/:id/active`, ADR-004). Deactivation
  revokes the login at once and is *not* a removal: the row stays because
  tickets/history reference it, so the address cannot simply be handed to a new
  row. Instead of a dead end, re-provisioning that address re-writes **that**
  account (name, role, password, active) and keeps its id, which is what keeps
  every historical reference pointing at the same person. While the row is
  **active**, `POST /users` still refuses the address (`409`) — somebody has
  access with it, so it is never taken over silently; deactivate it first. The
  Users tab lists deactivated rows (badge + **Reactivate**/**Deactivate**
  controls, `GET /users?includeInactive=true`), and only active agents are ever
  offered as ticket assignees. Reactivation clears any pending reset link;
  deactivating is guarded exactly like deletion: your own account (400), and — as
  in every path that could empty the Admin seat — the guard-rails above.
* **The same guard-rails cover role changes** (`PATCH /users/:id/role`), because
  a demotion can empty the Admin seat just as effectively as a delete: an Admin
  cannot change **their own Admin role** (400), and the **last active Admin**
  cannot be demoted (400). Promoting somebody to Admin, and any change that
  leaves an active Admin in place, is allowed.
* Tickets are **never hard-deleted while they are live**: `Cancelled` is a
  terminal, fully audited status (ADR-003), and `Open` / `In Progress` tickets
  cannot be deleted either. The single exception is [ADR-010](decisions/ADR-010.md):
  an Admin may **permanently delete a `Resolved` ticket** (row + history, in one
  transaction) from the Users-facing Admin view — it is the one action that leaves
  no trace in the database, so it is confirmed explicitly in the UI and written to
  the server log. A `Cancelled` ticket is refused by that endpoint (`409`).

## Credentials and data

* Passwords are bcrypt-hashed (`bcryptjs`, cost 10) and never returned by the API
  (`@Exclude()` on `passwordHash` plus a global serializer).
* Login failures are generic (`401 Invalid credentials.`) for both a wrong email
  and a wrong password, so the endpoint cannot be used to enumerate accounts.
* The request contract is closed: the global `ValidationPipe` rejects unknown
  fields (`forbidNonWhitelisted`). That covers request **bodies**; `GET /tickets`
  reads its query from a plain object, so unknown query parameters there are
  ignored rather than rejected.

## Password reset and change (ADR-005, ADR-007, ADR-008, ADR-009)

* **A password is never "retrieved".** bcrypt is one-way; the capability is to
  **reset** a password (forgot it) or **change** it (signed in).
* **Recovery is Admin-initiated (ADR-007/ADR-009).** An Admin mints a one-time
  link with `POST /users/:id/reset-password` and hands it over; the employee
  completes it at `POST /auth/reset-password`. For a **lone Admin who has locked
  themselves out**, the offline `scripts/reset-password.mjs` mints the same token
  straight into the database (run it with the backend stopped, so the API cannot
  overwrite the change).
* **The public, self-service path is off by default (ADR-009).**
  `POST /auth/forgot-password` answers `404 Cannot POST /auth/forgot-password`
  unless `PASSWORD_RESET_SELF_SERVICE=true`, so an unauthenticated caller cannot
  make the hub send mail at all. With the switch on, it mails a one-time link to
  the account's address and **always answers the same generic message** —
  registered or not, active or not — so it cannot be used to enumerate accounts;
  a per-address cooldown (`PASSWORD_RESET_COOLDOWN_SECONDS`, default 60 s) stops
  it being used to mail-bomb a victim: a repeat request inside the window gets the
  generic answer but mints and sends nothing.
* **Delivery never breaks recovery when that switch is on.** `MailService` tries
  the first configured transport that works — built-in SMTP (`SMTP_HOST`…), then
  the **backup SMTP server** (`SMTP_ALT_HOST`…, e.g. Gmail primary and Outlook
  backup), `MAIL_WEBHOOK_URL`, `RESEND_API_KEY` — and finally prints the message
  to the backend console, so a missing or misconfigured provider can never
  silently swallow a reset. Outside production the one-time token is additionally
  returned in the response (`PASSWORD_RESET_RETURN_TOKEN`; `NODE_ENV=production`
  always suppresses it).
* A reset token is `randomBytes(32)`. The database stores **only its SHA-256
  hash** (both reset fields are `@Exclude()`d and never appear in a response —
  pinned by a regression test in `backend/test/auth-password.spec.ts`, because a
  plain object spread used to defeat `@Exclude()` on the login, user-create and
  role-change responses)
  plus a **30-minute expiry** (`PASSWORD_RESET_TTL_MINUTES`).
* **Single use:** `POST /auth/reset-password` consumes the token; a second
  attempt with the same link is a generic `400`. Changing the password through
  *either* path clears any outstanding token, so an old link cannot outlive the
  change; issuing a new link invalidates the previous one.
* `POST /auth/change-password` requires the **current** password. A stolen
  session token alone cannot take the account over.
* **The Admin normally never sees or chooses the password.** Whether the link was
  emailed or hand-delivered, the employee sets their own — the Admin cannot read the
  password afterwards (bcrypt is one-way) and never types it.
* **Exception: an Admin may set a password directly** (`PATCH /users/:id/password`,
  [ADR-011](decisions/ADR-011.md)). This is the one action where an Admin knowingly
  handles a credential — it exists for the cases a link cannot cover (the person is
  present, the owner is unreachable, no mail provider). It is hashed like any other
  password, **clears any pending reset link**, is refused for a deactivated account
  (`400`), and is **logged** (`AdminPassword`: who set a password for whom). The
  Admin should hand it over out-of-band and tell the person to rotate it from the
  top bar, which still requires the current password.
* **Issuing a link is powerful, so it is authorized and logged.** A reset link is
  a credential: whoever holds it can set that account's password. Minting one is
  Admin-only (`403` otherwise) and the `AdminReset` logger records which Admin
  issued a link for which account and when; the endpoint refuses a deactivated
  account (`400`). The project has no user-action audit table (only tickets carry
  events), so the log is the trace. Treat the link like a password — anyone who
  can read the Admin's screen or the API response can use it until it expires.
* Reset links do **not** revoke already-issued JWTs. Session revocation
  (`passwordChangedAt`/token versioning) is a documented non-goal for the MVP, so
  set a short `JWT_EXPIRES_IN` and a strong `JWT_SECRET` in production.

## Test fixtures are not an application feature

The automated suites need accounts to drive the UI. They create them through the
**same Admin API** a human would use (`e2e/global-setup.ts`,
`scripts/verify-slice.mjs`). Those fixture credentials (`rana.khoury@…`,
`karim.haddad@…`, …) exist only inside the test harnesses and are never seeded
by the application.
