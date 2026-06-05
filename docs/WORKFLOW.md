# Workflow Reference

Canonical reference for field IDs, option IDs, and integration constants used by Forge commands.

---

## Project Board Integration

**Project ID**: `PVT_kwHOCx3gR84BSK2L`

All commands that add issues to the GitHub Project board use the field and option IDs below.
Reference this document rather than hardcoding values inline.

### Field IDs

| Field | Field ID |
|-------|----------|
| Status | `PVTSSF_lAHOCx3gR84BSK2Lzg_yF6E` |
| Lane | `PVTSSF_lAHOCx3gR84BSK2Lzg_yF98` |
| Component | `PVTSSF_lAHOCx3gR84BSK2Lzg_yF-o` |
| Priority | `PVTSSF_lAHOCx3gR84BSK2Lzg_yF8o` |
| Workflow | `PVTSSF_lAHOCx3gR84BSK2Lzg_yGAA` |

### Status Field Options (`PVTSSF_lAHOCx3gR84BSK2Lzg_yF6E`)

| Value | Option ID |
|-------|-----------|
| Todo | `f75ad846` |
| In Progress | _(query live if needed)_ |
| Done | `98236657` |

### Lane Field Options (`PVTSSF_lAHOCx3gR84BSK2Lzg_yF98`)

| Value | Option ID |
|-------|-----------|
| Fast | `62864af4` |
| Feature | `4ff6f9e6` |
| Sync | `c0c37d33` |

### Component Field Options (`PVTSSF_lAHOCx3gR84BSK2Lzg_yF-o`)

| Value | Option ID | Repo |
|-------|-----------|------|
| Platform | `214c4d65` | `RapierCraft/AlterLab` |
| MCP Server | _(query live if needed)_ | `RapierCraft/alterlab-mcp-server` |
| n8n Node | _(query live if needed)_ | `RapierCraft/n8n-nodes-alterlab` |
| Python SDK | _(query live if needed)_ | `RapierCraft/alterlab-python` |
| Node SDK | _(query live if needed)_ | `RapierCraft/alterlab-node` |

### Priority Field Options (`PVTSSF_lAHOCx3gR84BSK2Lzg_yF8o`)

| Value | Option ID |
|-------|-----------|
| P0 | _(query live if needed)_ |
| P1 | _(query live if needed)_ |
| P2 | `4d95eef3` |
| P3 | _(query live if needed)_ |

### Workflow Field Options (`PVTSSF_lAHOCx3gR84BSK2Lzg_yGAA`)

| Value | Option ID |
|-------|-----------|
| Investigating | _(query live if needed)_ |
| Building | _(query live if needed)_ |
| In Review | _(query live if needed)_ |
| Merged | `b510c537` |

### Usage Pattern

```bash
# Add issue to project board and set initial fields
ITEM_ID=$(gh project item-add PVT_kwHOCx3gR84BSK2L --owner RapierCraft --url "$ISSUE_URL" --format json --jq '.id')

# Set Status=Todo
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF6E --single-select-option-id f75ad846 2>/dev/null || true

# Set Lane (Fast=62864af4, Feature=4ff6f9e6, Sync=c0c37d33)
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF98 --single-select-option-id 62864af4 2>/dev/null || true

# Set Component=Platform
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF-o --single-select-option-id 214c4d65 2>/dev/null || true

# Set Priority (P2=4d95eef3)
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF8o --single-select-option-id 4d95eef3 2>/dev/null || true

# On merge: set Status=Done and Workflow=Merged
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF6E --single-select-option-id 98236657 2>/dev/null || true
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yGAA --single-select-option-id b510c537 2>/dev/null || true
```

### Querying Unknown Option IDs

For option IDs marked "_(query live if needed)_", use:

```bash
gh project field-list PVT_kwHOCx3gR84BSK2L --owner RapierCraft --format json \
  --jq '.fields[] | select(.name == "Status") | .options'
```
