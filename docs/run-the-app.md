# Run it - the five-minute checklist

For a clean checkout. The full reference is the top-level [`README.md`](../README.md);
the design documents start at [`docs/README.md`](README.md).

Every command below is run from the repository root.

## 1. Install - nothing to do

On a fresh checkout, `npm run dev` (step 2) installs what is missing by itself:
`backend/` and `frontend/` with `npm ci`, so both match the committed lockfiles
exactly. The only prerequisite is:

- Node.js **20.19+** (22 LTS recommended) with npm. The run command checks this
  before starting and names the version to install if it does not match
  ([`.nvmrc`](../.nvmrc) pins 22, so `nvm use` selects it).
- No database server, no Docker, no cloud account. The API writes a local SQLite
  file, and creates its folder itself.

To install ahead of time - on a slow connection, or to run the layers below by
hand - use `npm ci`, which installs exactly what `package-lock.json` pins and
never rewrites it:

```bash
(cd backend  && npm ci)
(cd frontend && npm ci)
(cd e2e      && npm ci)   # only needed for the automated UI tests
```

## 2. Run

```bash
npm run dev
```

Wait for the banner, which prints both addresses:

```text
────────────────────────────────────────────────────────────────
  API   http://127.0.0.1:3000
  Web   http://127.0.0.1:5173
────────────────────────────────────────────────────────────────
```

Open <http://localhost:5173>. **Ctrl+C stops both processes.**

The script compiles the backend when `dist/` is missing or stale, so there is no
separate build step and nothing to create by hand. If a port is taken, move the
API and the client follows automatically:

```bash
PORT=3001 node scripts/dev.mjs
```

### If you would rather use two terminals

These two commands do not install anything, so run the `npm ci` pair from step 1
first (only `npm run dev` installs for you).

```bash
# terminal A - the API
cd backend
npm run build
npm start                     # wait for: Eurisko Hub API listening on http://localhost:3000

# terminal B - the web client
cd frontend
npm run dev                   # then open http://localhost:5173
```

Start the API first: the client proxies `/api` to it, and signing in before it is
up fails with `Request failed with status 500`.

## 3. Sign in and create accounts

| Account | Email | Password |
|---|---|---|
| Admin (seeded on first boot) | `admin@eurisko.com` | `Admin123!` |

There is **no public registration** (ADR-004). Sign in as the Admin, open
**👥 Users → Create account**, and add the people you want to test with - for
example an **Employee**, an **IT Agent**, an **HR Agent** and a **Maintenance
Agent**. Any real email address is accepted for the accounts you create.

## 4. Prove it works

| What you want to check | Command | Servers running? |
|---|---|---|
| Everything, one command | `node scripts/run-tests.mjs` | No - it starts and stops its own |
| Backend suites (103 tests) | `cd backend && npm test` | No |
| Live HTTP definition of done (28 checks) | `node scripts/verify-slice.mjs full` | Yes |
| AI intake (11 checks) | `node scripts/verify-ai-intake.mjs` | Yes |
| UI end-to-end (5 flows) | `cd e2e && npm run test:ui` | Yes |
| Real browser (Playwright) | `node scripts/run-browser-e2e.mjs` | No - needs Chromium |

Tickets survive a restart because `backend/.env` sets `DB_FILE`. With no `.env`
the database is in memory, which is what the test suites use.

## 5. Optional: real AI answers

**AI Suggest works with nothing configured** - it fills the form from the built-in
keyword classifier and labels the result **"Suggested (offline)"**, so a
rules-based answer is never passed off as the model's.

For answers from a real model, copy the template and add a free key:

```bash
cp backend/.env.example backend/.env
# then set AI_API_KEY=... (free key: https://console.groq.com/keys)
```

Restart the API. The tag on the form changes to **"AI suggested"**. A local model
needs no key at all: `AI_PROVIDER_URL=http://localhost:11434/v1 AI_MODEL=llama3.2`.

If the provider is down, rate-limited, or the key is wrong, the app does not
break - it falls back to the labelled offline suggestion and reports why.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Request failed with status 500` on sign-in | The API is not running. Start it and wait for `Eurisko Hub API listening on ...` |
| `Unable to connect to the database. Retrying...` | `DB_FILE` points at a folder the process cannot create. Point it somewhere writable, or unset it for an in-memory database |
| Port already in use | `PORT=3001 node scripts/dev.mjs`, or stop whatever holds the port |
| The AI tag says **Suggested (offline)** | No key, or the provider is unreachable. See step 5 |
| Cannot sign in after changing `ADMIN_EMAIL` | The Admin is seeded once. An existing Admin is never replaced; start over with an empty `backend/.data/` |

More, including password recovery and the offline break-glass, is in the
[top-level README](../README.md#troubleshooting).
