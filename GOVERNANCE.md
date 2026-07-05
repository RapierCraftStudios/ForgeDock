# ForgeDock Governance

**Copyright (c) RapierCraft Studios. All rights reserved.**

---

## Purpose

This document defines the architectural and licensing boundaries of the ForgeDock open-core model. It describes what is open source (AGPL-3.0), what is proprietary, and how the two interact. This is a statement of design intent, not a legal contract.

---

## Two-Repo Architecture

ForgeDock is built on a two-repo model:

| Repository | License | What it contains |
|---|---|---|
| **[RapierCraftStudios/ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)** (this repo) | AGPL-3.0 | CLI, pipeline commands, installer, forge.yaml schema |
| **Platform repo** (private, separate) | Proprietary | Web dashboard, backend API, billing, team management, analytics |

The two repos are **strictly separate**. The platform repo does not import, embed, or statically link any code from the AGPL-3.0 CLI repo. The only connection between them is the API/data contract described below.

---

## What is Open Source (AGPL-3.0)

Everything in this repository is licensed under AGPL-3.0:

- **Pipeline commands** — `commands/*.md` (work-on, review-pr, orchestrate, quality-gate, etc.)
- **CLI binary** — `bin/forgedock.mjs` and the `npx forgedock` installer
- **Installation scripts** — `install.sh`, `install-codex.sh`, `update.sh`
- **Agent configuration** — `.agents/`, `AGENTS.md`, `forge.yaml.example`
- **Documentation** — all files in this repo not listed under the proprietary section below

The AGPL-3.0 license means: you can use, modify, and redistribute this code for free, including using it to build your own projects. If you modify ForgeDock and offer it as a networked service, the AGPL-3.0 requires you to release your modifications. See [LICENSE](LICENSE) for the full terms.

---

## What is Proprietary

The following components are developed in a separate private repository and are **not** part of this repo's AGPL-3.0 grant:

- The ForgeDock web dashboard (UI for pipeline configuration, issue tracking, analytics)
- The hosted backend API (cloud execution, telemetry, agent orchestration at scale)
- Billing and subscription management (L1–L3 commercial tier infrastructure)
- Team and organization management features
- Any proprietary integrations built on top of the AGPL CLI

These components are governed by separate commercial agreements. They do not appear in this repository and do not affect users running the CLI locally under AGPL-3.0.

---

## The API/Data Contract Boundary

The only connection between the AGPL CLI and the proprietary platform is a well-defined API/data contract:

- The CLI communicates with the platform (when configured) via **HTTP API calls** to documented endpoints.
- No AGPL source code from this repo is compiled into or statically linked with the proprietary platform.
- The contract is defined at the **data layer** — structured JSON payloads, GitHub issue/PR annotations, `forge.yaml` configuration schema.
- The CLI operates fully offline and standalone without any platform connection. The platform is an optional enhancement, not a dependency.

This boundary ensures the proprietary platform remains proprietary. Because no AGPL code is incorporated into the platform, the platform's source code is not subject to AGPL-3.0 copyleft obligations.

---

## Shared Code and the SDK Approach

Occasionally, utility code is useful to both the AGPL CLI and the proprietary platform (e.g., a client library for the API contract, shared type definitions, or common configuration parsers). Such shared code follows this rule:

**Shared utilities are released under a permissive license (MIT or Apache-2.0), never under AGPL-3.0.**

This allows the proprietary platform to use shared utilities without inheriting the copyleft obligation. Permissively licensed shared code lives in a separate SDK repository (or package) — it is not embedded in this AGPL repo.

If a future `@forgedock/sdk` package is published, it will be MIT or Apache-2.0 licensed. This document will be updated to link to it when it exists.

---

## Contribution Licensing

All contributions to this repository are accepted under the terms of:

1. **AGPL-3.0** — the license of this repository
2. **Developer Certificate of Origin (DCO)** — contributors must sign off each commit

The DCO sign-off (`Signed-off-by:` trailer, via `git commit -s`) provides a clear record that the contributor has the right to submit the code under AGPL-3.0. This is required to maintain the dual-licensing model — without it, RapierCraft Studios cannot offer a commercial license that covers contributed code.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full DCO requirement and sign-off instructions.

---

## Dual-Licensing Model

ForgeDock uses a dual-licensing model described in [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md):

- **AGPL-3.0** — free for all uses where copyleft requirements are acceptable
- **Commercial License** — for organizations that need to use ForgeDock in proprietary workflows without AGPL-3.0 copyleft obligations

The dual-license model does not affect the openness of the AGPL core. The commercial license is an exception for customers who cannot meet the AGPL's copyleft requirements — not a restriction on the open-source community.

---

## Governance Decisions

| Decision | Rationale |
|---|---|
| CLI is AGPL-3.0, not MIT | Copyleft ensures commercial users pay for the value they extract from hosted/proprietary use |
| Platform is proprietary, separate repo | Avoids AGPL contamination; keeps the commercial moat intact |
| Boundary is API/data contract only | Static linking AGPL code into proprietary software triggers copyleft; HTTP API calls do not |
| Shared utilities are permissively licensed | Allows platform to use shared code without AGPL obligation |
| DCO required, not CLA | Lightweight contributor grant; provides relicensing rights without a formal agreement |

---

*This document describes design intent and architectural decisions. It is not a legal contract. For licensing questions, contact [support@rapiercraftstudios.com](mailto:support@rapiercraftstudios.com).*
