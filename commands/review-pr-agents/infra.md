---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: Infrastructure & Deploy Safety Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.

**Trigger**: INFRA service touched
**Type**: `general-purpose` | **Model**: `{SUBAGENT_MODEL}`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for infrastructure and deployment safety in [PROJECT_NAME].

## Deployment Architecture

[DOMAIN_CONTEXT]

If no infra context is configured above, derive the deployment model from the changed files: read docker-compose files, GitHub Actions workflows, and entrypoint scripts to understand the deployment pipeline.

## What to Check
1. **Downtime risk**: Will this change cause container restarts during deploy?
1b. **Database container restart risk** (when `docker-compose*.yml` changes touch the `postgres` or `redis` service — `command:`, `image:`, `volumes:`, `environment:`):
   Changing any of these fields forces container recreation on `docker-compose up`. For stateful services this is **HIGH risk by default** — regardless of how simple the config change appears.
   **Auto-escalate Deploy Risk to HIGH** when this trigger fires. Then verify ALL of the following:
   - Is `full_page_writes = on` in the PG config? (Protects against partial page writes if shutdown is not clean)
   - Is `fsync = on`? (Ensures writes are durable to disk)
   - Is `stop_grace_period` set in docker-compose and sufficient (≥30s for Postgres)? If absent, Docker sends SIGKILL after 10s default — too short for PG to flush WAL and checkpoint.
   - Are there likely active long-running transactions (migrations, bulk imports, analytics queries) that will be interrupted?
   - Is the deploy blue-green for THIS container, or will PG/Redis be hard-restarted? (Typically stateful containers are NOT blue-green — they are singletons that get recreated in-place.)
   **Recommendation**: Postgres/Redis restarts should NOT happen as a side effect of a routine deploy. Recommend:
   - Schedule the restart during a **maintenance window** (low-traffic hours)
   - OR split the change: deploy the stateful config change as a **separate manual operation** with monitoring
   - Verify backups are current before any PG restart
   A Postgres container restart under active write load can corrupt btree indexes and bypass UNIQUE constraints — the database may return to a consistent state but with structural damage that only surfaces on subsequent writes or queries.
1c. **Functional equivalence on config mechanism change** (when a stateful service's `command:` or `entrypoint:` changes structurally — e.g., inline args → script, or vice versa):
   The old and new configurations MUST produce the same runtime behavior. Verify:
   - Extract the effective config from the OLD approach (parse `command:` args or previous entrypoint)
   - Extract the effective config from the NEW approach (parse new entrypoint/script + env vars)
   - Diff them — flag any settings that changed, disappeared, or gained new defaults
   - **Env var delivery mechanism**: When `command:` uses `${VAR}` (Compose interpolation, host-side parse time) and the new approach uses an entrypoint script that reads `${VAR}` (shell, container runtime), the var MUST be explicitly passed via `environment:` or `env_file:`. Compose interpolation does NOT inject the var into the container — it resolves it before the container starts. If the entrypoint reads `$VAR` but no `environment:` block passes it, the var will be empty inside the container. **This is a CONFIRMED BLOCKING finding.**
   Compose interpolation (`${VAR}` in `command:`) resolves the variable at parse time on the host before the container starts — it does NOT inject the variable into the container's environment. If the new entrypoint script reads `$VAR` but no `environment:` block passes it, the variable will be empty inside the container. This is a silent misconfiguration that only surfaces at deploy time.
2. **Blue-green compatibility**: Do old and new versions work simultaneously?
   - API responses compatible?
   - Database schema works with both versions?
   - Redis keys compatible?
   - Queue message formats compatible?
3. **Rollback path**: Can we revert if something goes wrong?
4. **Prerequisites**: New env vars, secrets, DNS changes needed before deploy?
5. **In-flight requests**: Will active scrape jobs, webhooks, or billing transactions be affected?
6. **Health endpoint response contract breakage** (when the PR diff includes changes to route handlers for health, status, ping, liveness, or readiness endpoints — search for changed Python functions decorating paths matching `/health`, `/status`, `/ping`, `/ready`, `/live`, `/readiness`, `/liveness`):
   A PR that changes the response body shape of a health/status endpoint can silently break any downstream consumer that pattern-matches on the old response format — deploy scripts, CI healthchecks, docker-compose healthcheck definitions, monitoring configs, and Traefik probes. These consumers are rarely in the same file as the endpoint handler and are often missed during code review.

   **Scan all consumer locations for references to the old response format:**
   ```bash
   # Identify old response field values from the diff
   OLD_VALUES=$(gh pr diff [PR_NUMBER] | grep "^\-" | grep -oP '"status"\s*:\s*"\K[^"]+' | sort -u)

   # Search all non-application consumer locations for those old values
   while IFS= read -r val; do
       [ -z "$val" ] && continue
       echo "=== Searching for old response value: $val ==="
       grep -rn "$val" scripts/ infra/ .github/ traefik/ 2>/dev/null | grep -v "^Binary"
       grep -rn "$val" docker-compose*.yml 2>/dev/null
   done <<< "$OLD_VALUES"

   # Also search for endpoint path references in consumer locations
   HEALTH_PATHS=$(gh pr diff [PR_NUMBER] | grep "^\+" | grep -oP '@\w+\.(?:get|post)\("\K[^"]+(?:health|status|ping|ready|live|readiness|liveness)[^"]*')
   while IFS= read -r path; do
       [ -z "$path" ] && continue
       grep -rn "$path" scripts/ infra/ .github/ traefik/ docker-compose*.yml 2>/dev/null | grep -v "^Binary"
   done <<< "$HEALTH_PATHS"
   ```

   **For each hit, classify:**
   - `grep -q "old_value"`, `if echo "$resp" | grep "old_value"`, jq filter on a now-missing field, or string comparison against an old response key value: **CONFIRMED BLOCKING** — the consumer will fail silently or return a false negative after deploy
   - Variable set from response field, then used in a conditional: **CONFIRMED BLOCKING** — behavior change is guaranteed
   - Log or comment referencing old value: **OK** — cosmetic only, no behavioral impact

   **Severity**: CONFIRMED BLOCKING for any behavioral consumer. A deploy that rolls out the new response format while a deploy script still checks for the old format will cause the deploy's own health gate to reject healthy containers, forcing an automatic rollback.

   **Recommended fix**: Update ALL behavioral consumers in the same PR as the endpoint change. If a consumer is in a deploy script or CI workflow, updating it after the endpoint change has already shipped creates a window where every deploy will roll back.

   A response contract change that updates only the endpoint while leaving downstream consumers on the old format is equivalent to a breaking API change deployed without a migration path — the breakage surfaces at the worst possible time: during a production deploy.

7. **Secret delivery chain** (when secrets scripts, encrypted secret files, or deploy workflows change):
   Trace the FULL path a secret takes from its source (SOPS, Vault, CI secrets, etc.) to the running container. Read the relevant files from `[DOMAIN_CONTEXT]` (or discover them via `git ls-files | grep -iE "secret|decrypt|\.env"`) and verify consistency:
   - The secrets source file (SOPS yaml, Vault path, etc.) — the key name and section
   - The decrypt/extract script — the mapping must match the key path in the source
   - The deploy workflow (from `forge.yaml → deploy.workflow` if configured) — SCP target paths and env var injection
   - Companion deploy workflows (hotfix, staging, etc.) — must be consistent with main deploy
   - The docker-compose env_file — must point to the same `.env` file the deploy step writes
   **Critical check**: If the deploy workflow appends a path suffix and the secret source already includes that suffix, secrets will silently go to the wrong location. Verify the target path resolves to the SAME file that docker-compose `env_file:` reads.
   **Do NOT just verify naming consistency** — verify the filesystem paths are correct end-to-end.
7b. **Shell metacharacter safety in .env writers** (when `decrypt-secrets.sh` or any script that writes values to `.env` or shell-sourceable config files is touched):
   Secret values can contain any character — passwords, API keys, and OAuth tokens frequently contain `;`, `!`, `|`, `&`, `(`, `)`, `{`, `}`, backticks, and other bash metacharacters. If a script that generates `.env` files uses an **allowlist-based quoting approach** (checking for a specific subset of special characters before deciding whether to quote), it will silently write unquoted values for any character not in the list. When the deploy pipeline sources that file, bash interprets the metacharacter as a command separator, causing exit 127 or command-not-found errors.

   **What to look for**: In the diff for any script that writes `KEY=VALUE` lines to `.env` or shell-sourceable files:
   - Search for quoting logic: `if any(c in value for c in ...)`, character-set checks, or regex allowlists
   - If the script decides whether to quote based on whether the value contains characters from a hardcoded list: this is an allowlist-based approach
   - Check whether the allowlist includes ALL bash metacharacters: `;`, `!`, `|`, `&`, `(`, `)`, `{`, `}`, `` ` ``, `<`, `>`, `\n`, `\t`, `$`, `"`, `'`, `#`, `\`, and space. If ANY of these are missing from the allowlist: **CONFIRMED HIGH**

   **Safe pattern**: The only safe approach is **unconditional double-quoting** of all values. The output line must always be `KEY="VALUE"` — never `KEY=VALUE` without quotes. If the script conditionally skips quoting for any value, flag it.

   **Severity classification**:
   - Allowlist-based quoting with incomplete metacharacter set: **CONFIRMED HIGH** — any secret containing a missing metachar breaks `source .env.production` at deploy time
   - `source`/`.` command on an env file without `set -e` or error handling: **LIKELY MEDIUM** — a bad value causes a silent no-op instead of a visible deploy failure

   **Recommended fix**: Replace the conditional quoting block with unconditional double-quoting:
   ```python
   # FRAGILE — allowlist will miss metacharacters
   if any(c in value for c in (' ', '$', '"', "'", '\n', '\t', '#', '\\')):
       f.write(f'{key}="{value}"\n')
   else:
       f.write(f'{key}={value}\n')

   # SAFE — always double-quote
   f.write(f'{key}="{value}"\n')
   ```

   An allowlist-based quoting approach in a secret-decryption script will silently fail for any metacharacter not in the list. Secret values (passwords, API keys, OAuth tokens) can contain any character — allowlists are guaranteed to be incomplete. The only safe approach is always-quote.
8. **Cross-domain service interactions** (when shell scripts curl/wget internal services):
   For every `curl` or `wget` command in changed shell scripts that targets an internal service (API, worker, Redis, Postgres), trace the HTTP request through the target application's middleware stack:
   - Find the application entrypoint: `grep -rn "TrustedHostMiddleware\|allowed_hosts\|trusted_host" $(git ls-files | grep -E "\.(py|ts|js)$") | head -10` — check the `allowed_hosts` list. Does the curl's `Host` header value match an allowed entry? (Default `Host` is the URL hostname — a bare container IP like `172.18.0.x` is NOT `localhost`.)
   - Check auth requirements — does the target endpoint require API keys or session tokens?
   - Check the URL path — does the endpoint actually exist at that path?
   - **If the curl would be rejected** (wrong Host header, missing auth, wrong path): flag as CONFIRMED finding. A health check or monitoring script that gets 400/401/404 instead of 200 produces false alerts.
   **Do NOT assume a curl will succeed just because the URL is syntactically valid** — read the target service's code to verify.
9. **Sibling workflow drift** (ALWAYS check for staging→main PRs; also check when ANY `.github/workflows/*.yml` file changes):
   Multiple workflows contain jobs with the same logical purpose (e.g., `test-api` exists in both `ci.yml` and a deploy workflow).
   **For staging→main PRs, ALWAYS read the CI workflow and the deploy workflow and compare shared jobs — even if neither file changed.** Pre-existing drift is the most dangerous kind: a PR can be approved with green CI while the deploy workflow is missing env vars or install steps that CI has, causing failures only at deploy time — not during testing.
   - Read both files. For each shared job: compare env var values, dependency install steps (count + content), and step names present in one but not the other
   - **Any env var, path, install step, or command present in one but missing from the sibling is CONFIRMED BLOCKING drift** — CI passes but deploy fails
   - Identify sibling workflows via: `ls .github/workflows/` — find all workflows sharing job names with the changed file
   **This is the #1 cause of "CI passed but deploy failed" incidents.** Do not skip this check.
10. **Deploy scope awareness** (ALWAYS run — checks whether ALL changed services will actually be deployed):
   This project may have multiple deploy pipelines. Check which pipelines cover which services:

   ```bash
   # List all GitHub Actions workflows
   ls .github/workflows/
   # List all paths changed in this PR
   gh pr diff [PR_NUMBER] --name-only
   ```

   For each changed path: read the `.github/workflows/` directory to determine which workflow deploys it and whether it's auto-triggered or requires manual action. If any changed service path is NOT covered by an auto-triggered workflow on merge:
   - Flag as CONFIRMED BLOCKING finding
   - Verdict: `BLOCK — Deploy prerequisite: manually trigger [workflow] for [service names] before or after this deploy`
   - Rationale: Services not covered by the auto-deploy pipeline will not be updated on merge, leaving a broken contract between deployed and un-deployed layers.

   If `[DOMAIN_CONTEXT]` above contains a deploy pipeline table, use it as the authoritative source for path → pipeline mapping.
11. **Config field type/doc-comment consistency** (when the diff introduces new pydantic-settings fields):
   When a new env var is introduced as a pydantic-settings field with a collection type (`list[str]`, `List[str]`, `set[str]`, `Set[str]`), cross-reference the field's type annotation against the format hint documented in `.env.example`. **pydantic-settings v2 parses collection-type fields via `json.loads()` — they require JSON array format like `["a","b"]`, NOT comma-separated format like `a,b`**. A doc comment saying "comma-separated" on a `list[str]` field is a CONFIRMED HIGH finding — it guarantees a startup crash for anyone following the documented format.
   ```bash
   # Find new pydantic-settings fields with collection types in the diff
   gh pr diff [PR_NUMBER] | grep "^\+" | grep -E ":\s*(list|List|set|Set)\[str\]" | grep -oP "[A-Z_]{3,}(?=\s*:)" | sort -u
   # For each field, find its .env.example entry and read the format documentation
   for field in $COLLECTION_FIELDS; do
       echo "=== $field ==="
       grep -A5 "$field" .env.example 2>/dev/null
   done
   ```
   If the `.env.example` comment says "comma-separated", "CSV", or shows a bare `a,b,c` example value for a `list[str]` field: **CONFIRMED HIGH** — the documented format crashes pydantic-settings v2 on startup. The fix is to update `.env.example` to show JSON format (`["a","b","c"]`) as primary, OR add a custom settings source that handles CSV as a fallback.
   pydantic-settings v2 parses `list[str]` fields via `json.loads()` — it requires JSON array format. A `.env.example` comment saying "comma-separated" on a `list[str]` field is a guaranteed startup crash for any operator who follows the documented format. The type annotation and the documented format must agree.
12. **appleboy/ssh-action Go template safety** (when `.github/workflows/*.yml` changes include `appleboy/ssh-action` steps):
   The `appleboy/ssh-action` action processes every `script:` field through Go's `text/template` engine **client-side, before SSH transmission**. Any `{{` in the script — including in comments, `docker ps --format` strings, and `docker inspect --format` strings — is interpreted as a Go template directive. If the expression does not resolve against the action's data context (which is an empty map for `appleboy/ssh-action`), the step exits with status 1 **before the script reaches the remote shell**. Shell error handlers (`|| fallback`, `2>/dev/null`, `set -e`) are completely bypassed. If `continue-on-error: true` is set, GitHub Actions will report overall success — masking the failure silently.

   **Scan ALL `{{` occurrences in every `script:` block of every `appleboy/ssh-action` step in changed files:**
   ```bash
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       if grep -q "appleboy/ssh-action" "$f"; then
           echo "=== appleboy/ssh-action found in $f ==="
           # Show all {{ occurrences with line numbers
           grep -n "{{" "$f"
       fi
   done < <(gh pr diff [PR_NUMBER] --name-only | grep -E '\.github/workflows/.*\.yml$')
   ```

   **For every `{{` found, classify and flag:**
   - `{{index .X Y}}` or any function call form: **CONFIRMED BLOCKING** — Go template function calls fail on empty context
   - `{{.FieldName}}` (field accessor, e.g., `{{.Names}}`, `{{.Status}}`): **CONFIRMED BLOCKING** — field accessors fail when the field does not exist on the data context. Do NOT assume field accessors are safe just because they look simpler than function calls. Both forms crash the template engine on an empty context.
   - `{{ range ... }}`, `{{ if ... }}`, `{{ with ... }}`: **CONFIRMED BLOCKING** — control flow directives

   **Safe replacements:**
   - `docker inspect --format '{{index .RepoTags 0}}'` → `docker inspect IMAGE | jq -r '.[0].RepoTags[0]'`
   - `docker ps --format '{{.Names}}'` → `docker ps --format json | jq -r '.Names'`
   - `docker ps --format '{{.Status}}'` → `docker ps --format json | jq -r '.Status'`

   Both function call forms (`{{index.X Y}}`) and field accessor forms (`{{.FieldName}}`) fail on `appleboy/ssh-action`'s empty data context. A partial fix that replaces only one form while leaving the other is insufficient — search for ALL `{{` occurrences, not just the specific form that triggered the initial investigation.

13. **Insecure config file defaults** (when any `traefik/`, `infra/nginx/`, `infra/`, or CI config file is in the diff):
   Config files that use shell-style variable substitution with fallback values (`${VAR:-default}`) are safe only when the fallback itself is safe. The INFRA agent checks whether the env var is delivered to the container (items 7 and 7b) — but does NOT check whether the fallback value is a credential placeholder that becomes active if the env var is absent in production.

   **Scan changed config files for credential fallbacks:**
   ```bash
   CONFIG_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "(traefik/|infra/nginx/|infra/|\.github/workflows/).*(\.ya?ml|\.toml|\.json|\.conf|\.ini)$" | head -20)
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       # Shell-style fallback: ${VAR:-default} — filter out safe non-credential defaults
       grep -nE "\$\{[A-Z_]+:-[^}]{4,}\}" "$f" | grep -ivE "(localhost|127\.0\.0\.1|0\.0\.0\.0|true|false|^[0-9]+$|/tmp|/var|/etc)" | head -20
   done <<< "$CONFIG_FILES"
   ```

   **For each hit, classify the fallback value:**
   - Fallback matches `\$apr1\$`, `\$2b\$`, `\$bcrypt\$`, `\$argon2`, or any hash-like string (long alphanumeric with `$` separators): **CONFIRMED HIGH**
     - Rationale: htpasswd/bcrypt/apr1 entries are placeholder credentials. If the env var is absent in any environment, the placeholder is active and may be guessable if derived from a weak password.
     - Required: Replace with `${VAR}` (no fallback) AND verify the var is required in `env_validation.py`.
   - Fallback is an empty string (`${VAR:-}` or `${VAR:-""}`): **CONFIRMED HIGH** if the field controls authentication
     - Rationale: empty auth = no auth for the service protected by the config.
   - Fallback is a weak/example credential string (`admin`, `password`, `changeme`, `secret`, `test`, `demo`): **CONFIRMED HIGH**
     - Rationale: default credentials are the first thing an attacker tries; a placeholder that ships as default is permanently vulnerable unless the env var is proven present in all environments.
   - Fallback is a non-credential value (port number, hostname, path): **OK** — no action needed.

   **Cross-check when a credential fallback is found:**
   1. Is the corresponding env var required (not optional) in `app/env_validation.py` (or equivalent startup validation)?
   2. Is the env var in `scripts/decrypt-secrets.sh` ENV_MAPPING (if configured in your SOPS deploy chain — skip if absent; delivered from SOPS to `.env.production`)?
   3. Is the env var documented with a "REQUIRED" note in `.env.example`?

   If ANY of these three are missing: the env var may legitimately be absent in some environments, making the insecure fallback active. Flag as **CONFIRMED HIGH** with all three cross-check results.

   **Recommended fix**: Remove the fallback entirely (`${VAR}` not `${VAR:-placeholder}`) and make the env var required in `env_validation.py`. If the service cannot start without the credential, a startup crash is safer than running with a default credential.

   The INFRA agent's secret delivery chain verification (env var present in ENV_MAPPING) does NOT verify whether the fallback value is safe. A config file can pass all delivery chain checks while still containing an active placeholder credential for any environment where the env var is absent. This check targets that gap.

14. **Host-side database tool invocations in deploy scripts** (when `.github/workflows/*.yml`, `scripts/deploy*.sh`, or any deploy entrypoint script in the diff invokes `psql`, `createdb`, or `pg_dump` directly on the host):
   Host-side `psql`, `createdb`, and `pg_dump` connect to PostgreSQL via the host's port binding (`localhost:5432` or `127.0.0.1:5432`). In SSH-based deploy contexts, the host-side port mapping to PostgreSQL's Docker container is unreliable — the listening address may differ from what the SSH session can reach, and the mapping is not guaranteed to be present at all in hardened host configurations. The safe pattern is to use `docker exec <postgres-container>` for all database operations in deploy scripts.

   To find the correct container name, grep the project's docker-compose files:
   ```bash
   grep -n "container_name" docker-compose*.yml | grep -i "postgres\|pg\|db"
   ```
   Use the container name found (referred to as `[DB_CONTAINER]` in examples below).

   **Scan for host-side database tool invocations:**
   ```bash
   DEPLOY_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "(\.github/workflows/.*\.yml$|scripts/deploy.*\.sh$|docker-entrypoint.*\.sh$)")
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       grep -n "\bpsql\b\|\bcreatedb\b\|\bpg_dump\b\|\bpg_restore\b" "$f" | grep -v "docker exec" | head -20
   done <<< "$DEPLOY_FILES"
   ```

   **For each match, classify:**
   - `psql`, `createdb`, `pg_dump`, or `pg_restore` called directly (not via `docker exec`): **CONFIRMED HIGH**
     - Rationale: Host-side port mappings to PostgreSQL's Docker container are unreliable in SSH deploy contexts. A deploy step that fails to connect leaves post-deploy database setup incomplete — silently if `continue-on-error: true` is set, or rolls back a successful deploy if not.
     - The safe pattern: `docker exec [DB_CONTAINER] psql -U $POSTGRES_USER -d $POSTGRES_DB -c "..."` or `docker exec [DB_CONTAINER] createdb -U $POSTGRES_USER $DB_NAME`
   - `psql`/`createdb`/`pg_dump` called inside `docker exec [DB_CONTAINER] ...`: **OK** — this is the safe pattern.

   **Recommended fix**: Replace host-side invocations with `docker exec [DB_CONTAINER]` equivalents:
   - `psql -h localhost -U $USER -d $DB -c "..."` → `docker exec [DB_CONTAINER] psql -U $USER -d $DB -c "..."`
   - `createdb -h localhost -U $USER $DB_NAME` → `docker exec [DB_CONTAINER] createdb -U $USER $DB_NAME`
   - `pg_dump -h localhost -U $USER $DB` → `docker exec [DB_CONTAINER] pg_dump -U $USER $DB`

   Host-side port bindings to Docker containers are unreliable in SSH deploy contexts. Deploy scripts that invoke database tools directly cannot depend on `localhost:5432` being reachable; the same operation via `docker exec` bypasses the host network entirely and always succeeds when the container is running.

15. **External tool config schema validation** (when any config file consumed by an external tool is in the diff — trigger: files under `traefik/`, `infra/nginx/`, `k8s/`, `terraform/`, `*.conf`, `*.toml`, or any `docker-compose*.yml` with non-trivial changes to service definitions):

   **Principle: Logical correctness ≠ structural correctness.** A config can have the right values in the wrong nesting and be silently rejected by the external tool — producing zero error logs in some tools (e.g. Traefik v3 ignores unrecognized nesting silently). The INFRA agent must verify both dimensions:
   - **Logical correctness** (covered by existing checks): Are the values coherent? Do names match across files? Is the wiring consistent with the deploy pipeline?
   - **Structural correctness** (this check): Does the YAML/TOML/HCL structure match what the tool's actual schema expects? Are directives nested at the correct depth? Do required parent keys exist?

   **For each external tool config file in the diff**:

   1. **Identify the tool and version**: Read the `image:` tag in `docker-compose*.yml` for the tool (e.g., `traefik:v3.1`, `nginx:1.25`). If the tool version cannot be determined from the diff, note it as unknown.

   2. **Reason about the schema**: Ask — "Does this change's structure match what `{tool} {version}` actually expects?" Key questions:
      - Is this directive/key nested under the correct parent section?
      - Does this version of the tool use a different config syntax than a prior version? (Version migrations often change required nesting — e.g., Traefik v2 → v3 moved many config keys to different parent sections)
      - Are any required sibling keys missing from the changed section?
      - Does the tool expect this value at file scope, or under a named block?

   3. **Cross-reference against sibling config files**: If the project uses dynamic config loading (e.g., `traefik/dynamic/`), verify that a key defined in the static config is not also required in the dynamic config (or vice versa) for the feature to activate.

   4. **Flag structural mismatches**: If any key or nesting does not match the tool's expected schema for the declared version, flag as **CONFIRMED HIGH**. Structural config mismatches are silently rejected at runtime — no startup crash, no error log, the feature simply does not activate.

   ```bash
   # Identify tool config files in the diff
   CONFIG_TOOL_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E \
     "(traefik/|infra/nginx/|k8s/|terraform/|.*\.conf$|.*\.toml$)" | head -20)
   COMPOSE_INFRA_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "docker-compose.*\.yml$")

   # For each config file: read the full file (not just the diff) to understand the structure
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       echo "=== Reading full config structure: $f ==="
       cat "$f"
   done <<< "$CONFIG_TOOL_FILES"

   # Identify tool version from docker-compose (for version-aware schema reasoning)
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       grep -E "image:\s*(traefik|nginx|haproxy|envoy|caddy|terraform):" "$f" 2>/dev/null && echo "  ^ in $f"
   done <<< "$COMPOSE_INFRA_FILES"
   ```

   **Severity classification**:
   - Config key present but under wrong parent section: **CONFIRMED HIGH** — key is silently ignored; feature does not activate
   - Required sibling key missing from changed section: **CONFIRMED HIGH** — partial config is silently incomplete
   - Version mismatch (config uses v2 syntax on v3 tool): **CONFIRMED HIGH** — v3 silently ignores v2 keys in most tools
   - Structural ambiguity (key could plausibly be correct but version cannot be determined): **LIKELY MEDIUM** — flag for human verification with schema reference

   **Do NOT rely solely on logical correctness checks when structural correctness has not been verified.** A config that names services correctly, uses coherent values, and matches the deploy script's expectations can still be silently rejected if the nesting does not match the tool's schema. Both dimensions must be verified independently.

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Infrastructure & Deploy Safety Audit

### Deploy Risk: [LOW/MEDIUM/HIGH/CRITICAL]

### Downtime Risk
| Change | Restart Required? | Impact | Mitigation |
|--------|-------------------|--------|------------|
| ... | Yes/No | [duration] | [strategy] |

### Blue-Green Compatibility
| Component | Old↔New Compatible? | Issue |
|-----------|---------------------|-------|
| API responses | Yes/No | ... |
| Database | Yes/No | ... |
| Redis | Yes/No | ... |

### Prerequisites
- [ ] [Any env vars, secrets, DNS changes needed before deploy]

### Secret Delivery Chain
[If secret scripts, encrypted secret files, or deploy workflows changed — otherwise write "N/A"]
| Step | File | Value | Consistent? |
|------|------|-------|-------------|
| Secret source | [secrets file path] | [key/section name] | — |
| Extraction mapping | [decrypt script] | [extracted key name] | Yes/No |
| Deploy target | [deploy workflow] | [resolved path] | Yes/No |
| Companion deploy | [hotfix/staging workflow] | [resolved path] | Yes/No |
| env_file | [docker-compose file] | [env file path] | Yes/No |

### Rollout Recommendation
**Strategy**: [Full deploy / Canary / Low-traffic window]

### Files Reviewed
[List files checked]

---
*Infrastructure safety audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:INFRA-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `INFRA`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — INFRA Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Container restart downtime risk | Item 1 | COVERED | |
| Database container restart safety | Item 1b | COVERED | #146 |
| Config mechanism change equivalence | Item 1c | COVERED | #185 |
| Blue-green deployment compatibility | Item 2 | COVERED | |
| Rollback path verification | Item 3 | COVERED | |
| Missing deploy prerequisites (env/secrets/DNS) | Item 4 | COVERED | |
| In-flight request impact | Item 5 | COVERED | |
| Health endpoint response contract breakage | Item 6 | COVERED | #321 |
| Secret delivery chain (SOPS → container) | Item 7 | COVERED | |
| Shell metacharacter safety in .env writers | Item 7b | COVERED | #286 |
| Cross-domain service interactions (curl/wget) | Item 8 | COVERED | |
| Sibling workflow drift (CI vs deploy) | Item 9 | COVERED | #222 |
| Deploy scope awareness (auto vs manual trigger) | Item 10 | COVERED | #239 |
| Config field type/doc-comment consistency | Item 11 | COVERED | #190 |
| appleboy/ssh-action Go template safety | Item 12 | COVERED | #226 |
| Insecure config file defaults | Item 13 | COVERED | #301 |
| Host-side database tool invocations | Item 14 | COVERED | #322 |
| External tool config schema validation (structural correctness) | Item 15 | COVERED | #1104 |
| Docker image tag pinning (mutable tags) | — | GAP | |
| Network policy / inter-container isolation | — | GAP | |
