<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- /bootstrap build-issue body (Pipeline Issue Template). Copy from "## Problem" down; drop the UI block for
non-UI issues and the hero line for non-hero issues. Plan flags: "ui": true needs the full design spec, "hero": true
needs the /design line (scripts/bootstrap-validate.mjs). Reference other plan issues as #{{KEY}}. -->
## Problem

{what this issue delivers and for whom, one paragraph}

## Root Cause (if known)

Greenfield: not built yet. {spike section this implements}

## Affected Files

1. `{planned/path/file.ext}` — new
2. `{planned/path/other.ext}` — new

## Acceptance Criteria

- [ ] {observable behaviour} [type:unit]
- [ ] {API or integration behaviour} [type:api]
- [ ] {user-visible flow} [type:e2e]

### Design spec (UI issues)

- **Breakpoints**: {mobile 360, tablet 768, desktop 1280: layout at each}
- **States**: empty state {copy and action}; loading state {skeleton}; error state {message and retry}; offline state {cached view or banner}
- **Motion**: {transitions and durations; respects prefers-reduced-motion}
- **Accessibility**: {WCAG 2.2 AA: focus order, labels, contrast, keyboard paths}
- **Dark mode**: {token mapping; verified in both themes}
- **Hero surface**: route the visual design to `/design` before building this page.

## Context

**Parent**: #{{SPIKE}}
Spike: `docs/engineering/technical-spike.md` § {section}
{real credentials: see #{{NEEDS_HUMAN_KEY}}; until then the mock provider is used, so this issue never depends on it}

## Dependencies

Depends on #{{DEP_KEY}} — {why}
