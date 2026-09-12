# Eurisko Hub — E2E verification

Two harnesses prove the **"assigned agent resolves a ticket"** slice end to end
against the *live* stack (React app → NestJS → SQLite):

| Harness | What it drives | When to use |
|---|---|---|
| `npx vitest run` (`npm run test:ui`) | The **real React components** (`../frontend/src`) in jsdom, with fetch proxied to the live backend on `:3000` | Everywhere — no browser needed (default) |
| `npm run e2e:browser` | A **real Chromium** browser clicking through `http://localhost:5173` (needs a Chrome binary, see below) | When a browser is available — full fidelity + screenshots |

## Prerequisites

**DOM-level test (default):** only a running backend is needed — the Vitest
global setup provisions the demo personas itself.

```bash
cd ../backend && npm install && npm run build
DB_FILE="$PWD/.data/e2e.sqlite" npm start        # :3000, persistent DB
```

**Browser test (optional):** also start the frontend dev server and provision
the demo personas once (the Playwright script does not use the Vitest setup):

```bash
cd ../frontend && npm install && npm run dev &   # :5173 (proxies /api -> :3000)
cd .. && node scripts/verify-slice.mjs full      # demo personas + sample data
```

Or run every automated layer at once from the repository root:
`node scripts/run-tests.mjs`.

## DOM-level UI test (recommended default)

```bash
cd e2e
npm install
npx vitest run          # or: npm run test:ui
```

Point at a different API with `API_URL=http://127.0.0.1:3100 npm run test:ui`.

A **Vitest global setup** (`global-setup.ts`) runs first: it waits for the API
and provisions the demo personas through the real Admin API, so a freshly
started backend (only the seeded admin exists) is enough — no manual
`verify-slice` run is required. If the API is unreachable it fails immediately
with the exact command to start it.

The suite contains two tests:

* `dom/resolve-slice.ui.test.tsx` — Rana opens a ticket → Karim claims it →
  empty resolution note is rejected (backend 400 rendered in the form) → Karim
  resolves it with a note → the ticket moves to the "Resolved by me" section
  with the note → Rana's "My tickets" shows Resolved + note. DOM snapshots are
  written to `../artifacts/dom/`.
* `dom/demo-signin.ui.test.tsx` — the login card's **Quick sign-in** panel: one
  click opens the Employee account, then **Switch account** → one click opens
  the Admin account.

## Browser E2E (optional)

```bash
cd e2e
npm install
# provide a Chromium-family binary, then:
CHROME_PATH=/path/to/chrome npm run e2e:browser
```

If the Playwright CDN is unreachable from your network (so `npx playwright
install chromium` cannot download a browser), this script also accepts a
`chrome-headless-shell` binary downloaded from
`storage.googleapis.com/chrome-for-testing-public` (Chrome for Testing) —
e.g. `e2e/.browsers/chrome-headless-shell-linux64/chrome-headless-shell`.
Screenshots land in `../artifacts/e2e/`.
