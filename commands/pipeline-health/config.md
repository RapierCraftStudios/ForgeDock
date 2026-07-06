---
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Configuration

Read this file at the start of every `/pipeline-health` invocation, before Phase 1.

## Config

Read project identity from `forge.yaml` before running any phase:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq e '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
# FORGE_REPO: the self-pipeline repo where pipeline-health issues are filed.
# Set project.forge_repo in forge.yaml if your pipeline repo differs from GH_REPO.
# Example: project:
#            forge_repo: "my-org/my-forge"
FORGE_REPO=$(yq '.project.forge_repo // ""' "$CONFIG_FILE")
[ -z "$FORGE_REPO" ] && FORGE_REPO="$GH_REPO"
FORGE_HOME=$(yq e '.paths.root' "$CONFIG_FILE")
echo "Forge repo: $FORGE_REPO"
echo "Forge home: $FORGE_HOME"
```

**FORGE_HOME**: `$FORGE_HOME` (set from `forge.yaml` → `paths.root`)
**This command is READ-ONLY on the target project.** It creates issues in the Forge repo only.

---

