# Deploying Eurisko Hub

Everything needed to put the app on a public HTTPS URL, so the capstone brief's
"live app must remain reachable through the entire defense" can actually be met
rather than approximated with a tunnel on a laptop.

## What gets deployed

**One container, one command.** `deploy/server.mjs` supervises the compiled
NestJS API as a child process and serves the built React app on the public port,
proxying `/api/*` to the API with the prefix stripped:

| Request | Served by |
| --- | --- |
| `GET /` and any client-side route | `frontend/dist/index.html` (SPA fallback) |
| `GET /assets/*` | hashed static assets, `immutable` cache |
| `ANY /api/*` | the NestJS API (the `/api` prefix is stripped) |
| `GET /api/health` | the API readiness route - use it as the platform health check |

This keeps the production URL shaped exactly like `npm run dev`, so
`frontend/src/api.ts` keeps using its relative `/api` base and nothing in the
client needs a hardcoded host or CORS.

### Files that make it work

| File | Purpose |
| --- | --- |
| `Dockerfile` | multi-stage build: API, then web client, then a slim runtime |
| `.dockerignore` | keeps `node_modules`, `dist`, the SQLite file and **`.env` secrets** out of the image |
| `deploy/server.mjs` | the single process the container runs |
| `render.yaml` | a ready-made Render blueprint (Option A) |

## Required environment variables

The API **refuses to start** in production without `JWT_SECRET` and
`APP_BASE_URL`, so set these before the first deploy.

| Variable | Required | Value |
| --- | --- | --- |
| `JWT_SECRET` | yes | long random string. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_BASE_URL` | yes | the public URL of the deployed app |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | the seeded Admin. **Change the password from `Admin123!`** |
| `DB_FILE` | strongly recommended | a path **on the persistent volume**, e.g. `/data/hub.sqlite`. Without it the app runs in memory and every restart erases the data |
| `TYPEORM_SYNCHRONIZE` | yes | `true`. This project ships no migrations, so the tables are created on first boot |
| `NODE_ENV` | yes | `production` |
| `AI_ENABLED` | no | defaults on; the shared demo proxy needs no key |
| `AI_PROVIDER_URL` / `AI_MODEL` | no | only if you use your own provider |

## Option A - Render (blueprint included)

1. Push the repository.
2. Render dashboard: **New → Blueprint**, pick the repo. Render reads
   `render.yaml`, builds the `Dockerfile`, and creates a disk at `/data`.
3. Fill the `sync: false` values: `APP_BASE_URL` (the `https://…onrender.com`
   URL Render assigns) and `ADMIN_PASSWORD`.
4. Deploy, then verify (see *Verify the deployment* below).

**Read the plan note in `render.yaml`.** Free instance types on Render spin down
after roughly 15 minutes of inactivity and cannot mount a disk. Both facts
independently break the brief's requirements - a URL that may be asleep when the
grader clicks it, and a database that empties on every restart. Use a paid
instance type for anything you submit.

## Option B - Railway

1. **New Project → Deploy from GitHub repo.** Railway detects the `Dockerfile`.
2. Add a **Volume** mounted at `/data`.
3. Set the environment variables from the table above.
4. In the service settings, confirm the app is **not** configured to sleep
   between requests, and set the health check path to `/api/health`.

## Option C - Fly.io

```bash
fly launch --no-deploy          # accept the Dockerfile it finds
fly volumes create eurisko_data --size 1
# set secrets
fly secrets set \
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  ADMIN_PASSWORD='change-me-please' \
  APP_BASE_URL='https://<your-app>.fly.dev' \
  DB_FILE=/data/hub.sqlite \
  TYPEORM_SYNCHRONIZE=true \
  NODE_ENV=production \
  PORT=8080 \
  API_PORT=3000
fly deploy
```

Add the volume mount to `fly.toml`, and **disable auto-stop** so the app is
always warm for the defense:

```toml
[mounts]
  source = "eurisko_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

## Option D - any Docker host, or a local check

```bash
docker build -t eurisko-hub .

docker run --rm -p 8080:8080 \
  -e NODE_ENV=production \
  -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  -e APP_BASE_URL=http://localhost:8080 \
  -e ADMIN_EMAIL=admin@eurisko.com \
  -e ADMIN_PASSWORD='change-me-please' \
  -e DB_FILE=/data/hub.sqlite \
  -e TYPEORM_SYNCHRONIZE=true \
  -v eurisko-data:/data \
  eurisko-hub
```

`-v eurisko-data:/data` is what makes the data survive `docker run` again; drop
it only if you are happy to start from an empty database each time.

## Verify the deployment

Run these against the real URL before you put it in the submission email. The
first one is the exact check `render.yaml` uses as a health check.

```bash
LIVE=https://your-app.example

curl -s -o /dev/null -w 'health   %{http_code}\n' "$LIVE/api/health"
curl -s -o /dev/null -w 'web root %{http_code}\n' "$LIVE/"
curl -s -X POST "$LIVE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"admin@eurisko.com","password":"<your ADMIN_PASSWORD>"}' \
  -o /dev/null -w 'login    %{http_code}\n'
```

Then point the repository's own tooling at it - this is the same gate the
defense rehearsal uses:

```bash
node scripts/final-smoke.mjs --api "$LIVE/api"
node scripts/pre-defense.mjs --sha "$(git rev-parse HEAD)" --live "$LIVE"
```

`final-smoke.mjs --api "$LIVE/api"` is the end-to-end proof that the deployed
instance really works, not just that it answers a ping.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Container exits immediately, log says *Missing required production environment variable(s)* | `JWT_SECRET` or `APP_BASE_URL` is unset. This is deliberate - the API fails fast rather than running insecure |
| `500` on every request, log says *no such table* | `TYPEORM_SYNCHRONIZE` is not `true`, so the schema was never created |
| Health check passes, then data disappears after a redeploy | `DB_FILE` is not on the mounted volume (check the mount path, e.g. `/data`) |
| Login works but the browser shows network errors | The client is calling a different origin. It should use the relative `/api` base - do not set `VITE_API_BASE` unless the API is on another host |
| `SQLITE_CANTOPEN` / `EACCES` on `/data` | The volume is not writable by the container user. This image runs as root for exactly this reason (see the `Dockerfile` note) |
| AI Suggest always answers "Suggested (offline)" | No model provider was reachable, so the labelled offline classifier answered. That is the documented graceful degradation (ADR-006), not a crash |

## Security notes for the live app

- **Change `ADMIN_PASSWORD` before you submit.** The repository publishes
  `Admin123!` as the development default.
- Generate a real `JWT_SECRET`; never reuse the `change-me-in-production` value
  from `.env.example`.
- The deploy target is a single-user demo instance. There is no rate limiting in
  dev mode; do not treat this configuration as production-hardened for a real
  company.
- `backend/.env` never enters the image - `.dockerignore` excludes `**/.env`.
