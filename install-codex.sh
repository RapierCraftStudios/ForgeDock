#!/bin/bash
# RapierCraft Forge — Install Codex Skills
#
# Generates namespaced Codex skills from the shared Forge command specs without
# disturbing the existing Claude install path or unrelated global Codex skills.

set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"
TARGET_ROOT="$HOME/.codex/skills"

echo "RapierCraft Forge — Installing Codex skills"
echo "  Source: $FORGE_HOME/commands/"
echo "  Target: $TARGET_ROOT/"
echo ""

mkdir -p "$TARGET_ROOT"

INSTALLED=0
UPDATED=0
ROUTER_STATUS="installed"

extract_description() {
    local file="$1"
    awk '
        /^description:[[:space:]]*/ {
            sub(/^description:[[:space:]]*/, "", $0)
            gsub(/^"/, "", $0)
            gsub(/"$/, "", $0)
            print
            exit
        }
    ' "$file"
}

command_id_from_rel() {
    local rel="$1"
    local id="${rel%.md}"
    id="${id//\//:}"
    printf '%s' "$id"
}

skill_name_from_rel() {
    local rel="$1"
    local name="${rel%.md}"
    name="${name//\//-}"
    printf 'forge-%s' "$name"
}

repo_local_skill_path_from_rel() {
    local rel="$1"
    printf '%s/.agents/skills/%s/SKILL.md' "$FORGE_HOME" "${rel%.md}"
}

write_repo_local_wrapper() {
    local skill_name="$1"
    local description="$2"
    local target_file="$3"
    local local_skill_path="$4"
    local description_escaped
    description_escaped="${description//\\/\\\\}"
    description_escaped="${description_escaped//\"/\\\"}"

    cat >"$target_file" <<EOF
---
name: $skill_name
description: "$description_escaped"
---

# Forge Codex Adapter: $skill_name

This Codex skill adopts the repo-local workflow at \`$local_skill_path\`.

When this skill triggers:

1. Read the repo-local skill above and treat it as the authoritative workflow.
2. Read only the extra repo files that local skill explicitly references and only when needed.
3. Translate repo tool assumptions to Codex-native execution:
   - \`Task(...)\` or \`Agent(...)\` -> Codex sub-agents only when the local skill explicitly benefits from orchestration or parallel execution.
   - \`Bash\`, \`Read\`, \`Grep\`, \`Glob\` -> Codex shell/file tools with \`gh\`, \`git\`, \`rg\`, \`sed\`, \`find\`, and repo scripts.
   - \`WebFetch\` -> web tooling or API calls via \`gh\` / \`curl\`.
   - nested \`Skill("...")\` references -> the corresponding installed \`forge-*\` skill when available, otherwise continue manually from the referenced source file.
4. Follow \`$FORGE_HOME/AGENTS.md\` and \`$FORGE_HOME/docs/CODEX.md\` before making changes.
5. Preserve Forge behavior across runtimes: labels, machine-readable comments, branch/worktree conventions, and changelog discipline stay intact unless the local skill explicitly overrides a repo-specific assumption.

Default execution rule: prefer the repo-local skill over the generic generated wrapper.
EOF
}

write_skill_file() {
    local skill_name="$1"
    local description="$2"
    local rel="$3"
    local src="$4"
    local target_file="$5"
    local command_id
    local description_escaped
    command_id="$(command_id_from_rel "$rel")"
    description_escaped="${description//\\/\\\\}"
    description_escaped="${description_escaped//\"/\\\"}"

    cat >"$target_file" <<EOF
---
name: $skill_name
description: "$description_escaped"
---

# Forge Codex Adapter: $command_id

This Codex skill adapts the Forge workflow spec at \`$src\`.

When this skill triggers:

1. Read \`$src\` and treat it as the authoritative workflow.
2. Read only the extra files that workflow explicitly references and only when needed.
3. Translate runtime assumptions to Codex-native execution:
   - Claude slash-command invocation -> this installed \`$skill_name\` skill.
   - \`Skill("x")\` -> use the corresponding installed Forge skill when available. Map names by prefixing with \`forge-\` and replacing \`:\` and \`/\` with \`-\`.
   - \`Agent(...)\` or \`Task(...)\` -> Codex sub-agents only when the source workflow explicitly benefits from orchestration or parallel execution.
   - \`Bash\`, \`Read\`, \`Grep\`, \`Glob\` -> Codex shell/file tools with \`gh\`, \`git\`, \`rg\`, \`sed\`, \`find\`, and repo scripts.
   - \`WebFetch\` -> web tooling or API calls via \`gh\` / \`curl\`.
4. Follow \`$FORGE_HOME/AGENTS.md\` and \`$FORGE_HOME/docs/CODEX.md\` before making changes.
5. Preserve Forge behavior across runtimes: GitHub labels/comments/state-machine flow, branch/worktree conventions, and changelog discipline stay the same.
6. If the source assumes a Claude-only affordance, state the gap briefly and continue with the closest Codex-native path instead of silently skipping workflow steps.

Default execution rule: prefer the shared Forge command spec over inventing an ad-hoc Codex-only workflow.
EOF
}

install_skill() {
    local rel="$1"
    local src="$FORGE_HOME/commands/$rel"
    local skill_name
    local description
    local target_dir
    local target_file
    local local_skill_path
    local before=""

    skill_name="$(skill_name_from_rel "$rel")"
    description="$(extract_description "$src")"
    if [ -z "$description" ]; then
        description="Codex adapter for Forge command $rel"
    fi

    target_dir="$TARGET_ROOT/$skill_name"
    target_file="$target_dir/SKILL.md"
    mkdir -p "$target_dir"
    local_skill_path="$(repo_local_skill_path_from_rel "$rel")"

    if [ -f "$target_file" ]; then
        before="$(cat "$target_file")"
    fi

    if [ -f "$local_skill_path" ]; then
        write_repo_local_wrapper "$skill_name" "$description" "$target_file" "$local_skill_path"
    else
        write_skill_file "$skill_name" "$description" "$rel" "$src" "$target_file"
    fi

    if [ -n "$before" ]; then
        if [ "$before" != "$(cat "$target_file")" ]; then
            echo "  Updated: $skill_name"
            UPDATED=$((UPDATED + 1))
        fi
    else
        echo "  Installed: $skill_name"
        INSTALLED=$((INSTALLED + 1))
    fi
}

write_router_skill() {
    local target_dir="$TARGET_ROOT/forge"
    local target_file="$target_dir/SKILL.md"
    local before=""
    mkdir -p "$target_dir"

    if [ -f "$target_file" ]; then
        before="$(cat "$target_file")"
    fi

    cat >"$target_file" <<EOF
---
name: forge
description: "Route Codex work into the right installed Forge skill while preserving the shared Forge workflow model."
---

# Forge Router

Use this skill when the user asks to operate Forge from Codex and the exact command is not yet obvious.

Routing rules:
- issue execution / build / merge pipeline -> \`forge-work-on\`
- PR review -> \`forge-review-pr\`
- multi-issue parallel dispatch -> \`forge-orchestrate\`
- milestone lifecycle -> \`forge-milestone\`
- pre-commit defect scan -> \`forge-quality-gate\`
- validation / issue verification -> \`forge-validate\`
- analytics / audit / ops workflows -> the matching installed \`forge-*\` skill

Execution rules:
1. Read \`$FORGE_HOME/AGENTS.md\`, \`$FORGE_HOME/docs/CODEX.md\`, and the relevant file under \`$FORGE_HOME/commands/\`.
2. Choose the narrowest matching installed Forge skill instead of improvising.
3. Preserve Forge invariants: GitHub is the state source of truth, structured comments remain machine-readable, and Claude behavior is not regressed by Codex-specific work.
4. If a workflow references a nested command or catalog file, continue by reading the referenced source file directly or by using the corresponding installed \`forge-*\` skill if one exists.
EOF

    if [ -n "$before" ] && [ "$before" = "$(cat "$target_file")" ]; then
        ROUTER_STATUS="unchanged"
    elif [ -n "$before" ]; then
        ROUTER_STATUS="updated"
    else
        ROUTER_STATUS="installed"
    fi
}

while IFS= read -r src; do
    rel="${src#"$FORGE_HOME/commands/"}"
    case "$rel" in
        review-pr-agents.md)
            continue
            ;;
    esac
    install_skill "$rel"
done < <(find "$FORGE_HOME/commands" -name "*.md" | sort)

write_router_skill

echo ""
echo "Done. Installed: $INSTALLED, Updated: $UPDATED"
echo ""
echo "Router skill: $ROUTER_STATUS"
echo ""
echo "Codex-native Forge skills are now available under ~/.codex/skills/"
echo "Use the \`forge\` router skill or a specific \`forge-*\` skill."
echo "Reference: $FORGE_HOME/docs/CODEX.md"

mkdir -p "$FORGE_HOME/.codex/worktrees"

PROFILE_UPDATED=0
for profile in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$profile" ] && ! grep -q "FORGE_HOME" "$profile" 2>/dev/null; then
        echo "" >> "$profile"
        echo "# RapierCraft Forge — autonomous development pipeline" >> "$profile"
        echo "export FORGE_HOME=\"$FORGE_HOME\"" >> "$profile"
        echo "Added FORGE_HOME to $profile"
        PROFILE_UPDATED=$((PROFILE_UPDATED + 1))
    fi
done

if [ "$PROFILE_UPDATED" -gt 0 ]; then
    echo ""
    echo "Restart your shell or run:"
    echo "  export FORGE_HOME=\"$FORGE_HOME\""
fi

if [ -f "$HOME/.codex/config.toml" ] && ! grep -Fq "[projects.\"$FORGE_HOME\"]" "$HOME/.codex/config.toml"; then
    echo ""
    echo "Reminder: Codex may require this repo to be trusted."
    echo "Add the following to ~/.codex/config.toml if needed:"
    echo "  [projects.\"$FORGE_HOME\"]"
    echo "  trust_level = \"trusted\""
fi
