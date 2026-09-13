# Security Notes

This project is an internal MVP. Two development conveniences deserve to be
called out explicitly, because they must **never** reach a production
deployment.

## Demo accounts and the dev-only seeding

On an **empty** database the backend seeds, for convenience:

| Account | Email | Password |
|---|---|---|
| Admin | `rami.fares@eurisko.com` (or `ADMIN_EMAIL`) | `Admin123!` (or `ADMIN_PASSWORD`) |
| Employee | `rana.khoury@eurisko.com` | `password123` |
| IT Agent | `karim.haddad@eurisko.com` | `password123` |
| IT Agent | `nadim.saad@eurisko.com` | `password123` |
| HR Agent | `layla.nassar@eurisko.com` | `password123` |
| Maintenance Agent | `elias.aoun@eurisko.com` | `password123` |

These are **well-known credentials**. The seeding is gated:

* it **never runs when `NODE_ENV=production`**;
* it can be switched off in any environment with **`SEED_DEMO_DATA=false`**;
* it only runs on a database with **zero users**, so it never modifies an
  existing deployment;
* the list lives in one place, `backend/src/common/demo-accounts.ts`, and a
  startup **warning** is logged whenever demo accounts are created.

Recommended for any real environment: set `SEED_DEMO_DATA=false`, set a strong
`ADMIN_PASSWORD`, and set a real `JWT_SECRET` (the default is a development
value).

## `GET /demo/accounts` (dev-only discovery)

The login card, `scripts/verify-slice.mjs` and the E2E harnesses read the demo
account list from this endpoint so that it exists in exactly one place. To keep
it harmless:

* it returns `{ "accounts": [] }` whenever demo seeding is disabled
  (`NODE_ENV=production` or `SEED_DEMO_DATA=false`);
* the **Admin password is withheld** (`null`) if `ADMIN_PASSWORD` was overridden,
  so a real secret is never echoed over HTTP;
* the demo persona passwords it does return are the same ones already printed on
  the login screen — they are not secrets.

## Authorization model

All rules are enforced at the API boundary, never in the client:

* **Employees** see only their own tickets.
* **Agents** see/claim only their own department, and may only resolve tickets
  assigned to them.
* **Admins** see everything and manage users. They can change any ticket, but an
  action on a ticket they are not assigned to is an **override** that requires a
  recorded reason (ADR-002). They can **assign** unclaimed tickets and **cancel**
  (soft) requests, but tickets are **never hard-deleted** (ADR-003).
* Passwords are bcrypt-hashed and never returned by the API
  (`@Exclude` + a global serializer).
