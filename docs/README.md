# Documentation Index

This folder contains the decisions and working notes behind the Internal Operations Service Hub.

Just want to run the app? [`run-the-app.md`](run-the-app.md) is the five-minute checklist.

## Reading order
1. [product-spec.md](product-spec.md) - explains the problem, who uses the system, what the MVP must do, and how we will know it works.
2. [architecture.md](architecture.md) - describes the system's main parts, boundaries, and approach to failures.
3. [data-model.md](data-model.md) - describes the core entities, ticket lifecycle, and important access patterns.
4. [decisions/ADR-001.md](decisions/ADR-001.md) - explains why agents claim tickets from a shared queue instead of receiving automatic assignments.
5. [decisions/ADR-002.md](decisions/ADR-002.md) - explains the Admin override policy: an Admin may act on an unclaimed ticket, but only with a mandatory, recorded reason.
6. [decisions/ADR-003.md](decisions/ADR-003.md) - explains Admin assignment and soft cancellation: give urgent tickets an owner, retire junk requests, never hard-delete.
7. [decisions/ADR-004.md](decisions/ADR-004.md) - explains why there is no public registration: only the Admin is seeded and the Admin creates every account.
8. [decisions/ADR-005.md](decisions/ADR-005.md) - explains password **reset** and password **change**: hashed, expiring, single-use one-time tokens, an authenticated change, and why any real email address is accepted. (Its self-service email path was removed by ADR-007, restored by ADR-008 and switched off by default by ADR-009; the token and change mechanics stand throughout.)
9. [decisions/ADR-006.md](decisions/ADR-006.md) - explains why the AI-assisted intake is **advisory only**: it suggests form fields, never creates or changes a ticket, validates model output, and falls back to a labelled offline classifier - the decision that scopes the MVP's original "no AI" non-goal.
10. [decisions/ADR-007.md](decisions/ADR-007.md) - explains Admin-initiated password reset: the Admin mints a one-time link for a colleague who forgot theirs and never sees or sets the password; this is the supported recovery route, with the offline CLI break-glass for a lone locked-out Admin.
11. [decisions/ADR-008.md](decisions/ADR-008.md) - explains the self-service **forgot password** path: the one-time link is emailed through the built-in mail transports (SMTP → backup SMTP → webhook → Resend → console), with a non-enumerating generic answer and an anti mail-bomb cooldown. Now opt-in.
12. [decisions/ADR-009.md](decisions/ADR-009.md) - explains why recovery is **Admin-initiated** and the public self-service reset is **off by default** (`404` unless `PASSWORD_RESET_SELF_SERVICE=true`), keeping the mail capability without exposing an unauthenticated mail-sending endpoint.
13. [decisions/ADR-010.md](decisions/ADR-010.md) - explains the one exception to "tickets are never deleted": an Admin may permanently delete a **`Resolved`** ticket (row + history), while everything live is still soft-cancelled and every other state is refused.
14. [decisions/ADR-011.md](decisions/ADR-011.md) - explains why an Admin can also **set a password directly** (`PATCH /users/:id/password`) instead of only handing over a one-time link: the link workflow stays, the credential now changes hands, and every use is logged.
15. [api.md](api.md) - documents the NestJS backend API (in `../backend/`) that implements this design.
16. [security.md](security.md) - the seeded Admin, the no-public-registration rule, the authorization model, and the password-recovery lifecycle.
17. [week3-full-stack-delivery.md](week3-full-stack-delivery.md) - the Week 3 delivery record: the integrated slice, its API contract, the authorization rule and its allowed/denied cases, and the automated tests that protect the behaviour.
18. [week4-production-ai.md](week4-production-ai.md) - the Week 4 delivery record: the AI-assisted Request Intake capability, why it is advisory-only, the validation layer, the graceful fallback, how to run it, and the eval results.

## Purpose of these documents
They are the living record of the delivered product, not a pre-build plan: the product specification, the architecture, the data model, and the decisions behind them, kept in step with the code in `../backend/` and `../frontend/`. Each document states what was decided, why, and where it is implemented.

## Documentation standards
- Keep the product scope explicit and MVP-focused.
- Maintain clear separation between functional requirements, assumptions, and non-goals.
- Record major design decisions in the ADR folder.
- Prefer simple, audit-friendly documentation over implementation details we have not decided yet.
