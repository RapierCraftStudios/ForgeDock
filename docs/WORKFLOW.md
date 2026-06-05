# Workflow Reference

Canonical reference for configuring and querying the GitHub Projects v2 field IDs and option IDs used by ForgeDock commands.

---

## Project Board Integration

ForgeDock commands add issues to a GitHub Projects v2 board and update fields (Status, Lane, Component, Priority, Workflow) as issues move through the pipeline.

**All board IDs are project-specific.** You cannot reuse IDs from another project. Use the discovery commands below to find yours, or run `/forgedock-init` which does this automatically.

---

## Configuration

Project board IDs are stored in `forge.yaml` under the `project_board` section. See [`docs/CONFIG.md`](CONFIG.md#project_board-optional) for the full schema.

```yaml
project_board:
  owner: "your-org"
  project_number: 1
  project_id: "PVT_kwHOxxxxxxxxxxxxxxxx"

  field_ids:
    status: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    lane: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    component: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    priority: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    workflow: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"

  option_ids:
    status:
      todo: "xxxxxxxx"
      in_progress: "xxxxxxxx"
      done: "xxxxxxxx"
    lane:
      fast: "xxxxxxxx"
      feature: "xxxxxxxx"
      sync: "xxxxxxxx"
    priority:
      p0: "xxxxxxxx"
      p1: "xxxxxxxx"
      p2: "xxxxxxxx"
      p3: "xxxxxxxx"
    workflow:
      investigating: "xxxxxxxx"
      building: "xxxxxxxx"
      in_review: "xxxxxxxx"
      merged: "xxxxxxxx"

  components:
    - repo: "your-org/your-repo"
      option_id: "xxxxxxxx"
      label: "Platform"
```

---

## Finding Your IDs

### Step 1 — Find your project number and project ID

```bash
# List all projects owned by your org or user
gh project list --owner <your-org-or-username> --format json \
  | jq '.projects[] | {number: .number, id: .id, title: .title}'
```

The `id` value is your `project_id` (`PVT_...`). The `number` is used in all subsequent queries.

### Step 2 — List field IDs

```bash
gh project field-list <project_number> --owner <your-org-or-username> --format json \
  | jq '.fields[] | {name: .name, id: .id}'
```

Each field's `id` value (`PVTSSF_...`) maps to a key under `field_ids` in your `forge.yaml`.

### Step 3 — List option IDs for single-select fields

```bash
# Get all options for a specific field (e.g. Status)
gh project field-list <project_number> --owner <your-org-or-username> --format json \
  | jq '.fields[] | select(.name == "Status") | .options[] | {name: .name, id: .id}'
```

Repeat for each field (Lane, Priority, Workflow, Component). The 8-character hex IDs are your `option_ids` values.

---

## Automated Setup

Running `/forgedock-init` in Claude Code walks you through the full setup interactively: it queries your project board, extracts all field and option IDs, and writes them to `forge.yaml` automatically.

---

## Usage Pattern

Once IDs are in `forge.yaml`, ForgeDock reads them at runtime. The pattern used by commands:

```bash
# Add issue to project board
ITEM_ID=$(gh project item-add <project_id> --owner <owner> --url "$ISSUE_URL" \
  --format json --jq '.id')

# Set Status field
gh project item-edit --project-id <project_id> --id "$ITEM_ID" \
  --field-id <status_field_id> --single-select-option-id <todo_option_id> \
  2>/dev/null || true

# Set Lane field
gh project item-edit --project-id <project_id> --id "$ITEM_ID" \
  --field-id <lane_field_id> --single-select-option-id <fast_option_id> \
  2>/dev/null || true

# On merge: set Status=Done and Workflow=Merged
gh project item-edit --project-id <project_id> --id "$ITEM_ID" \
  --field-id <status_field_id> --single-select-option-id <done_option_id> \
  2>/dev/null || true
gh project item-edit --project-id <project_id> --id "$ITEM_ID" \
  --field-id <workflow_field_id> --single-select-option-id <merged_option_id> \
  2>/dev/null || true
```

All `<placeholder>` values come from your `forge.yaml` — commands read `forge.yaml` and substitute them at runtime.

---

## Adding a Component Field

The Component field maps each repository in your project to a selectable option. For each repo you track:

1. Create a single-select option in your GitHub project's Component field (via the project UI)
2. Query the new option's ID:
   ```bash
   gh project field-list <project_number> --owner <owner> --format json \
     | jq '.fields[] | select(.name == "Component") | .options[]'
   ```
3. Add an entry under `components` in `forge.yaml`:
   ```yaml
   components:
     - repo: "your-org/your-repo"
       option_id: "xxxxxxxx"
       label: "Platform"
   ```
