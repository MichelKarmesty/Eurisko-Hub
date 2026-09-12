# Eurisko Hub — Backend API

NestJS + TypeORM implementation of the Internal Operations Service Hub
(see the [API reference](../docs/api.md) and the design docs in `../docs/`).

## Stack
- **NestJS 12** (modular monolith — architecture.md §2: Auth Module + Ticket Module)
- **TypeORM** over SQLite (data-model.md: one relational DB; sqljs driver = zero setup)
- **JWT** auth + **RBAC** roles: Employee, IT_Agent, HR_Agent, Maintenance_Agent, Admin
- **class-validator** DTO validation; passwords hashed with bcryptjs; ticket
  history recorded durably in a `ticket_events` table

## Commands
```bash
npm install
npm run build        # tsc -> dist/
npm start            # run compiled build
npm run start:dev    # ts-node watch
npm run typecheck    # tsc --noEmit (src)
npm run typecheck:test # tsc -p tsconfig.spec.json (src + tests)
```

## Tests
Vitest + SWC (NestJS 12 is ESM-only and DI needs `emitDecoratorMetadata`, which
SWC emits — see `vitest.config.mts`). All suites are self-contained and use an
in-memory SQLite database; no server or database file is required.
```bash
npm test                 # all suites
npm run test:unit        # business rule: the ticket lifecycle
npm run test:integration # backend <-> real SQL database
npm run test:api         # HTTP contract + authorization + regression
npm run test:watch       # watch mode
```

## Environment
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | dev value | JWT signing secret (set in prod!) |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `DB_FILE` | *(in-memory)* | SQLite file path for persistence |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@eurisko.local` / `Admin123!` | Seed admin |

## Layout
```
src/
  main.ts               bootstrap (listens on PORT)
  app.setup.ts          shared HTTP pipeline (validation + serialization) used by
                        main.ts AND the API tests, so tests hit the real boundary
  app.module.ts         module wiring + TypeORM + admin seed
  common/               domain enums + JWT/RBAC guards + decorators
  auth/                 register/login/me
  users/                admin user management (provision agents)
  tickets/              tickets + history (entities/service/controller)
test/
  setup.ts              deterministic env for tests (in-memory DB, seed admin)
  domain-rules.spec.ts                  business-rule unit test
  tickets.database.integration.spec.ts  backend <-> database integration test
  tickets.api.spec.ts                   HTTP contract/authorization/regression test
```

## Quick demo
```bash
npm run build && npm start
# then follow "Scenario walk-through" in ../docs/api.md
```
