# Internal Operations Service Hub

Eurisko Hub gives employees one place to ask for help from IT, HR, or
Maintenance. Instead of chasing requests through WhatsApp messages and
scattered emails, people can submit a ticket, follow its progress, and see how
it was resolved.

## Repository layout

| Folder | What it is |
|---|---|
| [`backend/`](backend/) | NestJS + TypeORM API (auth, RBAC, tickets with claim/status flow, durable history) |
| [`frontend/`](frontend/) | React + Vite web client (requester dashboard, agent queue, admin view) |
| [`docs/`](docs/) | Product spec, architecture, data model, ADR, API reference |
| [`scripts/`](scripts/) | [`verify-slice.mjs`](scripts/verify-slice.mjs) — end-to-end Definition-of-Done checks |
| [`e2e/`](e2e/) | UI-level end-to-end tests for the ticket lifecycle |

## Requirements

- **Node.js 20.19+** (Node 22 LTS recommended) with npm
- No database server needed — the API persists to a local SQLite file

## Run the full app (quick start)

**1. Backend API** (http://localhost:3000)

```bash
cd backend
npm install
npm run build
DB_FILE="$PWD/.data/hub.sqlite" npm start
```

First boot seeds an Admin account: `admin@eurisko.local` / `Admin123!`
(override with `ADMIN_EMAIL` / `ADMIN_PASSWORD`). Set `DB_FILE` so tickets
survive restarts (without it, the database is in-memory).

**2. Web client** (http://localhost:5173)

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` to the backend on port 3000.

**3. Log in**

Open http://localhost:5173 and log in with `admin@eurisko.local` /
`Admin123!`. New employee/agent accounts are created by an Admin (Users tab)
or provisioned from the CLI. To provision demo accounts
(requester + IT agents) and run the full end-to-end verification once:

```bash
node scripts/verify-slice.mjs full     # from the repo root, backend running
node scripts/verify-slice.mjs persist  # restart-proof persistence check
```

## Development workflow

Frontend edits hot-reload via Vite (port 5173); backend edits auto-restart via
`npm run start:dev` in `backend/` (port 3000). Details in
[`backend/README.md`](backend/README.md) and
[`frontend/README.md`](frontend/README.md).

## Roles and access

The first version is built around five roles:
- Requester (Employee)
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

## Current status

A working NestJS API (see `docs/api.md`) implements the core MVP workflow —
open a ticket, claim it from the department queue, resolve it with a note,
review it from the admin dashboard — and the React client in `frontend/` wires
that workflow end-to-end for the "assigned agent resolves a ticket" slice,
with durable SQLite persistence across restarts.
