# Eurisko Hub — E2E verification

Two harnesses prove the Service Request slice end to end against the *live*
stack (React app → NestJS → SQLite):

| Harness | What it drives | When to use |
|---|---|---|
| `npx vitest run` (`npm run test:ui`) | The **real React components** (`../frontend/src`) in jsdom, with fetch proxied to a live backend | Everywhere — no browser needed (fast feedback) |
| `node scripts/run-browser-e2e.mjs` | A **real Chromium** (Playwright) against a self-started backend + Vite, with screenshots | The primary E2E — full fidelity; self-installing |

Both run inside `node scripts/run-tests.mjs`.

## DOM-level tests

Only a running backend is needed — the Vitest global setup fetches the demo
accounts from the backend and provisions any that are missing.

```bash
cd ../backend && npm install && npm run build
DB_FILE="$PWD/.data/e2e.sqlite" npm start        # :3000

cd ../e2e && npm install
npx vitest run                                   # or: npm run test:ui
```

Point at a different API with `API_URL=http://127.0.0.1:3100 npm run test:ui`.
The suite contains four tests:

* `dom/resolve-slice.ui.test.tsx` — Rana opens a ticket → Karim claims it →
  empty resolution note is rejected (backend 400 rendered in the form) → Karim
  resolves it with a note → the ticket moves to the "Resolved by me" section →
  Rana's "My tickets" shows Resolved + note. DOM snapshots go to
  `../artifacts/dom/`.
* `dom/demo-signin.ui.test.tsx` — the login card's **Quick sign-in** panel: one
  click opens the Employee account, then **Switch account** → one click opens
  the Admin account.
* `dom/admin-override.ui.test.tsx` — ADR-002: resolving a ticket assigned to an
  agent demands an **override reason** plus the resolution note, and the row
  names the real resolver.
* `dom/admin-actions.ui.test.tsx` — ADR-003: the Admin **assigns** an unclaimed
  ticket to a matching agent and **soft-cancels** a duplicate.

## Browser E2E (primary, self-contained)

```bash
node ../scripts/run-browser-e2e.mjs
```

It starts its own backend (fresh DB, auto-seeded demo accounts) and Vite dev
server pointed at it, makes sure a Chromium can launch, drives the real UI, then
tears everything down. Browser resolution order:

1. `CHROME_PATH` if set;
2. a repo-local `e2e/.browsers/chrome-headless-shell-linux64/chrome-headless-shell`;
3. `npx playwright install chromium` (5-minute cap).

If none can launch (for example the machine lacks `libnss3`/`libasound2`), the
run **skips** with a clear message and exits 0. Set `STRICT_BROWSER_E2E=1` to
fail instead. Install the system deps with `npx playwright install-deps` where
possible. Screenshots land in `../artifacts/e2e/`.
