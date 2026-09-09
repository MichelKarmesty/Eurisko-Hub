# Eurisko Hub — Web client (React + Vite)

The React front end of the Internal Operations Service Hub. It implements the
**first real slice** end-to-end:

> An assigned Support Agent updates a Ticket's status to **Resolved**
> (React action → `PATCH /tickets/:id/status` → SQLite → React result).

It follows the architecture in [`../docs/architecture.md`](../docs/architecture.md):
the client only presents data and triggers actions — every authorization and
product rule (department scoping, `Open → In Progress → Resolved`, note
required to resolve) is enforced by the NestJS backend in `../backend/`.

## Run it

1. Start the backend **with a persistent database file** (so state survives
   restarts):

   ```bash
   cd ../backend
   npm install && npm run build
   DB_FILE="$PWD/.data/hub.sqlite" npm start     # http://localhost:3000
   ```

2. In another terminal, start this client (Vite proxies `/api` → :3000):

   ```bash
   cd frontend
   npm install
   npm run dev                                   # http://localhost:5173
   ```

3. On a fresh database, provision the demo personas once (Admin-only
   endpoint, see [`../scripts/verify-slice.mjs`](../scripts/verify-slice.mjs)):

   ```bash
   cd ..
   node scripts/verify-slice.mjs full
   ```

   This creates Alice (Requester), Bob & Dave (IT Agents), opens an IT ticket
   and leaves it **Resolved** — the persisted demo state. Then log in through
   the login screen with the provisioned demo accounts
   (`admin@eurisko.local` / `Admin123!`, `alice@corp.com` / `password123`,
   `bob@corp.com` / `password123`).

## The slice in the UI

| Role | Screen | Action |
|---|---|---|
| Requester (`Employee`) | `RequesterView` | opens a ticket, watches its status (cannot change it — RBAC) |
| Support Agent | `AgentView` | claims from the department queue (→ `In Progress`), then **resolves** with a note |
| Admin | `AdminView` | every ticket + stats; may also advance the lifecycle |

The "React action" lives in
[`src/components/ResolveControl.tsx`](src/components/ResolveControl.tsx): it
submits `PATCH /tickets/:id/status` with
`{ "status": "Resolved", "resolutionNote": "…" }`. When the backend answers,
the returned ticket replaces the old one in local state, so the ticket moves
from the *In Progress* section to the *Resolved* section and the note appears
immediately. An empty note surfaces the backend's `400` right in the form.

## Layout

```
vite.config.ts       dev proxy: /api -> http://localhost:3000
src/
  api.ts             typed fetch client (auth + tickets + stats)
  types.ts           domain vocabulary mirrored from backend/src/common/domain.ts
  App.tsx            session handling + role-based view routing
  components/
    AuthScreen.tsx        login (accounts are provisioned by an Admin)
    RequesterView.tsx     open a ticket + my tickets (React result)
    AgentView.tsx         queue -> claim -> resolve (the slice flow)
    AdminView.tsx         global list + stats
    ResolveControl.tsx    the slice's React action (PATCH status)
    TicketTable.tsx       shared table with per-row action cell
    ui.tsx                StatusBadge / Notice / Spinner
```

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + vite build (dist/)
```
