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

### Show it to another PC on the same network

The dev server answers only this machine unless you ask otherwise. For a demo or a
review from someone else's PC, add `LAN=1`:

```bash
LAN=1 npm run dev
```

The banner then prints the address to give them:

```text
  Open it from another PC on this network:
        http://192.168.1.42:5173
```

The web client and its `/api` proxy both answer on that address. Use
`DEV_HOST=192.168.1.50` instead of `LAN=1` to bind one specific interface. If the
other PC cannot connect, a host firewall is the usual cause.

> **This is dev-mode sharing, not a deployment.** Anyone who can reach that
> address can sign in, the seeded Admin password (`Admin123!`) is published in
> this repository, and dev mode has no HTTPS. Change the Admin password (or set
> `ADMIN_PASSWORD`) first, and only share on a network you trust. Note also that
> the API listens on every interface whenever it runs - that is NestJS's default
> and is unchanged by that switch - so on a shared network the API port answers
> too, not just the web client.

### Put it on a public URL (required for the capstone submission)

The submission requires a URL the grader can open **from outside your network**. The
free, no-account way is a quick tunnel in front of the dev server:

```bash
# terminal A — bind the web client to every interface (and allow the tunnel's Host)
LAN=1 npm run dev

# terminal B — a free public HTTPS URL, no account or card required
npx cloudflared tunnel --url http://localhost:5173
```

`cloudflared` prints a `https://<random>.trycloudflare.com` address. That is the link to
submit and the link to open on a phone hotspot. One tunnel is enough: the client's `/api`
calls are proxied by Vite to the API on the same machine, so the API needs no tunnel of
its own.

`LAN=1` is not optional here. A tunnel forwards the request with its own hostname in the
`Host` header, and Vite's DNS-rebinding protection rejects unknown hosts unless `DEV_HOST`
is set — which is exactly what `LAN=1` does.

Before you send the URL:

- [ ] `DB_FILE` is set (copy `.env.example` to `.env`, or rely on `npm run dev`, which
      defaults to `backend/.data/hub.sqlite`). With no `DB_FILE` the app runs **in memory**
      and every restart erases the demo data.
- [ ] `ADMIN_PASSWORD` is changed from `Admin123!` and `JWT_SECRET` is a long random value
      (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).
- [ ] The URL opens in a private window **and** on a phone hotspot, and the sign-in page loads.
- [ ] The API answers through the tunnel:
      `curl -s -o /dev/null -w '%{http_code}\n' <URL>/api/health` → `200`.
- [ ] Both terminals stay open for the whole defense. A sleeping laptop kills the tunnel,
      which is the most common way a live demo dies mid-sentence.

If `cloudflared` is unavailable, any equivalent tunnel works — for example
`ssh -R 80:localhost:5173 nokey@localhost.run`. The requirement is only that the web client
is reachable over HTTPS from outside your network.

> **A tunnel is for the defense window, not for production.** The seeded Admin password is
> published in this repository, dev mode has no rate limiting, and the SQLite file lives on
> your laptop. This is the documented capstone deployment, not how you would run the tool
> for a real company.

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
