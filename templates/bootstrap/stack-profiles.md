<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# /bootstrap stack-profile presets

Pick the preset closest to the interview and record the choice and its rationale in the spike's Stack section. A
preset only fills blanks: anything the user said wins. Domain labels go into the plan's `labels`.

## Next.js + shadcn SaaS
- **Stack**: TypeScript, Next.js (App Router), shadcn/ui + Tailwind, Postgres (Prisma or Drizzle) with row-level security, Auth.js.
- **Repo layout**: `apps/web/`, `packages/db/`, `packages/ui/`, `packages/config/`, `docs/engineering/`.
- **Deployment**: Vercel or a VPS with Docker; managed Postgres; preview deployments per branch.
- **Quality gates**: `tsc --noEmit`, ESLint, Vitest, Playwright smoke test, Lighthouse budget on hero pages.
- **Domain labels**: `frontend`, `backend`, `infra`, `design`.

## Python API
- **Stack**: Python 3.12, FastAPI, SQLAlchemy + Alembic, Postgres, Pydantic settings, uv.
- **Repo layout**: `src/<app>/api/`, `src/<app>/models/`, `src/<app>/services/`, `migrations/`, `tests/`, `docs/engineering/`.
- **Deployment**: a container on a VPS or Cloud Run; managed Postgres.
- **Quality gates**: ruff, mypy, pytest with coverage, an OpenAPI schema diff check.
- **Domain labels**: `backend`, `infra`, `api`.

## Mobile (Expo / React Native)
- **Stack**: TypeScript, Expo + React Native, Expo Router, a backend from one of the presets above (or Supabase).
- **Repo layout**: `apps/mobile/`, `apps/api/` (when a custom backend exists), `packages/shared/`, `docs/engineering/`.
- **Deployment**: EAS Build and Submit; OTA updates for JS-only changes.
- **Quality gates**: `tsc --noEmit`, ESLint, Jest, a Maestro or Detox smoke flow.
- **Domain labels**: `mobile`, `backend`, `infra`, `design`.

## Go service
- **Stack**: Go, chi or net/http, sqlc + Postgres, Docker.
- **Repo layout**: `cmd/<app>/`, `internal/`, `migrations/`, `docs/engineering/`.
- **Deployment**: a single static binary in a container on a VPS or Fly.io.
- **Quality gates**: `go vet`, golangci-lint, `go test -race`.
- **Domain labels**: `backend`, `infra`.
