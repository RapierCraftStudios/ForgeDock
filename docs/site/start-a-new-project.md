---
title: "Start a New Project with ForgeDock"
description: "Go from a one-line idea to a validated, orchestrate-ready GitHub backlog with /bootstrap: interview, spike doc, dry-run preview with estimated cost, creation and the /orchestrate hand-off. Includes a worked example."
keywords: ["forgedock bootstrap", "new project backlog", "claude code new project", "ai project setup", "orchestrate"]
---

# Start a New Project with ForgeDock

[Getting Started](./getting-started.md) assumes a repo that already has issues. This guide covers a brand-new project. You start with an idea, `/bootstrap` turns it into a backlog of GitHub issues in build order, and `/orchestrate` builds that backlog one milestone at a time.

```text
idea ──▶ /bootstrap ──▶ spike doc + plan ──▶ dry-run preview ──▶ backlog on GitHub ──▶ /orchestrate per milestone
```

All the GitHub writes happen in one deterministic script (`scripts/bootstrap-create.mjs`). The agent does the judgment work: the interview, the defaults and the plan. The script validates the plan and creates it. Flags are listed in the [command reference](./command-reference.md#bootstrap).

---

## Prerequisites

- A GitHub repo for the new project (it can be empty). Set it in `forge.yaml` (`project.owner` / `project.repo`, from `npx forgedock init`) or pass `--repo OWNER/NAME`.
- GitHub CLI (`gh`) authenticated (`gh auth login`).
- Node.js 18 or higher.
- Claude Code with ForgeDock installed for `/bootstrap`, or just `npx forgedock` for the headless path.

## 1. From idea to `/bootstrap`

Start from a free-text idea, or from docs you already have:

```bash
/bootstrap "a shared grocery list for households"   # in a Claude Code session
/bootstrap docs/idea.md                             # start from existing docs
/bootstrap "<idea>" --dry-run                       # preview only, no GitHub writes
```

Without an interactive session:

```bash
npx forgedock bootstrap "a shared grocery list for households" --dry-run
```

Headless mode can't ask you questions. It takes the recommended option for each one and lists it under "Here's what I assumed", so check that list before you create anything.

## 2. What `/bootstrap` does

1. **Interview.** It covers the aspects in `templates/bootstrap/interview.md` (users, core jobs, scope, platforms, stack, auth, data and tenancy, integrations, payments, compliance, deployment, budget and more) and skips anything your idea already answers.
2. **Fills the blanks.** Every unanswered aspect gets a sensible default with a one-line rationale. All of them appear in one editable "Here's what I assumed" list.
3. **Asks only genuine doubts.** These are choices that change architecture or cost, such as native vs PWA, data residency or self-hosted vs managed DB, plus the product name and repo owner, which are always asked. It asks at most 4 multiple-choice questions per batch, each with a recommended option.
4. **Writes the spike doc** to `docs/engineering/technical-spike.md` (or the path in `--spike <path>`). It must have the sections Stack, Repo layout, Runtime topology, Data model, Security and privacy, Design system and quality gates, Route/API map, Credentials and Milestone plan. Each section needs a `**Rationale**:` line.
5. **Writes a plan JSON** with milestones in build order (foundation first), a `SPIKE` parent issue, and sub-issues in the pipeline issue template. Each sub-issue lists planned files and acceptance criteria with `[type:*]` tags.
   - Every credential, account or external input gets its own **needs-human** issue. Code issues may mention it, but they never depend on it. A mock keeps dev and CI green until the real thing exists.
6. **Validates** the plan with `scripts/bootstrap-validate.mjs` and fixes it until it passes. Nothing is ever created from an invalid plan.

## 3. Preview the backlog (dry run)

If you already have a plan file, you can preview it without an LLM call or any GitHub access:

```bash
npx forgedock bootstrap --plan plan.json --dry-run
```

The preview lists each milestone with its `milestone/<slug>` branch, the issues in build order and their dependencies, a DAG summary, and an **estimated agent cost**. The estimate is a flat rate per build issue: `$3` by default, or `costPerIssueUsd` in the plan, or `--cost-per-issue <usd>`. The spike and needs-human issues are excluded. It's a planning estimate, not a measured figure.

The spike doc has to exist on disk even for a dry run. If it's missing a section or a rationale, the script prints the error and writes nothing.

## 4. Create the backlog

```bash
npx forgedock bootstrap --plan plan.json
```

This creates:

- the spike parent issue
- the milestones, plus a `milestone/<slug>` branch for each
- every sub-issue, with a `**Parent**` link to the spike, the plan's guardrails and domain rules added to its Context, and <code v-pre>#{{KEY}}</code> placeholders resolved to real issue numbers
- a board item for each issue (Status=Todo, Priority, Component)
- `FORGE:BOOTSTRAP_PLAN` and `FORGE:DECOMPOSED` comments on the spike, which is then labelled `workflow:decomposed`

Exit codes: `0` created (or previewed), `1` invalid plan or spike doc (nothing written), `2` usage error, `3` GitHub error.

**Resume by re-running.** GitHub is the state. Issues are reused by exact title plus their `**Parent**` link, milestones by title, branches if they already exist, and comments if their marker is already there. After a network or rate-limit failure (exit `3`), run the same command again.

## 5. The hand-off

Creation ends with a hand-off in three parts:

- **Created**: links to the build issues.
- **Needs a human**: links to the credential and account issues. Do these when you can. They block nothing, because the code issues use mocks until then.
- **Next commands**: one `/orchestrate milestone "<title>"` per milestone, in build order.

Run the orchestrate commands in that order. Each one builds its milestone's issues through the normal `/work-on` pipeline.

---

## Worked example: Shelf, a shared grocery list

The idea: *"Shelf, a shared grocery list for households. Members invite each other by email and see items checked off live."*

### Assumptions and doubts

Headless, `/bootstrap` takes the recommended options and lists them:

```text
Here's what I assumed
- Platform: responsive web app (PWA later): a household list is used on phones, and a PWA avoids app-store review.
- Stack: Next.js + TypeScript + Postgres (Prisma): the closest preset for a small web app.
- Auth: email magic link: members already arrive through an email invite.
- Email: Resend, behind a mock mailer in dev and CI.
- Hosting: one web service plus managed Postgres.
```

### The spike doc

`docs/engineering/technical-spike.md` has every required section, each with a rationale:

```markdown
# Shelf — technical spike

## Stack
Next.js (App Router) + TypeScript, Postgres via Prisma, pnpm.
**Rationale**: one language end to end; the closest stack preset for a small web app.

## Repo layout
Single app: `app/`, `lib/`, `prisma/`.
**Rationale**: one deployable; no monorepo until a second app exists.

## Runtime topology
One web service plus managed Postgres.
**Rationale**: the cheapest setup that still gives live updates for a few households.

## Data model
`Household`, `Member`, `List`, `Item`; every row carries `householdId`.
**Rationale**: the household is the sharing and access boundary.

## Security and privacy
Members only ever read their own household's rows; invites expire after 7 days.
**Rationale**: grocery lists are personal data.

## Design system and quality gates
shadcn/ui; `pnpm build`, lint and unit tests in CI.
**Rationale**: accessible defaults and fast feedback.

## Route/API map
`/api/lists`, `/api/invites`.
**Rationale**: one route per milestone feature.

## Credentials
Resend API key (needs-human); the mock mailer is used until it exists.
**Rationale**: agents cannot create third-party accounts.

## Milestone plan
1. Foundation: scaffold, schema. 2. Sharing: list API, invites.
**Rationale**: sharing needs the schema first.
```

### The plan

Two milestones, a spike, four build issues and one needs-human issue. `INVITES` mentions <code v-pre>#{{RESEND_KEY}}</code> but doesn't depend on it, so it can be built and tested against the mock mailer.

```json
{
  "labels": [
    "frontend",
    "backend",
    "infra",
    "needs-human"
  ],
  "milestones": [
    {
      "key": "foundation",
      "title": "Foundation"
    },
    {
      "key": "sharing",
      "title": "Sharing"
    }
  ],
  "spikeDoc": "docs/engineering/technical-spike.md",
  "guardrails": [
    "no email is sent without an explicit invite"
  ],
  "domainRules": [
    "one household per list"
  ],
  "issues": [
    {
      "key": "SPIKE",
      "title": "spike: Shelf stack, layout and milestone plan",
      "milestone": "foundation",
      "labels": [
        "infra"
      ],
      "deps": [],
      "body": "## Problem\n\nDecide Shelf's stack, repo layout and milestone plan.\n\n## Root Cause (if known)\n\nGreenfield: not built yet.\n\n## Affected Files\n\n1. `docs/engineering/technical-spike.md` — new\n\n## Acceptance Criteria\n\n- [ ] Spike doc covers every section with a rationale [type:manual]\n\n## Context\n\n**Parent**: none (spike)\n\n## Dependencies\n\nNone.\n"
    },
    {
      "key": "SCAFFOLD",
      "title": "scaffold: Next.js app with pnpm and CI",
      "milestone": "foundation",
      "labels": [
        "frontend",
        "infra"
      ],
      "deps": [
        "SPIKE"
      ],
      "priority": "p0",
      "body": "## Problem\n\nScaffold the Next.js app with pnpm and a CI workflow.\n\n## Root Cause (if known)\n\nGreenfield: not built yet.\n\n## Affected Files\n\n1. `package.json` — new\n2. `app/layout.tsx` — new\n3. `.github/workflows/ci.yml` — new\n\n## Acceptance Criteria\n\n- [ ] `pnpm build` succeeds [type:unit]\n\n## Context\n\n**Parent**: #{{SPIKE}}\n\n## Dependencies\n\nDepends on #{{SPIKE}} — needs the stack decision\n"
    },
    {
      "key": "DB",
      "title": "db: Postgres schema for households, lists and items",
      "milestone": "foundation",
      "labels": [
        "backend"
      ],
      "deps": [
        "SCAFFOLD"
      ],
      "priority": "p0",
      "body": "## Problem\n\nPostgres schema for households, lists and items via Prisma.\n\n## Root Cause (if known)\n\nGreenfield: not built yet.\n\n## Affected Files\n\n1. `prisma/schema.prisma` — new\n\n## Acceptance Criteria\n\n- [ ] A member reads only their own household's lists [type:unit]\n\n## Context\n\n**Parent**: #{{SPIKE}}\n\n## Dependencies\n\nDepends on #{{SCAFFOLD}} — needs the app and package setup\n"
    },
    {
      "key": "LISTS_API",
      "title": "lists: Shared list API with live updates",
      "milestone": "sharing",
      "labels": [
        "backend"
      ],
      "deps": [
        "DB"
      ],
      "priority": "p1",
      "body": "## Problem\n\nAPI to add, check off and remove items, with live updates for everyone in the household.\n\n## Root Cause (if known)\n\nGreenfield: not built yet.\n\n## Affected Files\n\n1. `app/api/lists/route.ts` — new\n\n## Acceptance Criteria\n\n- [ ] Checking an item off shows up for a second member [type:api]\n\n## Context\n\n**Parent**: #{{SPIKE}}\n\n## Dependencies\n\nDepends on #{{DB}} — needs the schema\n"
    },
    {
      "key": "INVITES",
      "title": "invites: Email invites to join a household",
      "milestone": "sharing",
      "labels": [
        "backend"
      ],
      "deps": [
        "LISTS_API"
      ],
      "priority": "p1",
      "body": "## Problem\n\nInvite a member by email. Sending uses Resend; the key comes from #{{RESEND_KEY}}, and until it exists dev and CI use the mock mailer.\n\n## Root Cause (if known)\n\nGreenfield: not built yet.\n\n## Affected Files\n\n1. `app/api/invites/route.ts` — new\n2. `lib/mailer.ts` — new\n\n## Acceptance Criteria\n\n- [ ] An invite link adds the member to the household [type:api]\n\n## Context\n\n**Parent**: #{{SPIKE}}\n\n## Dependencies\n\nDepends on #{{LISTS_API}} — needs households and lists\n"
    },
    {
      "key": "RESEND_KEY",
      "title": "resend: Create the Resend API key and store it",
      "milestone": "sharing",
      "labels": [
        "needs-human"
      ],
      "deps": [],
      "needsHuman": true,
      "body": "## Problem\n\nCreate the Resend API key that #{{INVITES}} uses to send email.\n\n### Setup steps\n\n1. Create an API key at https://resend.com/api-keys with sending access only.\n2. Store it as the `RESEND_API_KEY` deploy secret.\n\n### Environment variables\n\n- `RESEND_API_KEY` — Resend sending key\n\n### Secret handling\n\nNever commit the key or paste it into issues. Until it exists, dev and CI use the mock mailer.\n\n## Root Cause (if known)\n\nGreenfield: not built yet.\n\n## Affected Files\n\n1. `docs/setup/resend.md` — new\n\n## Acceptance Criteria\n\n- [ ] Key stored as a deploy secret [type:manual]\n- [ ] The real mailer replaces the mock in staging [type:manual]\n\n## Context\n\n**Parent**: #{{SPIKE}}\n\n## Dependencies\n\nNone.\n"
    }
  ]
}
```

`node scripts/bootstrap-validate.mjs plan.json` prints `bootstrap-validate: OK (6 issues, 2 milestones)`.

### The dry-run preview

`npx forgedock bootstrap --plan plan.json --dry-run --repo acme/shelf` prints:

```text
## Bootstrap plan preview (dry run: nothing written to GitHub)

Spike: spike: Shelf stack, layout and milestone plan — doc `docs/engineering/technical-spike.md`

### 1. Foundation (`milestone/foundation`, 2 issues)
- scaffold: Next.js app with pnpm and CI
- db: Postgres schema for households, lists and items — depends on SCAFFOLD

### 2. Sharing (`milestone/sharing`, 3 issues)
- lists: Shared list API with live updates — depends on DB
- invites: Email invites to join a household — depends on LISTS_API
- resend: Create the Resend API key and store it [needs-human]

DAG: 5 sub-issues (4 build, 1 needs-human), 3 dependency edges, 2 milestones.
Estimated agent cost: ~$12.00 (4 build issues × $3/issue; needs-human and spike excluded).
```

### Create and hand off

`npx forgedock bootstrap --plan plan.json --repo acme/shelf` creates the backlog and prints the hand-off. The issue numbers below are illustrative:

```text
## Bootstrap hand-off

Spike: #1 spike: Shelf stack, layout and milestone plan — https://github.com/acme/shelf/issues/1

### Created
- #2 scaffold: Next.js app with pnpm and CI — https://github.com/acme/shelf/issues/2
- #3 db: Postgres schema for households, lists and items — https://github.com/acme/shelf/issues/3
- #4 lists: Shared list API with live updates — https://github.com/acme/shelf/issues/4
- #5 invites: Email invites to join a household — https://github.com/acme/shelf/issues/5

### Needs a human
- #6 resend: Create the Resend API key and store it — https://github.com/acme/shelf/issues/6

### Next commands (in build order)
1. /orchestrate milestone "Foundation"
2. /orchestrate milestone "Sharing"
```

Then:

```bash
/orchestrate milestone "Foundation"   # scaffold, then the schema
/orchestrate milestone "Sharing"      # list API, then invites (against the mock mailer until #6 is done)
```

If creation fails halfway, for example at issue #4, re-run `npx forgedock bootstrap --plan plan.json --repo acme/shelf`. Issues #1–#3 are reused and creation carries on from #4.

---

## Next

- [Command Reference: `/bootstrap`](./command-reference.md#bootstrap)
- [How It Works](./how-it-works.md): what `/orchestrate` and `/work-on` do with each issue
- [Troubleshooting & Recovery](./troubleshooting.md)
