---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Shared Config Resolution

Canonical core `forge.yaml` resolution block, read once per command spec
instead of restated inline. **Normative for**: `check-protocol-restatements.sh`.

**Scope**: only `GH_REPO`/`GH_FLAG`/`REPO_PATH` — resolved identically
everywhere. `STAGING_BRANCH`, `DEFAULT_BRANCH`, project-board IDs, and other
command-specific fields vary in fallback syntax and stay declared locally,
immediately after the pointer to this file.

## Core resolution block

Before executing any phase, read `forge.yaml` to resolve the repo identity:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: forge.yaml not found."
  echo "Run first: npx forgedock init"
  exit 1
fi

GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
```

All `{GH_REPO}`, `{GH_FLAG}`, and `{REPO_PATH}` references in the calling
command are populated from this block. Commands typically resolve
`STAGING_BRANCH`/`DEFAULT_BRANCH` and other fields immediately after this
block — those stay local since their fallback syntax (`// "staging"`,
`2>/dev/null`, etc.) varies per command.

## Usage

A command spec whose Config Resolution section opens with this exact 3-line
block replaces it with:

> Config resolution: see `commands/shared/config-resolution.md` if not already in context — resolves `GH_REPO`, `GH_FLAG`, `REPO_PATH` from `forge.yaml`.

...then keeps every line that followed the block (`STAGING_BRANCH`,
project-specific fields, etc.) exactly as it was, unchanged.
