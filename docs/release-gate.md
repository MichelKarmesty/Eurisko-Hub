# Release Gate Checklist

Fill this in **before** submitting — every box ticked is a claim I can back up
live. Commands assume the repository root. If a box cannot be ticked, it is not
"nearly done": it is not submitted yet.

**Submission record**

- **Final commit SHA:** `______________________________`
- **Live app URL:** `______________________________`
- **Submitted at (ISO 8601):** `______________________________`
- **Release gate reviewed by:** `______________________________`

---

## Access

- [ ] Repository is public and the URL is correct — <https://github.com/MichelKarmesty/Eurisko-Hub>
- [ ] Grader can clone and run `npm run dev` on a fresh machine (one command installs, builds and starts API + web client)
- [ ] Live app URL is reachable from outside my network (open it on a phone hotspot, not only on my LAN)
- [ ] Default admin credentials work, or documented alternatives are in the README
  - default: `admin@eurisko.com` / `Admin123!`; deployment overrides `ADMIN_EMAIL` / `ADMIN_PASSWORD`

Verify:

```bash
node scripts/pre-defense.mjs --sha "$(git rev-parse HEAD)" --live "[LIVE_URL]"
```

## Product

- [ ] Core journey works: create ticket → claim → resolve → see result
- [ ] UI exists and is functional (not API-only)
- [ ] Data persists across restarts (`DB_FILE` is set on the live deployment)
- [ ] Auth works: login, logout, JWT validation, session restore
- [ ] All form validations work (empty resolution note rejected with 400, etc.)

Verify: `node scripts/final-smoke.mjs` → **20/20**, and restart the app, then
confirm the ticket is still there.

## AI feature (Week 4)

- [ ] AI Suggest button works on the New request form
- [ ] AI returns category, priority and title suggestions
- [ ] AI handles nonsense input (`relevant: false` + reason, HTTP 200)
- [ ] App works with no AI key (offline fallback answers)
- [ ] Offline suggestions are labelled differently from AI suggestions — badge **"Suggested (offline)"** vs **"AI suggested"**

Verify:

```bash
node scripts/prove-recovery.mjs --scenario 2
```

## Tests

- [ ] `npm test` exits 0
- [ ] All 14 backend test suites pass
- [ ] DOM E2E passes (browser → React → API → SQLite)
- [ ] `node scripts/final-smoke.mjs` exits 0
- [ ] `node scripts/verify-slice.mjs full` exits 0
- [ ] `node scripts/verify-ai-intake.mjs` exits 0

Verify: `npm test` (root, full suite) and the two scripts above.

## Security

- [ ] No real API keys in committed code
- [ ] No secrets in `.env` committed (`.env` is gitignored; `.env.example` holds placeholders)
- [ ] `.gitignore` covers: `node_modules`, `.data`, `.env`, `*.sqlite`, `dist`
- [ ] Passwords are bcrypt-hashed (never plaintext)
- [ ] `JWT_SECRET` is not the default in production (the app refuses to boot in production without it)
- [ ] Password-reset tokens are stored only as hashes and are single-use with a TTL

Verify: `node scripts/pre-defense.mjs` scans every tracked file for key patterns.

## Documentation

- [ ] README has: setup, run, exercise walkthrough, troubleshooting
- [ ] All 11 ADRs written with Context/Decision/Consequences (`docs/decisions/`)
- [ ] API reference is complete (`docs/api.md`)
- [ ] Security document exists (`docs/security.md`)
- [ ] Defense guide reviewed (`docs/defense-guide.md`)

Verify: `node scripts/collect-evidence.mjs` → `artifacts/evidence-summary.md`.

## Operations

- [ ] App starts with one command (`npm run dev`)
- [ ] Admin re-seeds if none exists
- [ ] AI fallback works when the provider is down
- [ ] Break-glass password reset script works (`node scripts/reset-password.mjs`)
- [ ] Recovery proof script passes
- [ ] Health monitor shows `200 OK`, DB size and uptime during the demo

Verify:

```bash
node scripts/prove-recovery.mjs
node scripts/defense-health-check.mjs
node scripts/reset-password.mjs --help
```

## Final

- [ ] Final commit SHA recorded above and matches `git rev-parse HEAD`
- [ ] Working tree is clean (`git status --porcelain` prints nothing)
- [ ] Live app URL recorded above and reachable
- [ ] Submission email drafted (`artifacts/submission-email.md` filled in)
- [ ] Defense talking points reviewed (`docs/defense-guide.md`)
- [ ] Release gate re-run after the **last** commit (not before it)

```bash
git rev-parse HEAD
git status --porcelain
```

---

## Sign-off

| Gate | Result | Date (ISO 8601) |
| --- | --- | --- |
| Access | ☐ pass ☐ fail | |
| Product | ☐ pass ☐ fail | |
| AI feature | ☐ pass ☐ fail | |
| Tests | ☐ pass ☐ fail | |
| Security | ☐ pass ☐ fail | |
| Documentation | ☐ pass ☐ fail | |
| Operations | ☐ pass ☐ fail | |
| Final | ☐ pass ☐ fail | |

**Submitted SHA:** `______________________________`  **Live URL:** `______________________________`
