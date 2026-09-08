# Internal Operations Service Hub

## What this is
Eurisko Hub gives employees one place to ask for help from IT, HR, or Maintenance. Instead of chasing requests through WhatsApp messages and scattered emails, people can submit a ticket, follow its progress, and see how it was resolved.

## Why this repository exists
This is the Week 1 Product Foundation for the Eurisko Academy Program. It captures what we are building, how the system will fit together, and what data it needs before implementation starts.

## What you need
For now, a text editor, Markdown viewer, or browser is enough. There is no runtime environment or dependency setup yet.

## Get the project
Clone the repository:

```bash
git clone https://github.com/MichelKarmesty/Eurisko-Hub.git
```

## Install dependencies
There are no dependencies to install yet. This milestone is about agreeing on the product and its design, not running an application.

## Run the project
There is no app to launch yet. At this point, the repository is the product and system plan.

## Open the docs
No local URL is available yet. Read the files directly on GitHub or in VS Code.

## Roles and access
The first version is built around five roles:
- Requester
- IT_Agent
- HR_Agent
- Maintenance_Agent
- Admin

## Documentation structure
Start in the `docs/` folder and read the documents in this order:
- [docs/product-spec.md](docs/product-spec.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/data-model.md](docs/data-model.md)
- [docs/decisions/ADR-001.md](docs/decisions/ADR-001.md)
- [docs/api.md](docs/api.md)

## Backend implementation
The NestJS backend that implements this design lives in [`backend/`](backend/)
(auth, RBAC user management, tickets with claim/status flow, and durable
ticket history). See [backend/README.md](backend/README.md) to run it.

## Frontend implementation
The React web client that drives the MVP flows lives in [`frontend/`](frontend/).
It ships the first real slice end-to-end — an assigned Support Agent resolves
a ticket (`React action → PATCH /tickets/:id/status → SQLite → React result`).
See [frontend/README.md](frontend/README.md) and
[`scripts/verify-slice.mjs`](scripts/verify-slice.mjs) to run and verify it.

## What is not here yet
Database migrations and deployment configuration are not in this repository
yet. Local runs persist to a SQLite file via the `DB_FILE` env var; a
production database (e.g. PostgreSQL) can be swapped into the TypeORM config
in `backend/src/app.module.ts`.

## Current status
The product foundation, architecture draft, data model, and first ADR are in
`docs/`, a working NestJS API (see `docs/api.md`) implements the core MVP
workflow (open a ticket, claim it from the department queue, resolve it with
a note, review it from the admin dashboard), and the React client in
`frontend/` wires that workflow end-to-end for the "agent resolves a ticket"
slice — with durable SQLite persistence across restarts.