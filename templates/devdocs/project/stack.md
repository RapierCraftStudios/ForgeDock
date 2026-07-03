---
authority: required
scope: project
applies_to: [work-on, review-pr, issue]
---

# Tech Stack

This file describes the technology stack for this project. Pipeline agents read this file to understand which tools, frameworks, and environments are in use — informing investigation scope, build decisions, and review focus areas.

---

## Instructions

Replace the placeholder content below with your project's actual tech stack. Be specific about versions where they matter for agent behavior (e.g., Python 3.11 vs 3.12 affects type hint syntax; Next.js 13 App Router vs Pages Router affects file structure).

---

## Backend

**Runtime**: {e.g., Python 3.12, Node.js 20, Go 1.22}
**Framework**: {e.g., FastAPI 0.111, Express 4.x, Gin}
**Database**: {e.g., PostgreSQL 16, MySQL 8, SQLite, MongoDB}
**ORM / Query Layer**: {e.g., SQLAlchemy 2.0 async, Prisma, raw SQL}
**Cache**: {e.g., Redis 7, Memcached, none}
**Queue / Workers**: {e.g., Celery + Redis, Bull, RQ, none}
**Auth**: {e.g., JWT + refresh tokens, session cookies, OAuth2}

## Frontend

**Framework**: {e.g., Next.js 15 App Router, React 18, Vue 3, SvelteKit}
**Styling**: {e.g., Tailwind CSS 3, CSS Modules, styled-components}
**State Management**: {e.g., Zustand, Redux Toolkit, React Query, SWR, none}
**API Layer**: {e.g., tRPC, REST with fetch, GraphQL, Axios}

## Infrastructure

**Hosting**: {e.g., single VPS (DigitalOcean), AWS EC2, Vercel, Railway}
**Containerization**: {e.g., Docker Compose, Kubernetes, none}
**Reverse Proxy**: {e.g., Traefik, Nginx, Caddy}
**Deploy Strategy**: {e.g., blue/green, rolling, direct replace}
**CI/CD**: {e.g., GitHub Actions, CircleCI, none}

## External Services

**Payments**: {e.g., Stripe, LemonSqueezy, none}
**Email**: {e.g., Resend, SendGrid, SES, none}
**Storage**: {e.g., S3, Cloudflare R2, local disk}
**Monitoring**: {e.g., Sentry, Datadog, UptimeRobot}
**Analytics**: {e.g., PostHog, Umami, GA4, none}

---

## Key Constraints for Agents

> Fill in constraints that affect how agents should behave when working in this stack.

- {e.g., "All database queries must use async SQLAlchemy — never use sync engine"}
- {e.g., "Frontend API calls must use `/api/...` proxy routes — never call the backend directly with host:port"}
- {e.g., "Docker named volumes are root-owned by default — always add chown in entrypoint before privilege drop"}
- {e.g., "No ORM migrations — use raw SQL in `migrations/` with sequential numbering"}

---

## Local Development Setup

> Describe how to get a local dev environment running. Agents use this when verifying changes.

```bash
# {commands to start the local dev environment}
# e.g.:
cp .env.example .env
docker compose up -d
npm run dev
```

**Default URLs**:
- Frontend: {e.g., http://localhost:3000}
- API: {e.g., http://localhost:8000}
- Admin: {e.g., http://localhost:8000/docs (FastAPI Swagger)}
