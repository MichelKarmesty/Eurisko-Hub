# Documentation Index

This folder contains the decisions and working notes behind the Internal Operations Service Hub.

## Reading order
1. [product-spec.md](product-spec.md) - explains the problem, who uses the system, what the MVP must do, and how we will know it works.
2. [architecture.md](architecture.md) - describes the system's main parts, boundaries, and approach to failures.
3. [data-model.md](data-model.md) - describes the core entities, ticket lifecycle, and important access patterns.
4. [decisions/ADR-001.md](decisions/ADR-001.md) - explains why agents claim tickets from a shared queue instead of receiving automatic assignments.
5. [decisions/ADR-002.md](decisions/ADR-002.md) - explains the Admin override policy: an Admin may act on an unclaimed ticket, but only with a mandatory, recorded reason.
6. [decisions/ADR-003.md](decisions/ADR-003.md) - explains Admin assignment and soft cancellation: give urgent tickets an owner, retire junk requests, never hard-delete.
7. [decisions/ADR-004.md](decisions/ADR-004.md) - explains why there is no public registration: only the Admin is seeded and the Admin creates every account.
8. [api.md](api.md) - documents the NestJS backend API (in `../backend/`) that implements this design.
9. [security.md](security.md) - the seeded Admin, the no-public-registration rule, and the authorization model.
10. [week3-full-stack-delivery.md](week3-full-stack-delivery.md) - the Week 3 delivery record: the integrated slice, its API contract, the authorization rule and its allowed/denied cases, and the automated tests that protect the behaviour.
11. [week4-production-ai.md](week4-production-ai.md) - the Week 4 delivery record: the AI-assisted Request Intake capability, why it is advisory-only, the validation layer, the graceful fallback, how to run it, and the eval results.

## Purpose of these documents
They are the living record of the delivered product, not a pre-build plan: the product specification, the architecture, the data model, and the decisions behind them, kept in step with the code in `../backend/` and `../frontend/`. Each document states what was decided, why, and where it is implemented.

## Documentation standards
- Keep the product scope explicit and MVP-focused.
- Maintain clear separation between functional requirements, assumptions, and non-goals.
- Record major design decisions in the ADR folder.
- Prefer simple, audit-friendly documentation over implementation details we have not decided yet.
