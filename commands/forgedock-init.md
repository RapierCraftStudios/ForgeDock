---
description: init-enrich skill backend — consumes a ConfigDraft, deeply infers hard sections from codebase + GitHub, returns enriched ConfigDraft with raised confidences
argument-hint: <ConfigDraft JSON>
---

# /forgedock-init — init-enrich Skill Backend

**Input**: $ARGUMENTS

You are the **init-enrich skill backend** for ForgeDock's intelligent onboarding pipeline. You consume a `ConfigDraft` JSON object produced by `init-detect`, deeply infer the hard sections (`project_board`, `repos.satellites`, `review`, `verification`) by scanning the codebase and querying GitHub, and return an enriched `ConfigDraft` with the same leaf shape and raised confidences.

**This is a backend, not a wizard.** You MUST NOT ask the user any interactive questions. You MUST NOT write any files. Unknowable items are represented as `low`-confidence TODO-flagged fields — never as blocking prompts.

**Agent model policy**: Default `model: "sonnet"`. Fallback: `model: "opus"` if Sonnet is rate-limited.
**NEVER use plan mode (EnterPlanMode).**

---

## ConfigDraft Contract

Every leaf in a `ConfigDraft` has the shape:

```json
{ "value": "<string>", "confidence": "high|medium|low", "source": "<string>", "why": "<string>" }
```

Confidence levels:
- `high` — verified from a concrete, unambiguous source
- `medium` — inferred from available signals; likely correct
- `low` — guessed default or not found; caller should surface as a `# TODO(forgedock:<field>)` flag

This skill extends the draft by adding optional section fields. It never removes or downgrades existing fields. Required sections (project, paths, branches) are passed through unchanged.

---

## Phase 0: Parse Input and Extract Identity

### 0A: Parse ConfigDraft from $ARGUMENTS

`$ARGUMENTS` contains a ConfigDraft JSON string. Parse it:

```
DRAFT = JSON.parse($ARGUMENTS)
```

If `$ARGUMENTS` is empty or not valid JSON, output an error and exit:

```
Error: /forgedock-init expects a ConfigDraft JSON string as its argument.

Usage:
  The init-detect module produces the ConfigDraft. Example:
    node -e "import('./bin/init-detect.mjs').then(m => m.detectConfig()).then(d => console.log(JSON.stringify(d)))"

  Pass the output as the argument to /forgedock-init.
```

### 0B: Extract identity fields

Extract these from the incoming draft for use in all GitHub queries:

```
OWNER     = DRAFT.project.owner.value       # GitHub org or username
REPO      = DRAFT.project.repo.value        # Repository name
REPO_ROOT = DRAFT.paths.root.value          # Absolute path to repo root
```

Validate that OWNER and REPO are non-empty and not placeholder values before proceeding with any GitHub queries:

```
if OWNER is empty or equals "your-github-org":
  set OWNER = null  # GitHub queries will be skipped
  note: "project.owner is a placeholder — board and satellite enrichment skipped"

if REPO is empty or equals "your-repo-name":
  set REPO = null
  note: "project.repo is a placeholder — satellite enrichment skipped"
```

These are non-blocking — an incomplete draft still gets codebase enrichment (review, verification).

### 0C: Check GitHub auth

```bash
gh auth status 2>&1
```

Set `GH_AUTHED = true` if the output does NOT contain "not logged in" or "You are not logged into". Set `GH_AUTHED = false` otherwise.

If `GH_AUTHED = false` or `OWNER = null`: GitHub-dependent enrichment phases (1, 2) will be skipped; their fields will be set to `low` confidence with a TODO. Codebase-only phases (3, 4) still run.

---

## Phase 1: Enrich project_board

**Skip if**: `GH_AUTHED = false` or `OWNER = null`.

### 1A: Discover project boards

```bash
gh project list --owner "$OWNER" --format json 2>/dev/null \
  | jq '[.projects[] | {number: .number, title: .title, id: .id}]'
```

If the query fails or returns an empty list: skip Phase 1 entirely. Add a `low`-confidence placeholder for the entire `project_board` section (see 1E).

If one project is found: select it automatically (high confidence — no ambiguity).
If multiple projects are found: select the first one (medium confidence — note that the first result may not be the right project board).

Record:
```
PROJECT_NUMBER = first (or only) project number
PROJECT_TITLE  = project title
PROJECT_ID     = project id (the PVT_... node ID)
```

### 1B: Fetch field definitions

```bash
gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json 2>/dev/null \
  | jq '[.fields[] | {name: .name, id: .id, type: .type, options: (.options // [])}]'
```

If the query fails: skip Phase 1, emit low-confidence placeholder.

### 1C: Map fields to ForgeDock slots

For each of the five ForgeDock field slots, search the field list case-insensitively:

| ForgeDock slot | Primary match | Fallback match |
|----------------|---------------|----------------|
| `status` | "Status" | "State" |
| `lane` | "Lane" | "Track", "Type" |
| `component` | "Component" | "Area", "Team" |
| `priority` | "Priority" | "Severity" |
| `workflow` | "Workflow" | "Stage", "Phase" |

For each slot:
- If a field is found: confidence = `high`, source = `gh project field-list`, why = `Field named "<name>" (id: <id>) found in project "<PROJECT_TITLE>"`
- If no field matches: confidence = `low`, value = `""`, why = `No field matching "<slot>" found in project "<PROJECT_TITLE>"; add a field with this name and re-run /forgedock-init`

### 1D: Map option IDs

For each single-select field that was successfully mapped, extract its option IDs.

For each of the required option slots, match case-insensitively:

**status options**: "Todo" / "To Do" → `todo`; "In Progress" / "In-Progress" → `in_progress`; "Done" / "Complete" → `done`

**lane options**: "Fast" / "Fast Lane" → `fast`; "Feature" / "Feature Lane" → `feature`; "Sync" → `sync`

**priority options**: "P0" / "Critical" → `p0`; "P1" / "High" → `p1`; "P2" / "Medium" → `p2`; "P3" / "Low" → `p3`

**workflow options**: "Investigating" → `investigating`; "Building" → `building`; "In Review" / "In-Review" → `in_review`; "Merged" / "Complete" → `merged`

For each option:
- If matched: confidence = `high`, source = `gh project field-list (options)`, why = `Option "<name>" (id: <id>) found in field "<field_name>"`
- If not matched: confidence = `low`, value = `""`, why = `No option matching "<slot>" found in field "<field_name>"; add the option or set this value manually`

### 1E: Build project_board enrichment

Assemble the enriched `project_board` section of the draft. If Phase 1 was skipped entirely:

```json
"project_board": {
  "owner":          { "value": "", "confidence": "low", "source": "skipped", "why": "GitHub auth unavailable or project.owner is a placeholder; run gh auth login then re-run /forgedock-init" },
  "project_number": { "value": "", "confidence": "low", "source": "skipped", "why": "GitHub auth unavailable; project board not queried" },
  "project_id":     { "value": "", "confidence": "low", "source": "skipped", "why": "GitHub auth unavailable; obtain via: gh project list --owner <owner> --format json | jq '.projects[] | .id' (value must start with PVT_)" },
  "field_ids":      { ... all slots at low confidence ... },
  "option_ids":     { ... all option slots at low confidence ... }
}
```

**Important**: `project_board.project_id` must be a GitHub Projects v2 node ID with the `PVT_` prefix (e.g. `PVT_kwHOxxxxxxxxxxxxxxxx`). When emitting this field at high confidence, always include a note in `why` reminding the caller of this format requirement.

---

## Phase 2: Enrich repos.satellites

**Skip if**: `GH_AUTHED = false` or `OWNER = null` or `REPO = null`.

### 2A: List sibling repos

```bash
gh repo list "$OWNER" --limit 50 --json name,description,primaryLanguage 2>/dev/null \
  | jq '[.[] | select(.name != "'"$REPO"'") | {name: .name, description: (.description // ""), language: (.primaryLanguage.name // "")}]'
```

If the query fails or returns empty: skip Phase 2, emit low-confidence placeholder.

### 2B: Infer satellite candidates

For each sibling repo, apply heuristics to determine if it looks like a ForgeDock satellite (i.e., a repo the user might want to route issues to with a short prefix):

**Include as a satellite candidate if any of these match**:
- Name ends with `-sdk`, `-api`, `-mcp`, `-cli`, `-server`, `-worker`, `-plugin`
- Name contains `sdk`, `client`, `plugin`, `extension`, `lib`
- Description mentions "companion", "client for", "SDK for", "plugin for", "server for"

**Exclude**:
- Names that are clearly personal/fork repos (contain the word "fork", start with the owner name exactly)
- Repos with zero description and language = null (likely empty/template repos)

For each candidate, derive a prefix:
- Strip the `$OWNER-` prefix from the name if present (e.g. `acme-mcp-server` → `mcp-server`)
- Take the first word before any `-` (e.g. `mcp-server` → `mcp`)
- If the prefix conflicts with another candidate, use the first two words

### 2C: Build repos enrichment

For each satellite candidate:

```json
{
  "prefix":    { "value": "<derived-prefix>", "confidence": "medium", "source": "gh repo list + name heuristic", "why": "Repo '<name>' looks like a satellite (name pattern: <pattern>); verify prefix is correct" },
  "repo":      { "value": "<owner>/<name>",  "confidence": "high",   "source": "gh repo list", "why": "Repo exists under owner <owner>" },
  "staging_branch": { "value": "main", "confidence": "low", "source": "default", "why": "Could not verify staging branch without reading satellite repo; defaulting to 'main'" }
}
```

If no candidates found:

```json
"repos": {
  "satellites": [],
  "_enrichment_note": { "value": "none", "confidence": "low", "source": "gh repo list", "why": "No repos under <owner> matched satellite heuristics; if satellites exist, add them manually to forge.yaml" }
}
```

---

## Phase 3: Enrich review

**Always runs** — does not require GitHub auth.

### 3A: Detect tech stack

For each supported ecosystem, check for its manifest file under `$REPO_ROOT`:

**Node.js / TypeScript**:
```bash
if [ -f "$REPO_ROOT/package.json" ]; then
  # Extract name, framework dependencies
  cat "$REPO_ROOT/package.json" | jq '{
    name: .name,
    deps: ((.dependencies // {}) + (.devDependencies // {})) | keys | map(select(
      test("next|react|vue|nuxt|svelte|express|fastify|hono|nest|koa|astro|remix|gatsby|vite|esbuild|rollup|webpack|prisma|drizzle|sequelize|typeorm|mongoose")
    ))
  }'
fi
```

**Python**:
```bash
[ -f "$REPO_ROOT/pyproject.toml" ] && grep -E "^(name|requires-python)" "$REPO_ROOT/pyproject.toml" | head -5
[ -f "$REPO_ROOT/pyproject.toml" ] && grep -E "fastapi|django|flask|starlette|sqlalchemy|pydantic|alembic|celery|aiohttp" "$REPO_ROOT/pyproject.toml" | head -10
[ -f "$REPO_ROOT/requirements.txt" ] && grep -iE "fastapi|django|flask|starlette|sqlalchemy|pydantic|alembic|celery|aiohttp" "$REPO_ROOT/requirements.txt" | head -10
```

**Rust**:
```bash
[ -f "$REPO_ROOT/Cargo.toml" ] && grep -E "^name|axum|actix|rocket|tokio|serde|sqlx" "$REPO_ROOT/Cargo.toml" | head -10
```

**Go**:
```bash
[ -f "$REPO_ROOT/go.mod" ] && head -10 "$REPO_ROOT/go.mod"
```

**Ruby**:
```bash
[ -f "$REPO_ROOT/Gemfile" ] && grep -E "rails|sinatra|roda|hanami|sidekiq" "$REPO_ROOT/Gemfile" | head -5
```

**Docker / infrastructure**:
```bash
ls "$REPO_ROOT"/docker-compose*.yml 2>/dev/null | head -5
[ -f "$REPO_ROOT/Dockerfile" ] && head -5 "$REPO_ROOT/Dockerfile"
```

Build a concise `TECH_STACK` string from the detected components, e.g. "Next.js 15, FastAPI, PostgreSQL 16, Docker". If multiple ecosystems are detected, list all. If nothing is detected, set `TECH_STACK = ""`.

**Confidence**:
- One or more manifest files found → `medium` (detected from deps but not verified running)
- Nothing detected → `low`

### 3B: Extract project context

```bash
# Primary: CLAUDE.md
if [ -f "$REPO_ROOT/CLAUDE.md" ]; then
  cat "$REPO_ROOT/CLAUDE.md"
fi

# Fallback: README.md (first 80 lines)
if [ ! -f "$REPO_ROOT/CLAUDE.md" ] && [ -f "$REPO_ROOT/README.md" ]; then
  head -80 "$REPO_ROOT/README.md"
fi
```

From the content, synthesize a 2–4 sentence `REVIEW_CONTEXT` that captures:
- What the project does
- Its architecture (if mentioned)
- Any deploy or infrastructure notes relevant to a code reviewer
- Known conventions or pitfalls (if mentioned)

If neither CLAUDE.md nor README.md exists: `REVIEW_CONTEXT = ""` at low confidence.

**Confidence**:
- Synthesized from CLAUDE.md → `high`
- Synthesized from README.md → `medium`
- No source found → `low`

### 3C: Build review enrichment

```json
"review": {
  "tech_stack": { "value": "<TECH_STACK>", "confidence": "<high|medium|low>", "source": "<manifest files found>", "why": "<what was detected>" },
  "context":    { "value": "<REVIEW_CONTEXT>", "confidence": "<high|medium|low>", "source": "<CLAUDE.md|README.md|none>", "why": "<synthesis note>" }
}
```

---

## Phase 4: Enrich verification

**Always runs** — does not require GitHub auth.

### 4A: Detect health endpoint

```bash
# Search for health route definitions in server code
grep -rn "health\|/ping\|/status" "$REPO_ROOT" \
  --include="*.py" --include="*.ts" --include="*.tsx" --include="*.go" --include="*.rs" --include="*.rb" \
  -l 2>/dev/null | head -10

# Look for healthcheck patterns in compose/config files
grep -rn "healthcheck\|HEALTH_URL\|health_endpoint\|/health" \
  "$REPO_ROOT" --include="*.yml" --include="*.yaml" --include="*.env*" \
  -l 2>/dev/null | head -5
```

From the results, infer the most likely health endpoint path:
- If a route like `GET /health` or `GET /ping` is found → use that path
- If a docker-compose healthcheck URL is found → extract the host:port+path
- If docker-compose has a `services.api` block → infer `http://localhost:<port>/health`

If an endpoint can be inferred:
```json
{ "value": "https://api.<detected-or-inferred-host>/<path>", "confidence": "medium", "source": "<file where found>", "why": "Health route found at <file>:<line>" }
```

If no endpoint found:
```json
{ "value": "", "confidence": "low", "source": "codebase scan", "why": "No health route detected; set this to the URL of your API's health endpoint" }
```

### 4B: Detect container names and service patterns

```bash
for f in "$REPO_ROOT"/docker-compose*.yml; do
  [ -f "$f" ] || continue
  grep -E "^\s+container_name:" "$f" | head -20
done
```

Extract the common prefix from all container names (e.g., `acme-api`, `acme-worker` → prefix `acme-`).

If container names are found:
```json
{ "value": "<prefix>", "confidence": "high", "source": "docker-compose.yml container_name entries", "why": "Containers named: <list>" }
```

If no docker-compose files found or no container_name entries:
```json
{ "value": "", "confidence": "low", "source": "codebase scan", "why": "No docker-compose container_name entries found; add your service name prefix here (e.g., 'acme-')" }
```

### 4C: Build verification enrichment

```json
"verification": {
  "health_endpoint": { "value": "...", "confidence": "...", "source": "...", "why": "..." },
  "health_patterns": [
    { "value": "\"status\": \"ok\"", "confidence": "low", "source": "default", "why": "Standard ForgeDock health pattern; update if your API uses a different response shape" }
  ],
  "internal_service_patterns": [
    { "value": "<prefix>", "confidence": "...", "source": "...", "why": "..." }
  ]
}
```

---

## Phase 5: Assemble and Return Enriched ConfigDraft

### 5A: Merge enrichments into the draft

Start from the incoming `DRAFT`. Merge the enriched sections:
- `DRAFT.project_board` = Phase 1 output (or low-confidence placeholder)
- `DRAFT.repos` = Phase 2 output (or low-confidence placeholder)
- `DRAFT.review` = Phase 3 output
- `DRAFT.verification` = Phase 4 output

Never modify `DRAFT.project`, `DRAFT.paths`, `DRAFT.branches`, or `DRAFT.meta` — pass them through unchanged.

### 5B: Add enrichment metadata

Append to `DRAFT.meta`:

```json
{
  "enriched": true,
  "enrichment_backend": "skill",
  "enriched_at": "<ISO 8601 timestamp>",
  "enrichment_notes": ["<any skipped phases and reasons>"]
}
```

### 5C: Return the enriched ConfigDraft

Output the complete enriched ConfigDraft as a JSON blob on stdout. This is the skill's return value — the caller (CLI orchestrator or review-render) reads it from the output.

```
<ENRICHED_DRAFT_JSON>
```

**Output format requirements**:
- Single JSON object, pretty-printed (2-space indent)
- All sections present (project, paths, branches, project_board, repos, review, verification, meta)
- Every leaf is `{ value, confidence, source, why }` — no raw strings
- No trailing prose after the JSON blob

---

## Enrichment Summary (informational)

After the JSON output, print a human-readable enrichment summary for the operator's benefit. This is NOT part of the machine-readable output — it is separated by a `---` divider:

```
---
## Enrichment Summary

Sections enriched:
  project_board  — <high|medium|low: brief note>
  repos          — <N satellite candidates found | skipped>
  review         — tech_stack=<value>, context from <source>
  verification   — health_endpoint=<value | not found>, <N> container patterns

Skipped:
  <phase> — <reason>

Low-confidence fields (will appear as TODO flags in forge.yaml):
  <list of field paths with low confidence and their why>
```
