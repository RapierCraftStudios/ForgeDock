---
authority: required
scope: project
applies_to: [work-on, review-pr, issue, orchestrate]
---

# System Architecture

This file describes the system architecture and domain organization for this project. Pipeline agents read this file to understand how components relate, where boundaries lie, and which files belong to which domain.

---

## Instructions

Replace the placeholder content below with your project's actual architecture. Be specific about:
- Service/layer boundaries (what each component owns)
- Data flows (how data moves between components)
- Domain file locations (where to find code for each domain)

---

## High-Level Architecture

> Describe the system at a high level. What are the major components and how do they interact?

```
{e.g.:
Frontend (Next.js)
    ↓ /api/* proxy
API Service (FastAPI)
    ↓                    ↓
PostgreSQL            Redis
                         ↓
                    Worker Service (Celery)
                         ↓
                    External APIs (Stripe, etc.)
}
```

**Key architectural decisions**:
- {e.g., "All external API calls are proxied through the API service — the frontend never calls third-party APIs directly"}
- {e.g., "Workers and API share the same database but have separate connection pools"}
- {e.g., "Deploy uses blue/green — two containers run simultaneously during deploy, Traefik switches traffic"}

---

## Domains and File Locations

> Map each domain to its directory structure. Agents use this to find the right files quickly.

### {Domain 1, e.g., "Authentication"}

**Responsibility**: {What this domain owns — be specific}
**Location**: `{e.g., services/api/app/auth/}`
**Key files**:
- `{filepath}` — {what it does}
- `{filepath}` — {what it does}

### {Domain 2, e.g., "Billing & Subscriptions"}

**Responsibility**: {What this domain owns}
**Location**: `{e.g., services/api/app/billing/}`
**Key files**:
- `{filepath}` — {what it does}
- `{filepath}` — {what it does}

### {Domain 3, e.g., "Frontend — Dashboard"}

**Responsibility**: {What this domain owns}
**Location**: `{e.g., web/src/app/dashboard/}`
**Key files**:
- `{filepath}` — {what it does}

---

## Data Flow

> Describe how data moves through the system for the most important operations.

### {Key operation, e.g., "User creates a subscription"}

```
1. Frontend: POST /api/subscriptions
2. API: Validate request → call Stripe
3. Stripe: Returns subscription object
4. API: Write to PostgreSQL (subscriptions table)
5. API: Publish event to Redis queue
6. Worker: Consume event → send confirmation email
```

---

## Deployment Architecture

> How does the system deploy in production?

**Environment**: {e.g., single VPS, multi-region, serverless}
**Containers**: {e.g., api-blue, api-green, web, worker, postgres, redis, traefik}
**Deploy process**: {e.g., "GitHub Actions SSH → pull latest → docker compose up --force-recreate"}
**Database**: {e.g., "PostgreSQL in Docker with named volume; backups to S3 daily"}
**Secrets**: {e.g., "SOPS-encrypted secrets in infra/secrets/prod.enc.yaml; decrypted by deploy script"}

---

## Cross-Domain Constraints for Agents

> Rules that apply across domain boundaries — agents must follow these when building.

- {e.g., "Services never import from each other — communication is through the database or queue only"}
- {e.g., "Frontend components in `components/ui/` are shared across authenticated and public routes — never add auth-dependent hooks without a null-context guard"}
- {e.g., "All cross-service events must be idempotent — workers may process the same message more than once"}
- {e.g., "Database schema changes require a migration file — never modify the schema directly"}

---

## Known Architectural Footguns

> Document recurring patterns that cause bugs in this codebase. Agents read this before investigating and building.

- {e.g., "Docker named volumes are created as root-owned — always chown in the entrypoint before privilege drop"}
- {e.g., "The frontend dev server proxies /api/* to port 8000, but production uses Traefik — never hardcode ports in frontend code"}
- {e.g., "`appleboy/ssh-action` preprocesses `{{` as Go templates before SSH — use `jq` instead of docker format strings"}
