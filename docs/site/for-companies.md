---
title: "ForgeDock for Companies"
description: "Commercial licensing, the fleet layer, design-partner program, and procurement facts for organizations evaluating ForgeDock."
keywords: ["forgedock enterprise", "forgedock commercial license", "forgedock fleet layer", "design partner", "agpl commercial"]
---

# ForgeDock for Companies

ForgeDock's open-source core — the pipeline commands, CLI installer, and all code in this repository — is licensed under AGPL-3.0 and stays that way. Engineers run the full pipeline on their own Claude account, forever free.

This page answers the questions that come up when an organization considers ForgeDock for team-wide or production use.

---

## AGPL-3.0 vs. Commercial License

The AGPL-3.0 license is broad but has one specific trigger: **network-use copyleft**. If you run a modified version of ForgeDock as a service that others access over a network, the AGPL requires you to publish your modifications under the same license.

Use this table to determine which license you need:

| Scenario | License needed |
|----------|---------------|
| Individual engineer running ForgeDock on their own repos | **AGPL-3.0 — free** |
| Team running ForgeDock internally, no external users, comfortable with AGPL | **AGPL-3.0 — free** |
| Organization contributing modifications back under AGPL-3.0 | **AGPL-3.0 — free** |
| Organization integrating ForgeDock into a proprietary internal tool and cannot open-source the integration | **Commercial license required** |
| Building a SaaS or hosted product on top of ForgeDock and cannot release derivative source | **Commercial license required** |
| Organization whose legal policy prohibits AGPL-licensed software in certain contexts | **Commercial license required** |
| Want enterprise terms: support SLA, indemnification, or audit rights | **Commercial license required** |

Key clarification: ForgeDock is a **development tool**, not a library embedded in your product. Simply using ForgeDock to build and ship your own software does not trigger the copyleft clause — the clause applies when you modify ForgeDock itself and offer it as a service to others.

For the full license text, see [`LICENSE`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/LICENSE) (AGPL-3.0) and [`COMMERCIAL-LICENSE.md`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/COMMERCIAL-LICENSE.md).

---

## The Fleet Layer *(in development)*

The open-source pipeline runs one repo at a time, driven by individual engineers. The fleet layer extends this to the organization level. It is built on the same `FORGE:STATE` and `FORGE:TRAJECTORY` annotation data that the open-source pipeline already writes.

**What the fleet layer includes:**

- **Org-wide run observability** — a single view across all repos showing every pipeline run, its phase, and its outcome. The same structured annotation data you can already query with `gh` today, surfaced in one place.
- **Policy controls** — configure which issue labels, branches, or repositories require human approval before the pipeline merges a PR.
- **Audit-grade provenance** — a signed, queryable record of every autonomous change: what ran, on which issue, from which commit, and whether a human reviewed it.

**Availability status**: The fleet layer is in active development in a private repository. It is **not yet shipped**. No production customers are running it. The design-partner program (below) is how we onboard the first organizations.

---

## Design-Partner Program

We are onboarding a small group of organizations as design partners for the fleet layer. Design partners get:

- **Early access** to the fleet layer as it ships, starting with read-only observability
- **Direct roadmap influence** — your org's use cases shape the policy controls and audit features
- **Favorable commercial terms** locked in before general availability

Design partnership is appropriate for organizations that are already running ForgeDock in production (or want to start) and have a concrete need for org-level visibility or governance over autonomous merges.

**To apply**: [Open a design-partner intake request](https://github.com/RapierCraftStudios/ForgeDock/issues/new?template=design-partner.yml) on GitHub, or email [support@rapiercraftstudios.com](mailto:support@rapiercraftstudios.com) directly.

---

## Procurement Facts

Questions procurement teams typically ask, answered directly:

**Does ForgeDock run on our infrastructure or yours?**
ForgeDock runs entirely on your own environment. There is no ForgeDock-operated compute, API proxy, or data relay. The pipeline commands run inside your Claude Code session on your machine, calling the Anthropic API directly with your credentials.

**Where does pipeline state live?**
All pipeline state lives in your GitHub repository: issue comments (FORGE annotations), PR descriptions, and workflow labels. ForgeDock writes nothing to any external system. You own the data; you can query or delete it with standard GitHub tools.

**Do you have access to our code or GitHub data?**
No. ForgeDock has no server-side component that could receive your code or GitHub data. The `npx forgedock` installer symlinks command files into `~/.claude/commands/` on the developer's machine — it does not phone home.

**How are contributions governed?**
All contributors sign a Developer Certificate of Origin (DCO) on each commit. ForgeDock does not use a CLA. See [`CONTRIBUTING.md`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/CONTRIBUTING.md) for the full process.

**Security policy?**
See [`SECURITY.md`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/SECURITY.md) for the vulnerability disclosure policy and contact.

**Governance?**
See [`GOVERNANCE.md`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/GOVERNANCE.md) for the project's decision-making process and stewardship model.

---

## Contact

Commercial licensing, design-partner applications, and enterprise inquiries:

- **Email**: [support@rapiercraftstudios.com](mailto:support@rapiercraftstudios.com)
- **Design-partner intake form**: [Open an intake request on GitHub](https://github.com/RapierCraftStudios/ForgeDock/issues/new?template=design-partner.yml)
- **Sponsors / early access**: [github.com/sponsors/RapierCraftStudios](https://github.com/sponsors/RapierCraftStudios)
