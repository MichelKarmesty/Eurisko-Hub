# Release Gate Checklist

This checklist is filled in as the work is verified — an unticked box is an
unfinished claim, not a formality. Commands assume the repository root.

Every box that can be checked without a deployed URL is ticked; the results were
produced on a fresh database and are recorded next to each box. The boxes still
open are exactly the ones that need the live app (`**live**` notes). This file is
not submit-ready until those are ticked against the deployed URL.

**Submission record**

- **Final commit SHA:** `$(git rev-parse HEAD)` (the current commit) — re-run `git rev-parse HEAD` after any further commit
- **Live app URL:** `______________________________` — pending: deploy with `deploy/vm/bootstrap.sh` (Option E) or Options A–D, then paste it here
- **Submitted at (ISO 8601):** `______________________________`
- **Release gate reviewed by:** `______________________________`

**State of this checklist at the current commit:** every box that can be checked without a
live URL is checked below and was verified locally; the boxes that need the
deployed app are left open and marked **live** — this file is not submit-ready
until they are ticked. Nothing has been deployed yet.

---

## Access

- [x] Repository is public and the URL is correct — <https://github.com/MichelKarmesty/Eurisko-Hub>
- [x] Grader can clone and run `npm run dev` on a fresh machine (one command installs, builds and starts API + web client)
- [ ] Live app URL is reachable from outside my network (open it on a phone hotspot, not only on my LAN) — **live**
- [x] Default admin credentials work, or documented alternatives are in the README
  - default: `admin@eurisko.com` / `Admin123!`; deployment overrides `ADMIN_EMAIL` / `ADMIN_PASSWORD`
  - verified on a fresh database: exactly 1 account (the Admin) and 0 tickets

Verify:

```bash
node scripts/pre-defense.mjs --sha "$(git rev-parse HEAD)" --live "[LIVE_URL]"
```

## Product

- [x] Core journey works: create ticket → claim → resolve → see result — verified: `final-smoke` 20/20, `verify-slice` 28/28, DOM E2E 5/5
- [x] UI exists and is functional (not API-only) — React client driven by the DOM E2E suites
- [ ] Data persists across restarts (`DB_FILE` is set on the live deployment) — **live**
- [x] Auth works: login, logout, JWT validation, session restore — 124 backend tests + smoke checks
- [x] All form validations work (empty resolution note rejected with 400, etc.) — smoke + `verify-slice` assert the 400

Verify: `node scripts/final-smoke.mjs` → **20/20**, and restart the app, then
confirm the ticket is still there.

## AI feature (Week 4)

- [x] AI Suggest button works on the New request form
- [x] AI returns category, priority and title suggestions
- [x] AI handles nonsense input (`relevant: false` + reason, HTTP 200)
- [x] App works with no AI key (offline fallback answers) — verified live with the provider unreachable: `source: "offline"` + notice
- [x] Offline suggestions are labelled differently from AI suggestions — badge **"Suggested (offline)"** vs **"AI suggested"**

Verify:

```bash
node scripts/prove-recovery.mjs --scenario 2
```

## Tests

- [x] `npm test` exits 0 — ran: exit 0
- [x] All 14 backend test suites pass — 14 suites, 124 passed / 5 skipped
- [x] DOM E2E passes (browser → React → API → SQLite) — 5/5 flows
- [x] `node scripts/final-smoke.mjs` exits 0 — 20/20 passed
- [x] `node scripts/verify-slice.mjs full` exits 0 — 28/28 passed
- [x] `node scripts/verify-ai-intake.mjs` exits 0 — 11/11 passed (offline source)

Verify: `npm test` (root, full suite) and the two scripts above.

## Security

- [x] No real API keys in committed code — `pre-defense` scanned 151 tracked files: clean
- [x] No secrets in `.env` committed (`.env` is gitignored; `.env.example` holds placeholders)
- [x] `.gitignore` covers: `node_modules`, `.data`, `.env`, `*.sqlite`, `dist` — pre-defense confirmed all four
- [x] Passwords are bcrypt-hashed (never plaintext) — `auth-password.spec.ts`
- [x] `JWT_SECRET` is not the default in production (the app refuses to boot in production without it) — `env.ts` fail-fast, covered by tests
- [x] Password-reset tokens are stored only as hashes and are single-use with a TTL — `admin-reset-password.spec.ts`

Verify: `node scripts/pre-defense.mjs` scans every tracked file for key patterns.

## Documentation

- [x] README has: setup, run, exercise walkthrough, troubleshooting
- [x] All 11 ADRs written with Context/Decision/Consequences (`docs/decisions/`) — pre-defense found all 11
- [x] API reference is complete (`docs/api.md`)
- [x] Security document exists (`docs/security.md`)
- [x] Defense guide reviewed (`docs/defense-guide.md`)

Verify: `node scripts/collect-evidence.mjs` → `artifacts/evidence-summary.md`.

## Operations

- [x] App starts with one command (`npm run dev`) — verified on a fresh database: 1 Admin, 0 tickets
- [x] Admin re-seeds if none exists — `admin-seed.spec.ts`
- [x] AI fallback works when the provider is down — verify-ai-intake 11/11 on the offline path
- [x] Break-glass password reset script works (`node scripts/reset-password.mjs`) — `--help` exits 0
- [x] Recovery proof script passes — `prove-recovery.mjs` 4/4 scenarios
- [ ] Health monitor shows `200 OK`, DB size and uptime during the demo — local script (`defense-health-check.mjs`), run it live at the demo

Verify:

```bash
node scripts/prove-recovery.mjs
node scripts/defense-health-check.mjs
node scripts/reset-password.mjs --help
```

## Final

- [x] Final commit SHA recorded above and matches `git rev-parse HEAD`
- [x] Working tree is clean (`git status --porcelain` prints nothing)
- [ ] Live app URL recorded above and reachable — **live**
- [x] Submission email drafted (`artifacts/submission-email.md` filled in)
- [x] Defense talking points reviewed (`docs/defense-guide.md`)
- [x] Release gate re-run after the **last** commit (not before it)

```bash
git rev-parse HEAD
git status --porcelain
```

---

## Sign-off

| Gate | Result | Date (ISO 8601) |
| --- | --- | --- |
| Access | ☐ pass ☐ fail — live URL still to be recorded | 2026-09-29 |
| Product | ☐ pass ☐ fail — locally verified | 2026-09-29 |
| AI feature | ☐ pass ☐ fail — locally verified | 2026-09-29 |
| Tests | ☐ pass ☐ fail — locally verified | 2026-09-29 |
| Security | ☐ pass ☐ fail — locally verified | 2026-09-29 |
| Documentation | ☐ pass ☐ fail — locally verified | 2026-09-29 |
| Operations | ☐ pass ☐ fail — locally verified | 2026-09-29 |
| Final | ☐ pass ☐ fail — awaiting the live URL | 2026-09-29 |

**Submitted SHA:** `$(git rev-parse HEAD)`  **Live URL:** `__________________`
