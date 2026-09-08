# Eurisko Hub — E2E verification

Two harnesses prove the **"assigned agent resolves a ticket"** slice end to end
against the *live* stack (React app → NestJS → SQLite):

| Harness | What it drives | When to use |
|---|---|---|
| `npx vitest run` (`npm run test:ui`) | The **real React components** (`../frontend/src`) in jsdom, with fetch proxied to the live backend on `:3000` | Everywhere — no browser needed (default) |
| `npm run e2e:browser` | A **real Chromium** browser clicking through `http://localhost:5173` (needs a Chrome binary, see below) | When a browser is available — full fidelity + screenshots |

## Prerequisites (both)

```bash
cd ../backend && npm install && npm run build
DB_FILE="$PWD/.data/hub.sqlite" npm start &     # :3000, persistent DB
cd ../frontend && npm install && npm run dev &  # :5173 (proxies /api -> :3000)

# once per fresh DB: provision demo personas + a resolved sample ticket
cd .. && node scripts/verify-slice.mjs full
```

## DOM-level UI test (recommended default)

```bash
cd e2e
npm install
npx vitest run          # or: npm run test:ui
```

Runs `dom/resolve-slice.ui.test.tsx`: Alice opens a ticket → Bob claims it →
empty resolution note is rejected (backend 400 rendered in the form) → Bob
resolves it with a note → the ticket moves to the "Resolved by me" section
with the note → Alice's "My tickets" shows Resolved + note. DOM snapshots are
written to `../artifacts/dom/`.

## Browser E2E (optional)

```bash
cd e2e
npm install
# provide a Chromium-family binary, then:
CHROME_PATH=/path/to/chrome npm run e2e:browser
```

The sandbox this project was built in cannot download Playwright's Chromium
(the Microsoft CDN is unreachable) and has no system Chrome, so this script
also accepts a `chrome-headless-shell` binary downloaded from
`storage.googleapis.com/chrome-for-testing-public` (Chrome for Testing) —
e.g. `e2e/.browsers/chrome-headless-shell-linux64/chrome-headless-shell`.
Screenshots land in `../artifacts/e2e/`.
