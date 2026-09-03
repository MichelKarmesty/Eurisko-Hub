# Documentation Index

This folder contains the decisions and working notes behind the Internal Operations Service Hub.

## Reading order
1. [product-spec.md](product-spec.md) - explains the problem, who uses the system, what the MVP must do, and how we will know it works.
2. [architecture.md](architecture.md) - describes the system's main parts, boundaries, and approach to failures.
3. [data-model.md](data-model.md) - describes the core entities, ticket lifecycle, and important access patterns.
4. [decisions/ADR-001.md](decisions/ADR-001.md) - explains why agents claim tickets from a shared queue instead of receiving automatic assignments.

## Purpose of this phase
We are planning before we build. These documents give the team a shared understanding of the product, architecture, and data before code or infrastructure work begins.

## Documentation standards
- Keep the product scope explicit and MVP-focused.
- Maintain clear separation between functional requirements, assumptions, and non-goals.
- Record major design decisions in the ADR folder.
- Prefer simple, audit-friendly documentation over implementation details we have not decided yet.
