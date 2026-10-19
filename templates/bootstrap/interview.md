<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# /bootstrap interview question bank

Ask conversationally and keep it short: skip any aspect the user's free text or docs already answer. Every aspect left
unanswered gets the **Default** and its rationale, tied to what the user did say, in the "Here's what I assumed" summary.
Aspects marked **Doubt** change architecture or cost. When the answer is unclear, ask them as multiple-choice questions
(at most 4 per batch, each with a recommended option). All other aspects default silently.

| # | Aspect | Question | Default (rationale pattern) | Doubt? |
|---|--------|----------|-----------------------------|--------|
| 1 | Users and segments | Who uses it, and which segments differ in what they need? | One primary segment from the pitch; admins as a second role (most products need an operator view) | no |
| 2 | Core jobs and features | What must a user be able to do on day one? | The jobs named in the pitch, each as a feature with its happy path | no |
| 3 | Scope | MVP first, or the full product? | MVP, full product as later milestones (cheapest path to feedback) | yes, when the pitch lists many features |
| 4 | Platforms | Web, mobile, desktop? | Responsive web (one codebase covers phones) | yes: mobile native vs PWA |
| 5 | Stack | Any language, framework or hosting preferences? | The closest preset in `stack-profiles.md` | no, unless the user names conflicting stacks |
| 6 | Auth | How do users sign in? | Email magic link + Google sign-in (lowest friction, no password storage) | no |
| 7 | Data and tenancy | Is data shared between organisations? | Postgres + row-level security for multi-tenant SaaS; single-tenant otherwise | yes: self-host vs managed DB |
| 8 | Integrations | Which external services? | A mock provider per credentialed integration so dev and CI stay green | no |
| 9 | Payments | Do you charge, and how? | Stripe subscriptions behind a mock in dev (most common, test mode is free) | yes, when pricing is unclear |
| 10 | i18n | Which languages and locales? | English with i18n-ready strings (cheap now, expensive later) | no |
| 11 | Compliance and residency | Any regulation (GDPR, HIPAA, DPDP) or data-residency rule? | Privacy by default (minimal PII, encrypted at rest); region of the primary market | yes: data residency |
| 12 | Design ambition and UI libraries | Polished brand or functional? Any UI library? | Accessible component library (e.g. shadcn/ui) plus a design-token theme; hero surfaces go to `/design` | no |
| 13 | Deployment target | VPS, Cloudflare or a cloud provider? | The stack preset's target with a staging-branch flow (staging -> main) | yes: when the cost profile differs |
| 14 | Scale | Users and data in year one? | Small (hundreds of users): one region, one DB, a scale path in the spike | no |
| 15 | Budget | Monthly infra budget? | Free or hobby tiers until launch | no |
| 16 | Team | Who builds and reviews? | A solo builder with ForgeDock agents | no |
| 17 | Timeline | Any hard date? | None: milestones in build order | no |

Always a doubt: the **product name** and the **repo owner** (user or org; the owner must be covered by the ForgeDock
GitHub App installation).

Guardrails and domain rules (e.g. "no auto-send", "India-only data residency") go into the plan's `guardrails` and
`domainRules`. bootstrap-create.mjs copies them into every issue's Context.
