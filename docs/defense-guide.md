# Eurisko Hub — Final Capstone Defense Guide

**Defense date:** \_\_\_\_\_\_\_\_\_\_  **Time:** 15 minutes, individual
**Live app:** `[LIVE_URL]`  **Submitted SHA:** `[paste from git rev-parse HEAD]`
**Admin login:** `admin@eurisko.com` / `Admin123!` *(or my deployment's `ADMIN_EMAIL`/`ADMIN_PASSWORD`)*

> This is my speaking script and run-of-show, in my own words. Every command
> below exists in the repository and every number is produced by a script I run
> live — nothing here is a slide I cannot back up. If a question goes somewhere I
> did not plan for, I fall back to the evidence files, not to improvisation.

---

## 0. Pre-flight (do this 30 minutes before, not 30 seconds before)

Run the automated checklist and read it top to bottom. It refuses to say READY
while anything that matters is broken.

```bash
node scripts/pre-defense.mjs --sha "$(git rev-parse HEAD)" --live "[LIVE_URL]"
```

It checks the ten things the brief asks me to have ready:

| It checks | Why I care |
| --- | --- |
| Git working tree clean | the grader sees exactly the submitted SHA |
| HEAD matches the submitted SHA | no "I fixed it after submitting" |
| `npm test` passes | 14 backend suites, 0 failures |
| `final-smoke.mjs` → 20/20 | the **live** app works end to end |
| `LIVE_URL` reachable | the deployed instance the grader will open |
| No secrets committed | no `gsk_`, `sk-`, `re_`, SMTP password, real `.env` |
| `.gitignore` covers the sensitive paths | `node_modules`, `.data`, `.env`, `dist` |
| All 11 ADRs present | the ownership evidence |
| README exists and is > 5 KB | the entry point a grader reads first |
| Backend builds clean | `tsc` with no errors |

**Then set up three terminals and a browser:**

1. **Terminal 1 — the app:** `npm run dev` (API on `:3000`, web client on `:5173`).
   Leave it open. I never start a second server during the demo.
2. **Terminal 2 — the live monitor:** `node scripts/defense-health-check.mjs`
   (starts pinging every 10s and keeps its own pass/fail count).
3. **Terminal 3 — my command line** for the evidence scripts.
4. **Browser — two tabs:** the live app, and my repository at the submitted SHA
   (`…/tree/<SHA>`) so "what is running is what was submitted" is one glance.

**Warm-up before the clock starts** (so the first AI call is not the slow one):
log in once, open the New request form, and press **AI Suggest** once. A cold
provider call can take a few seconds; a warmed one is instant.

**If the AI provider is down during the defense:** I do not panic and I do not
hide it. I press AI Suggest, the app answers with the offline classifier and the
badge reads **"Suggested (offline)"** — and that is *more* interesting than the
happy path, because it is the graceful-degradation story I want to tell anyway.
I say so out loud.

---

## The 15 minutes

### Minute 0–2 — PRODUCT: "here is the thing I built"

Open the live app in the browser.

> "Eurisko Hub is an internal operations service hub. Right now, IT, HR and
> Maintenance requests at a company like ours arrive through WhatsApp, hallway
> conversations and email — and then nobody can say who is handling what. This
> gives every employee one place to open a request, gives each department a queue
> to work from, and gives an Admin the whole picture."

Do, in order:

1. **Log in as Admin.** Show the **Users** tab (👥). Create an account live —
   name, a real email, role **Employee**, a password. *"There is no public
   sign-up on purpose. Accounts are provisioned by an Admin, because this is an
   internal tool — I do not want the internet creating accounts in it."* (ADR-004)
2. **Log out, log in as the Employee.** Show the **New request** form. Submit a
   ticket with category **IT**, priority **High**, and a real description.
3. Point at **My submitted requests** and the status **Open**.

> "That is the whole first half of the product: one employee, one request, one
> clear owner of the problem."

Keep it moving — this pillar is about the *problem*, not the code.

### Minute 2–5 — BOUNDARIES: "what is allowed, and what is refused"

This is the part most people skip, so I do it deliberately and show **both
directions**.

| I show | What the audience sees |
| --- | --- |
| Employee creates a ticket | ✅ 201, it appears in **My submitted requests** |
| Log in as the IT Agent, open the IT queue | ✅ the ticket is there, **Open**, waiting |
| Agent claims it | ✅ status moves to **In Progress**, assigned to them |
| Agent opens an **HR** ticket's claim action | ❌ **403** — *"IT only sees and claims the IT queue"* |
| Employee calls `GET /users` (curl or dev tools) | ❌ **403** — *"the Users tab is Admin-only"* |
| Agent resolves with an empty note | ❌ **400** — the form itself says *"Resolution note (required to resolve)…"* |
| Agent resolves with a note | ✅ **Resolved**, and the note is what the requester reads |
| Employee presses **AI Suggest** | ✅ Category/Priority/Title filled in, badge **"AI suggested"** |
| AI Suggest with `asdfghjkl` | ✅ **`relevant: false`** + a reason — *"I could not find a request here"* |

Talking points, verbatim-ish:

> "Every one of those boundaries is enforced **server-side**. The React client
> never decides permissions — it hides what it can, but if I bypass the UI with
> curl, the API still says 403. An authorization rule that only lives in the
> browser is not an authorization rule."

> "The AI is **advisory only**. It suggests, the employee decides. It never
> creates a ticket, it never writes to the database, and it cannot — the AI
> module has no database access at all, and `POST /tickets` is still the only way
> a ticket is created. I prove that: the smoke test takes the ticket count before
> and after two AI calls and asserts it did not move."

> "And when it cannot read the text, it says so instead of guessing. `relevant:
> false` is an honest answer, not an error — the employee can still open the
> ticket by hand. A confident wrong suggestion is worse than no suggestion."

Show the refusal live with curl if I want it undeniable (the monitor in Terminal 2
will print the 403 in the request list at the same moment):

```bash
TOKEN=<employee token>
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/users        # -> 403
```

### Minute 5–8 — PROOF: "every boundary I showed you has a test"

Run the suite live, then the smoke test.

```bash
npm test
```

> "Fourteen backend suites. They are not one happy-path test: domain rules,
> the real database integration, the HTTP contract, authorization, the AI evals,
> the mail transports, password recovery, and the health/ops surface. The exit
> code is the point — `npm test` is 0 or it is not done."

Point at the test list (13 domain/API suites plus the new ops suite):

```bash
ls backend/test/*.spec.ts
```

Then the live end-to-end proof, against the **running** app:

```bash
node scripts/final-smoke.mjs
```

> "Twenty checks against the deployed instance, over HTTP, the same way the
> browser talks to it: health, admin login, provisioning, the full ticket
> journey, the two deliberate 400/403 refusals, the AI happy path and the
> nonsense path, password change, an Admin reset link, and the admin counters.
> Twenty out of twenty, exit code 0."

Then tie the running app to the submission:

```bash
git rev-parse HEAD        # compare to the SHA on the submission email / repo URL
git status --porcelain    # empty = what runs is what was committed
```

> "The SHA you see running is the SHA I submitted. Later pushes do not count, so
> I froze it and I verify it."

### Minute 8–11 — OPERATIONS: "it survives things going wrong"

Show the health monitor already running in Terminal 2:

> "While we have been talking, this has been proving the app is alive every ten
> seconds: `200 OK`, response time, the SQLite file and its size — that is
> persistence, not a cache — uptime, and the last five real requests the server
> handled. Those request lines are the audience's own clicks."

Then the recovery evidence:

```bash
node scripts/prove-recovery.mjs
```

> "Four failure scenarios, run on throwaway databases so it is safe to do live."

1. **Admin lockout.** *"You cannot deactivate the last Admin through the app —
> the API refuses with 400. And if the Admin row is lost out-of-band, the next
> boot re-seeds one while every other account and ticket survives. A database
> that can lock everyone out permanently is a bug, not a security feature."*
2. **AI provider down.** *"Point the provider at a dead endpoint and the intake
> still answers — labelled `source: offline`, and the UI says 'Suggested
> (offline)'. It never dresses the rules up as the model's work."*
3. **Database loss.** *"Delete the SQLite file and restart: the app creates it
> and re-seeds the Admin. A corrupt file is not something the app can parse, so
> the script shows the honest behaviour — the process refuses to start on a file
> that is not a database — and then the documented operator step: remove it,
> restart, clean recovery. I would rather show you the real behaviour than claim
> a magic repair."*
4. **Token expiry.** *"An expired, mis-signed or malformed JWT is a 401. Not a
> 500, not a crash, not a hang."*

The full, timestamped transcript is written to
`artifacts/recovery-proof-<timestamp>.txt` — I can hand over the file.

> "The shape of all of this is: the app degrades gracefully. There is no single
> failure that locks a person out permanently, and no failure that takes the
> whole tool down."

If I have a fresh clone or a second machine, I also show the one-command start:

```bash
npm run dev     # installs if needed, builds, starts API + web client
```

### Minute 11–14 — OWNERSHIP: "why it is built this way"

Open the ADR list — `docs/decisions/` — and the evidence summary.

```bash
node scripts/collect-evidence.mjs        # writes artifacts/evidence-summary.md
```

> "Eleven architecture decisions, each with Context, Decision and Consequences.
> These are the decisions I own."

Pick three and defend them, because they are the ones with real trade-offs:

- **ADR-001 — Manual queue claiming, no auto-assignment.** *"I could have written
  a load balancer. I chose not to: agents choosing from a shared queue keeps the
  backend stateless, needs no availability tracking, and leaves a clear record of
  who took what. The trade-off is that nobody is forced to pick up the next
  ticket; I accept that, and the mitigation is a visible priority and an
  unclaimed count on the Admin dashboard."*
- **ADR-002 — Admin override requires a recorded reason.** *"I did not want a
  ticket to be silently closed by an Admin who is not the assigned agent. So an
  override is allowed — because sometimes the agent is away and the work is real
  — but it costs a reason, and the reason is written into the ticket history as
  an `ADMIN_OVERRIDE` event. The rule is enforced in the service, which is why
  the smoke test gets a 400 if the reason is missing."*
- **ADR-003 / ADR-010 — Soft cancel, and the one hard delete.** *"A cancelled
  ticket is kept, never deleted, because the audit trail is the product. The one
  exception is an Admin hard-deleting a **Resolved** ticket — and only a resolved
  one, so a live piece of work can never disappear."*

On how I used AI, without flinching:

> "I used AI assistance for boilerplate and for drafting tests — the same way I
> used the framework's docs. But I read every line that shipped, I ran every test
> myself, and the decisions in these ADRs are mine. The AI did not decide that an
> override needs a reason; I decided that, because I have seen tickets closed
> with no explanation. And the AI feature in the product is deliberately
> advisory for the same reason: I am not letting a model make operational
> decisions about someone's actual problem."

Show the Week 1–5 progression in the commit log:

```bash
git log --oneline --reverse | head -40     # spec → architecture → slice → tests → AI → recovery
```

> "You can read the progression: product spec and data model, then the
> full-stack slice, then the test suite, then the AI intake, then password
> recovery and ops. I can defend every line because I know why it exists."

### Minute 14–15 — QUESTIONS

Have these open and ready, they are the likely ones:

- **"How do you know the AI is not creating tickets?"** — The AI module has no
  database access; the smoke test asserts the ticket count is unchanged across
  two classify calls; `/tickets/ai-suggest` and `/ai/classify` are both
  read-only views of one service.
- **"What if the grader's machine has no AI key?"** — The app works by hand, and
  the offline classifier answers with `source: "offline"` and a visible
  "Suggested (offline)" badge. `AI_OFFLINE_FALLBACK=false` switches to a strict
  "no provider" contract if an operator prefers that.
- **"Where are the secrets?"** — There are none in the repo. `.env` is
  gitignored; `.env.example` has placeholders; `JWT_SECRET` has a dev default
  that production refuses to boot with (the app asserts required production env
  vars and exits).
- **"Why SQLite?"** — It is a single-node internal tool; SQLite means zero
  operational surface and a database that is a file I can back up. TypeORM keeps
  the door open to Postgres without changing the domain code.
- **"Prove the data survives a restart."** — The health monitor's DB line grows
  across the demo; the recovery script restarts the API against the same file and
  the account it created is still there.

---

## Contingencies

| If this happens | I do this |
| --- | --- |
| Live URL does not load | Show the same flow on `npm run dev` locally and say plainly that the deployed instance is not answering; the code and tests are the same. |
| AI provider slow or down | Let the offline fallback answer; make graceful degradation the point. |
| `npm test` is slow | It is expected to take a couple of minutes; I start it early or I show the pre-recorded exit code from `artifacts/evidence-summary.md` and run it live anyway. |
| A live check fails in front of the panel | I read the failure out loud, run the diagnostic the script prints, and explain the cause — a debugged failure I understand beats a scripted success I cannot. |
| Time is short | Cut Minute 11–14 depth, keep PROOF and OPERATIONS. Product and boundaries are the pillars I will not compress. |

---

## Evidence files (all generated, all timestamped, all in this repo)

| File | What it proves |
| --- | --- |
| `artifacts/evidence-summary.md` | Week 1–5: git log, tree, tests, LOC, docs, ADRs, env, audit, routes |
| `artifacts/evidence-tests-<ts>.log` | the raw `npm test` output |
| `artifacts/recovery-proof-<ts>.txt` | the four recovery scenarios, timestamped |
| `docs/release-gate.md` | the filled-in release checklist |
| `artifacts/submission-email.md` | the submission email template |
| `scripts/final-smoke.mjs` | the 20/20 live proof |
| `scripts/defense-health-check.mjs` | the live "app is alive" pane |
| `scripts/prove-recovery.mjs` | failure + recovery proof |
| `scripts/collect-evidence.mjs` | the evidence compiler |
| `scripts/pre-defense.mjs` | the checklist above |

> One last note to myself: the panel is not testing whether I memorised the code.
> They are testing whether I understand the trade-offs I made and can prove the
> thing runs. That is exactly what this run-of-show is built to show.
