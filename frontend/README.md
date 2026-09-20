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
   mkdir -p .data                                # DB_FILE's folder (absent in a fresh clone)
   npm install && npm run build
   DB_FILE="$PWD/.data/hub.sqlite" npm start     # http://localhost:3000
   ```

   Wait until it prints `Eurisko Hub API listening on http://localhost:3000`
   before starting the client below — `npm run build` compiles the backend but
   does **not** start it, and a client that cannot reach the API fails sign-in
   with `Request failed with status 500`.

2. In another terminal, start this client (Vite proxies `/api` → :3000):

   ```bash
   cd frontend
   npm install
   npm run dev                                   # http://localhost:5173
   ```

3. On a **fresh** database the backend seeds exactly **one** account — the Admin
   (`admin@eurisko.com` / `Admin123!`, override via `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`). Sign in with it and create everyone else from the
   **👥 Users** tab. There is **no public registration** and no demo data
   (ADR-004): the login screen is a plain sign-in form — no self-service recovery
   and no reset-token box; only an Admin can issue a reset link (ADR-007/ADR-009).
   Accounts accept **any real email address** — Gmail, Hotmail/Outlook, Yahoo or
   a company domain; `@eurisko.com` is only the development default.

   To also run the live HTTP definition-of-done checks (they provision their own
   test accounts through the Admin API), with the backend running:

   ```bash
   cd ..
   node scripts/verify-slice.mjs full
   ```

## The slice in the UI

| Role | Screen | Action |
|---|---|---|
| Requester (`Employee`) | `RequesterView` | describes the problem and presses **AI Suggest** (v0.4), opens a ticket, watches its status (cannot change it — RBAC) |
| Support Agent | `AgentView` | claims from the department queue (→ `In Progress`), then **resolves** with a note |
| Admin | `AdminView` | every ticket + stats + user management; **assigns** unclaimed tickets, **cancels** requests softly, **deletes a `Resolved` ticket** outright (ADR-010, with an explicit warning), or resolves as a recorded **override** |

**AI Suggest (v0.4).** The free-text box + button call
`POST /tickets/ai-suggest` and pre-fill Title, Category and Priority, each tagged
**AI suggested**; the tag and highlight clear as soon as the field is edited.
Nothing is auto-submitted and `Open ticket` still calls the unchanged
`POST /tickets`. When no model answers, the built-in **offline keyword classifier**
still pre-fills the fields, tagged **“Suggested (offline)”** instead of “AI
suggested”, so a rules-based answer is never passed off as the model's — unless
`AI_OFFLINE_FALLBACK=false`, in which case the form shows a non-blocking notice
and is filled in by hand. Full detail:
[`../docs/week4-production-ai.md`](../docs/week4-production-ai.md).

**Password recovery (v0.5, revised by ADR-007/ADR-008/ADR-009).** Recovery is
**Admin-initiated**: there is no "forgot password" on the sign-in screen. An Admin
mints a one-time link from **Users → Reset password**
(`POST /users/:id/reset-password`) and hands it over; the link opens the reset
form (`POST /auth/reset-password`) via `?resetToken=…` in the address bar; there is
no token box on the sign-in screen, so the link is the only way in. A signed-in
user can rotate their password from **Change password** in the top bar
(`POST /auth/change-password`, current password required). The public, emailed
variant still exists in the backend but is off by default
(`PASSWORD_RESET_SELF_SERVICE=true`), which is why the screen offers no link to
it. Design records:
[`../docs/decisions/ADR-007.md`](../docs/decisions/ADR-007.md) and
[`../docs/decisions/ADR-009.md`](../docs/decisions/ADR-009.md).

The "React action" lives in
[`src/components/ResolveControl.tsx`](src/components/ResolveControl.tsx): it
submits `PATCH /tickets/:id/status` with
`{ "status": "Resolved", "resolutionNote": "…" }`. When the backend answers,
the returned ticket replaces the old one in local state, so the ticket moves
from the *In Progress* section to the *Resolved* section and the note appears
immediately. An empty note surfaces the backend's `400` right in the form. The
Admin variant additionally requires an **override reason** and shows the real
resolver in the table.

## Layout

```
vite.config.ts       dev proxy: /api -> http://localhost:3000 (API_PROXY_TARGET overrides)
src/
  api.ts             typed fetch client (auth + password recovery/change + tickets + admin actions + stats)
  types.ts           domain vocabulary mirrored from backend/src/common/domain.ts
  App.tsx            session handling + role-based view routing + change-password dialog
  components/
    AuthScreen.tsx        sign-in + reset-token mode (no registration, no demo accounts)
    ChangePasswordDialog.tsx  signed-in "change my password" modal (current password required)
    RequesterView.tsx     open a ticket (with the v0.4 AI Suggest flow) + my tickets (React result)
    AgentView.tsx         queue -> claim -> resolve (the slice flow)
    AdminView.tsx         global list + stats + users + assign/cancel/delete-resolved controls
    ResolveControl.tsx    the slice's React action (PATCH status; override reason)
    TicketTable.tsx       shared table with per-row action cell + history
    ui.tsx                StatusBadge / Notice / Spinner
```

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + vite build (dist/)
```
