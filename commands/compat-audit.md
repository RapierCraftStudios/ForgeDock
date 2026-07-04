---
description: On-demand Claude Code compatibility and feature parity report — compares installed version against the breakpoints registry and lists affected ForgeDock features
argument-hint: [--refresh]
install: extras
---

# /compat-audit — Claude Code Compatibility Report

**Input**: $ARGUMENTS

You are the ForgeDock compatibility auditor. Produce a point-in-time advisory report that shows whether the user's installed Claude Code version is current and which ForgeDock features may behave differently on their runtime. This command is **non-blocking** — it never aborts the session. All output is advisory.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

---

## Config Preamble

Read `forge.yaml` to resolve the ForgeDock installation path:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  FORGE_HOME_PATH=$(yq '.paths.root // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
fi

# Fallback: resolve from this command file's own location if yq is unavailable
# or forge.yaml is absent. The commands/ directory is always inside FORGE_HOME.
if [ -z "$FORGE_HOME_PATH" ] || [ ! -d "$FORGE_HOME_PATH" ]; then
  FORGE_HOME_PATH="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"
fi
export FORGE_HOME_PATH
```

---

## Phase 1: Parse Arguments

Parse `$ARGUMENTS` for the `--refresh` flag:

```bash
REFRESH=false
for arg in $ARGUMENTS; do
  [ "$arg" = "--refresh" ] && REFRESH=true
done
```

**If `--refresh` is set**: delete the version cache before detection so the npm registry is queried for the latest version regardless of TTL:

```bash
VERSION_CACHE="$HOME/.claude/forgedock/version-cache.json"
if [ "$REFRESH" = "true" ] && [ -f "$VERSION_CACHE" ]; then
  rm -f "$VERSION_CACHE"
  echo "Version cache cleared — will query npm registry for fresh data."
fi
```

---

## Phase 2: Detect Installed Claude Code Version

Run `detectClaudeVersion()` from `bin/forge-utils.mjs`. This function reads from the cache at `~/.claude/forgedock/version-cache.json` (24h TTL) on a cache hit, or queries `npm info @anthropic-ai/claude-code version` and `claude --version` on a miss. It is fail-open — it never throws.

```bash
VERSION_CACHE="$HOME/.claude/forgedock/version-cache.json"
INSTALLED="unknown"
LATEST="unknown"
STALE=false
DELTA=""
CACHED_AT=""
DAYS_SINCE_REFRESH="unknown"

if [ -f "$VERSION_CACHE" ]; then
  INSTALLED=$(CACHE_PATH="$VERSION_CACHE" node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.CACHE_PATH, 'utf8'));
      process.stdout.write(c.installed || 'unknown');
    } catch { process.stdout.write('unknown'); }
  " 2>/dev/null || echo "unknown")

  LATEST=$(CACHE_PATH="$VERSION_CACHE" node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.CACHE_PATH, 'utf8'));
      process.stdout.write(c.latest || 'unknown');
    } catch { process.stdout.write('unknown'); }
  " 2>/dev/null || echo "unknown")

  STALE=$(CACHE_PATH="$VERSION_CACHE" node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.CACHE_PATH, 'utf8'));
      process.stdout.write(c.stale === true ? 'true' : 'false');
    } catch { process.stdout.write('false'); }
  " 2>/dev/null || echo "false")

  DELTA=$(CACHE_PATH="$VERSION_CACHE" node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.CACHE_PATH, 'utf8'));
      process.stdout.write(c.delta || '');
    } catch { process.stdout.write(''); }
  " 2>/dev/null || echo "")

  DAYS_SINCE_REFRESH=$(CACHE_PATH="$VERSION_CACHE" node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.CACHE_PATH, 'utf8'));
      if (typeof c.cachedAt === 'number') {
        const days = Math.floor((Date.now() - c.cachedAt) / 86400000);
        process.stdout.write(days.toString());
      } else {
        process.stdout.write('unknown');
      }
    } catch { process.stdout.write('unknown'); }
  " 2>/dev/null || echo "unknown")
else
  # Cache absent — attempt a fresh detection by running detectClaudeVersion()
  DETECT_RESULT=$(node --input-type=module <<'NODE_EOF' 2>/dev/null
import { pathToFileURL } from 'url';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const forgeHome = process.env.FORGE_HOME_PATH || '.';
const utilsPath = join(forgeHome, 'bin', 'forge-utils.mjs');
try {
  const { detectClaudeVersion } = await import(pathToFileURL(utilsPath).href);
  const r = await detectClaudeVersion();
  process.stdout.write(JSON.stringify(r));
} catch {
  process.stdout.write(JSON.stringify({ version: 'unknown' }));
}
NODE_EOF
)
  INSTALLED=$(echo "$DETECT_RESULT" | node -e "
    try {
      const r = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      process.stdout.write(r.installed || r.version || 'unknown');
    } catch { process.stdout.write('unknown'); }
  " 2>/dev/null || echo "unknown")
  LATEST=$(echo "$DETECT_RESULT" | node -e "
    try {
      const r = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      process.stdout.write(r.latest || 'unknown');
    } catch { process.stdout.write('unknown'); }
  " 2>/dev/null || echo "unknown")
fi
```

**Fail-open**: if all detection attempts return `unknown`, proceed to Phase 3 and report degraded output.

---

## Phase 3: Load Breakpoints Registry

Read `docs/claude-breakpoints.json` from the ForgeDock installation root:

```bash
BREAKPOINTS_FILE="${FORGE_HOME_PATH}/docs/claude-breakpoints.json"
BREAKPOINTS_JSON=""

if [ -f "$BREAKPOINTS_FILE" ]; then
  BREAKPOINTS_JSON=$(cat "$BREAKPOINTS_FILE" 2>/dev/null || echo "")
else
  echo "NOTE: docs/claude-breakpoints.json not found at ${FORGE_HOME_PATH}/docs/."
  echo "This file is included in ForgeDock v1.x+. Run: npx forgedock update"
fi
```

---

## Phase 4: Diff — Identify Active Breakpoints

Compare each breakpoint's `version` against `INSTALLED` using **numeric** semver comparison (split on `.`, compare each segment as an integer — NOT lexicographic):

```bash
if [ -n "$BREAKPOINTS_JSON" ] && [ "$INSTALLED" != "unknown" ]; then
  ACTIVE_BREAKPOINTS=$(node -e "
    try {
      const data = JSON.parse(process.argv[1]);
      const installed = process.argv[2];

      function parseVer(v) {
        return v.split('.').map(s => parseInt(s, 10));
      }
      function isLessThan(a, b) {
        const pa = parseVer(a), pb = parseVer(b);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
          const ai = pa[i] || 0, bi = pb[i] || 0;
          if (ai < bi) return true;
          if (ai > bi) return false;
        }
        return false;
      }

      const breakpoints = data.breakpoints || [];
      const active = breakpoints.filter(bp => isLessThan(installed, bp.version));
      process.stdout.write(JSON.stringify(active));
    } catch (e) {
      process.stdout.write('[]');
    }
  " -- "$BREAKPOINTS_JSON" "$INSTALLED" 2>/dev/null || echo "[]")
else
  # Version unknown — cannot determine active breakpoints; list all as unknown status
  ACTIVE_BREAKPOINTS="UNKNOWN"
fi
```

---

## Phase 5: Produce Report

Print the compat-audit report to stdout. This output is **advisory only** — it does not block the session or exit non-zero.

---

### Compat-Audit Report Format

Compose and print the following report, substituting resolved values:

```
╔══════════════════════════════════════════════════════╗
║         ForgeDock / Claude Code Compat Audit         ║
╚══════════════════════════════════════════════════════╝

Version Status
──────────────
  Installed : {INSTALLED}   (or "unknown — run /compat-audit --refresh")
  Latest    : {LATEST}      (or "unknown — npm registry unavailable")
  Status    : {UP TO DATE | STALE — {DELTA}}
  Cache age : {DAYS_SINCE_REFRESH} day(s)  (refresh with: /compat-audit --refresh)
```

**If STALE is true** (installed differs from latest):

```
⚠ Your Claude Code is outdated.
  Upgrade: npm update -g @anthropic-ai/claude-code
```

**If STALE is false and both versions are known**:

```
✓ Claude Code is up to date.
```

**If versions are unknown**:

```
? Version unknown. Is Claude Code installed? Try: claude --version
  For a fresh check: /compat-audit --refresh
```

---

### Active Breakpoints Section

**Case A — installed version is known and breakpoints loaded**:

If `ACTIVE_BREAKPOINTS` is an empty array (`[]`):

```
Breakpoints
───────────
  ✓ No active breakpoints — your installed version meets all ForgeDock requirements.
```

If `ACTIVE_BREAKPOINTS` contains entries, print a table:

```
Breakpoints (active — features introduced AFTER your installed version)
───────────────────────────────────────────────────────────────────────
  Version  │ Type             │ Severity │ ForgeDock Impact
  ─────────┼──────────────────┼──────────┼──────────────────────────────
  {version}│ {type}           │ {severity}│ {forgedock_impact}
  ...

  Affected ForgeDock features:
    • {forgedock_impact for each active breakpoint}

  Recommendation: upgrade to Claude Code {LATEST} to restore full ForgeDock functionality.
  Command: npm update -g @anthropic-ai/claude-code
```

**Case B — version unknown but breakpoints loaded**:

```
Breakpoints
───────────
  ? Version unknown — cannot determine which breakpoints are active.
  All known breakpoints listed below for reference:

  Version  │ Type             │ Severity │ Description
  ─────────┼──────────────────┼──────────┼──────────────────────────────
  {version}│ {type}           │ {severity}│ {description}
  ...

  To get version-specific breakpoint status: /compat-audit --refresh
```

**Case C — breakpoints file not found**:

```
Breakpoints
───────────
  ? Breakpoints registry not found (docs/claude-breakpoints.json).
  Run: npx forgedock update  # to get latest ForgeDock commands (includes breakpoints)
```

---

### Footer

Always end with:

```
──────────────────────────────────────────────────────
This report is advisory. ForgeDock continues to work regardless of version gaps.
For the full ForgeDock version intelligence picture, also run: forgedock doctor
──────────────────────────────────────────────────────
```

---

## Error Handling

- **Cache unreadable** → treat as cache absent, attempt fresh detection
- **`claude --version` unavailable** → `INSTALLED = "unknown"`, continue
- **npm registry unavailable** → `LATEST = "unknown"`, continue
- **Breakpoints file missing** → print Case C above, continue
- **node unavailable** → print raw cache content if possible, otherwise print "version detection requires Node.js ≥ 18"
- **Any uncaught exception** → print "compat-audit encountered an error: {message}" and exit 0

The command MUST exit 0 in all cases. It NEVER blocks the Claude Code session.
