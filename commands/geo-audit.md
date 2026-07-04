---
description: "Run a GEO audit — check AI referral traffic, page compliance, and auto-create improvement issues"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /geo-audit — GEO Discoverability Audit & Issue Generator

You are the GEO (Generative Engine Optimization) auditor. Pull AI referral data from Umami and Clarity, check every public page for GEO compliance (structured data, OG tags, freshness, sitemap, llms.txt), and auto-create GitHub issues for gaps.

**You have access to ALL tools** — MCP tools for Clarity, Bash for Umami/curl checks, gh CLI for issues.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

<!-- FORGE:SPEC_LOADED — geo-audit.md loaded and active. Agent is bound by this spec. -->

---

## Phase 0: Load Config

Read `forge.yaml` from the current directory (or the path passed as `$ARGUMENTS`). Gate the entire command on the `services.analytics` section existing.

```bash
# Verify forge.yaml exists and analytics is configured
GEO_CONFIG=$(python3 - <<'PYEOF'
import yaml, sys, os

config_path = os.environ.get('FORGE_CONFIG', 'forge.yaml')
try:
    cfg = yaml.safe_load(open(config_path))
except FileNotFoundError:
    print('ERROR: forge.yaml not found. Run `cp forge.yaml.example forge.yaml` and configure your project.')
    sys.exit(1)

svc = cfg.get('services', {})
analytics = svc.get('analytics', {})
if not analytics:
    print('ERROR: forge.yaml missing services.analytics section — geo-audit requires analytics to be configured.')
    print('Add services.analytics.umami and/or services.analytics.clarity to forge.yaml.')
    sys.exit(1)

paths = cfg.get('paths', {})
proj = cfg.get('project', {})
creds = paths.get('credentials', {})
creds_file = creds.get('file', '') if isinstance(creds, dict) else ''

domain = svc.get('domain', '')
if not domain:
    print('ERROR: forge.yaml missing services.domain — required for page compliance checks.')
    sys.exit(1)

umami = analytics.get('umami', {})
clarity = analytics.get('clarity', {})
owner = proj.get('owner', '')
repo = proj.get('repo', '')

print(domain)
print('https://' + domain)
print(umami.get('website_id', ''))
print(umami.get('url', ''))
print(clarity.get('project_id', ''))
print(creds_file)
print((owner + '/' + repo) if owner and repo else '')
PYEOF
)

if echo "$GEO_CONFIG" | grep -q '^ERROR:'; then
    echo "$GEO_CONFIG"
    exit 1
fi

# Assign config variables
DOMAIN=$(echo "$GEO_CONFIG" | sed -n '1p')
SITE_URL=$(echo "$GEO_CONFIG" | sed -n '2p')
UMAMI_WEBSITE_ID=$(echo "$GEO_CONFIG" | sed -n '3p')
UMAMI_API=$(echo "$GEO_CONFIG" | sed -n '4p')
CLARITY_PROJECT=$(echo "$GEO_CONFIG" | sed -n '5p')
CREDENTIALS_FILE=$(echo "$GEO_CONFIG" | sed -n '6p')
GH_REPO=$(echo "$GEO_CONFIG" | sed -n '7p')
```

---

## Constants

```
DOMAIN       = (from forge.yaml → services.domain)
SITE_URL     = (from forge.yaml → "https://" + services.domain)
UMAMI_WEBSITE_ID = (from forge.yaml → services.analytics.umami.website_id)
UMAMI_API    = (from forge.yaml → services.analytics.umami.url)
CLARITY_PROJECT  = (from forge.yaml → services.analytics.clarity.project_id)
CREDENTIALS_FILE = (from forge.yaml → paths.credentials.file)
GH_REPO      = (from forge.yaml → project.owner + "/" + project.repo)
TODAY = (current date in YYYY-MM-DD)
THIRTY_DAYS_AGO = (TODAY minus 30 days)

AI_REFERRERS = [
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "perplexity.ai",
  "copilot.microsoft.com",
  "grok.com",
  "phind.com",
  "you.com"
]
```

---

## Phase 1: Collect AI Referral Data

### 1A. Umami — AI Referrer Metrics

Authenticate with Umami (credentials from credentials file set in forge.yaml):
```bash
UMAMI_USER=$(python3 -c "import yaml; print(yaml.safe_load(open('$CREDENTIALS_FILE'))['umami']['username'])")
UMAMI_PASS=$(python3 -c "import yaml; print(yaml.safe_load(open('$CREDENTIALS_FILE'))['umami']['password'])")
UMAMI_TOKEN=$(curl -s -X POST "$UMAMI_API/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$UMAMI_USER\",\"password\":\"$UMAMI_PASS\"}" | jq -r '.token')
```

Then pull referrer metrics for the last 30 days:
```bash
START_AT=$(date -d '30 days ago' +%s)000
END_AT=$(date +%s)000
curl -s "$UMAMI_API/api/websites/$UMAMI_WEBSITE_ID/metrics?startAt=${START_AT}&endAt=${END_AT}&type=referrer" \
  -H "Authorization: Bearer $UMAMI_TOKEN" | jq '.'
```

From the results, filter for AI_REFERRERS. Record each AI referrer's session count. If a referrer appears that is NOT in our known list but looks AI-related (contains "ai", "chat", "copilot", "assistant"), flag it as a new AI referrer.

Also pull landing page metrics to see WHERE AI traffic lands:
```bash
curl -s "$UMAMI_API/api/websites/$UMAMI_WEBSITE_ID/metrics?startAt=${START_AT}&endAt=${END_AT}&type=url" \
  -H "Authorization: Bearer $UMAMI_TOKEN" | jq '.'
```

For previous period comparison (30-60 days ago):
```bash
PREV_START=$(date -d '60 days ago' +%s)000
PREV_END=$(date -d '30 days ago' +%s)000
curl -s "$UMAMI_API/api/websites/$UMAMI_WEBSITE_ID/metrics?startAt=${PREV_START}&endAt=${PREV_END}&type=referrer" \
  -H "Authorization: Bearer $UMAMI_TOKEN" | jq '.'
```

Calculate trend (current vs previous) for each AI referrer.

### 1B. Clarity — AI Channel Data

Use the MCP Clarity tool to get AI-related traffic:
- `mcp__clarity__query-analytics-dashboard`: "AITools channel sessions last 7 days"
- `mcp__clarity__query-analytics-dashboard`: "Top referrers last 7 days"
- `mcp__clarity__query-analytics-dashboard`: "Sessions from chatgpt.com last 7 days"
- `mcp__clarity__query-analytics-dashboard`: "Bot browser sessions last 7 days"

Cross-reference Clarity referrer data with Umami to validate numbers.

**If Umami or Clarity fails**: Report what you have. Partial data > no data.

---

## Phase 2: Page GEO Compliance Audit

### 2A. Discover Public Pages

Get the sitemap to find all public pages:
```bash
curl -s "$SITE_URL/sitemap.xml" | grep -oP '<loc>\K[^<]+' | sort
```

Also check llms.txt for listed pages:
```bash
curl -s "$SITE_URL/llms.txt"
```

And the full version:
```bash
curl -s "$SITE_URL/llms-full.txt"
```

Build the list of all unique public pages from both sources.

### 2B. Check Each Page

For EACH public page, run these checks (batch curl requests, don't hammer the server — add a small delay between pages):

**1. JSON-LD Structured Data**
```bash
curl -s "PAGE_URL" | grep -c 'application/ld\+json'
```
- PASS: count > 0
- FAIL: count == 0 → flag "Missing JSON-LD"

If JSON-LD exists, extract and check for `dateModified`:
```bash
curl -s "PAGE_URL" | grep -oP '<script type="application/ld\+json">\K[^<]+' | jq '.dateModified // empty' 2>/dev/null
```
- If `dateModified` exists, check if it's older than 90 days from TODAY
- STALE: dateModified > 90 days ago → flag "Stale dateModified"

**2. OG Tags**
```bash
curl -s "PAGE_URL" | grep -oP 'property="og:title" content="\K[^"]+'
```
- PASS: og:title exists and is NOT the generic site default (e.g., not just the project name or empty)
- FAIL: missing or generic → flag "Missing/generic OG tags"

Also check og:description:
```bash
curl -s "PAGE_URL" | grep -oP 'property="og:description" content="\K[^"]+'
```

**3. Sitemap Presence**
Check if page URL appears in the sitemap (from 2A).
- FAIL: page in llms.txt but NOT in sitemap → flag "Missing from sitemap"

**4. llms.txt Presence**
Check if page URL appears in llms.txt content.
- FAIL: page in sitemap but NOT referenced in llms.txt → flag "Missing from llms.txt"

### 2C. Check robots.txt for AI Bots

```bash
curl -s "$SITE_URL/robots.txt"
```

Known AI crawler user-agents to check for:
- `GPTBot` (OpenAI/ChatGPT)
- `ChatGPT-User` (ChatGPT browsing)
- `Google-Extended` (Gemini)
- `anthropic-ai` (Claude)
- `ClaudeBot` (Claude)
- `PerplexityBot` (Perplexity)
- `Bytespider` (TikTok/Doubao)
- `CCBot` (Common Crawl, used by many AI)
- `cohere-ai` (Cohere)

For each: check if it appears in robots.txt. If an AI referrer is sending traffic but its bot is NOT mentioned in robots.txt (either Allow or User-agent), flag it.

---

## Phase 3: Identify Issues

Compile all findings into issue candidates:

| Condition | Issue Title Template | Priority | Labels |
|-----------|---------------------|----------|--------|
| Page missing JSON-LD | `GEO: Add structured data to {path}` | P2 | `seo,geo` |
| dateModified > 90 days | `GEO: Refresh content on {path}` | P3 | `seo,geo` |
| Page missing from sitemap | `GEO: Add {path} to sitemap` | P2 | `seo,geo` |
| Page missing from llms.txt | `GEO: Add {path} to llms.txt` | P2 | `seo,geo` |
| OG tags missing/generic | `GEO: Fix OG tags on {path}` | P2 | `seo,geo` |
| AI bot not in robots.txt | `GEO: Add {bot} to robots.txt` | P1 | `seo,geo` |
| New unknown AI referrer | `GEO: Investigate new AI referrer {source}` | P2 | `seo,geo` |
| AI referral traffic down >30% MoM | `GEO: Investigate {source} traffic drop ({pct}%)` | P1 | `seo,geo` |

**Deduplication**: Before creating, search for existing open issues with the same title prefix:
```bash
gh issue list --state open --search "GEO:" --limit 100 --json number,title
```
Skip any issue that already exists.

---

## Phase 4: Present Report

Show the user a structured report BEFORE creating issues:

```markdown
## GEO Audit Report — {DATE}

**Period**: Last 30 days (Umami) | Last 7 days (Clarity)
**Sources**: Umami {ok/fail} | Clarity {ok/fail}

### AI Referral Traffic (Last 30 Days)
| Source | Sessions | Prev Period | Trend |
|--------|----------|-------------|-------|
| chatgpt.com | X | Y | +/-Z% |
| claude.ai | X | Y | +/-Z% |
| ... | | | |
| **Total AI** | **X** | **Y** | **+/-Z%** |

### Top AI Landing Pages
| Page | AI Sessions | % of Total |
|------|-------------|------------|
| /blog/... | X | Y% |

### Page GEO Compliance
| Page | JSON-LD | OG Tags | dateModified | Sitemap | llms.txt |
|------|---------|---------|--------------|---------|----------|
| / | ok/missing | ok/generic | fresh/stale/missing | ok/missing | ok/missing |
| /pricing | ... | ... | ... | ... | ... |

### robots.txt AI Bot Coverage
| Bot | Status |
|-----|--------|
| GPTBot | allowed/blocked/not mentioned |
| ClaudeBot | ... |

### Proposed Issues ({N} total, {M} new after dedup)
| # | Priority | Title | Reason |
|---|----------|-------|--------|
| 1 | P1 | GEO: Add GPTBot to robots.txt | Sending traffic but not in robots.txt |
| 2 | P2 | GEO: Add structured data to /pricing | No JSON-LD found |

**Create these as GitHub issues?** (yes / adjust / pick specific ones)
```

**Quality rules:**
- Interpret the data — "5 sessions from ChatGPT" is data. "ChatGPT is our fastest-growing AI channel, up 200% MoM, landing primarily on /blog/web-scraping-api — optimize that page first" is an insight.
- Quantify every finding with actual numbers from the data.
- Be honest about small sample sizes.

---

## Phase 5: Create GitHub Issues

**Only after user confirms.** If "adjust" — modify. If specific ones — only create those.

For each approved issue:
```bash
gh issue create \
  --title "{fix|feat}: {concise description}" \
  --label "{priority},{labels}" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what the GEO audit found is wrong or missing. Current state with specific numbers.}

## Root Cause (if known)

{Why this AI discoverability gap exists — missing metadata, stale content, wrong file, etc. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Measurable criterion}
- [ ] Verified in next GEO audit

## Context

Identified in GEO audit on {DATE}.
**Data Sources**: Umami, Clarity, page crawl
**Period**: Last 30 days

## Evidence

{Specific data points — referral counts, missing elements, stale dates}

## Recommended Fix

{Concrete technical steps}
BODY_EOF
)"
```

If a `geo-ai-discoverability` milestone exists, assign issues to it:
```bash
gh issue edit {NUMBER} --milestone "geo-ai-discoverability"
```

### Add GEO issues to Project board

Read project board IDs from `forge.yaml → project_board`. If `project_board` is not configured, skip board integration.

```bash
# Read project board config from forge.yaml
BOARD_CONFIG=$(python3 - <<'PYEOF'
import yaml, sys
cfg = yaml.safe_load(open('forge.yaml'))
board = cfg.get('project_board', {})
if not board:
    print('')
    sys.exit(0)
print(board.get('owner', cfg.get('project', {}).get('owner', '')))
print(str(board.get('project_number', '')))
print(board.get('project_id', ''))
PYEOF
)

BOARD_OWNER=$(echo "$BOARD_CONFIG" | sed -n '1p')
BOARD_NUMBER=$(echo "$BOARD_CONFIG" | sed -n '2p')
BOARD_ID=$(echo "$BOARD_CONFIG" | sed -n '3p')

if [ -n "$BOARD_OWNER" ] && [ -n "$BOARD_NUMBER" ]; then
  ISSUE_URL="https://github.com/$GH_REPO/issues/${ISSUE_NUM}"
  ITEM_ID=$(gh project item-add "$BOARD_NUMBER" --owner "$BOARD_OWNER" --url "$ISSUE_URL" --format json --jq '.id' 2>/dev/null)
  if [ -n "$ITEM_ID" ] && [ -n "$BOARD_ID" ]; then
    # Set Status, Lane, Priority using field IDs from forge.yaml → project_board.field_ids
    # See docs/CONFIG.md → project_board section for how to get field IDs
    echo "Issue added to project board. Set Status/Lane/Priority manually or configure field_ids in forge.yaml."
  fi
fi
```

---

## Phase 6: Summary

```markdown
## GEO Audit Complete

### Issues Created
| # | Issue | Priority |
|---|-------|----------|

### Key Findings
1. {Most important insight}
2. {Second insight}
3. {Third insight}

### Next Steps
- `/work-on #{first}` for highest priority issue
- Re-run `/geo-audit` in 2-4 weeks to track progress
- Check `/analytics` for broader traffic context
```

---

## Error Handling

- **forge.yaml missing**: Print setup instructions and exit. Do not proceed without config.
- **services.analytics missing**: Print configuration instructions and exit.
- **Umami auth fails**: Try SOPS credentials. If still broken, skip Umami and note in report.
- **Clarity MCP fails**: Skip Clarity data, proceed with Umami only.
- **curl to site fails**: Report "Site unreachable — cannot run compliance checks" and only show referral data.
- **No AI referral data at all**: Report "No AI referral traffic detected in the last 30 days" — this IS an insight (we need to improve discoverability).
- **Rate limits or timeouts**: Note which checks were incomplete. Partial audit > no audit.
