---
description: "Run a GEO audit — check AI referral traffic, page compliance, and auto-create improvement issues"
---

# /geo-audit — GEO Discoverability Audit & Issue Generator

You are the GEO (Generative Engine Optimization) auditor. Pull AI referral data from Umami and Clarity, check every public page for GEO compliance (structured data, OG tags, freshness, sitemap, llms.txt), and auto-create GitHub issues for gaps.

**You have access to ALL tools** — MCP tools for Clarity, Bash for Umami/curl checks, gh CLI for issues.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

---

## Constants

```
DOMAIN = "alterlab.io"
SITE_URL = "https://alterlab.io"
UMAMI_WEBSITE_ID = "ccfb1cdd-5a05-4b41-8e61-48695b4ff6c0"
UMAMI_API = "https://umami.alterlab.io"
CLARITY_PROJECT = "v28wblv737"
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

Authenticate with Umami (credentials from `credentials.yaml`):
```bash
UMAMI_USER=$(python3 -c "import yaml; print(yaml.safe_load(open('/home/mrdubey/projects/ScraperAPI/credentials.yaml'))['umami']['username'])")
UMAMI_PASS=$(python3 -c "import yaml; print(yaml.safe_load(open('/home/mrdubey/projects/ScraperAPI/credentials.yaml'))['umami']['password'])")
UMAMI_TOKEN=$(curl -s -X POST "https://umami.alterlab.io/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$UMAMI_USER\",\"password\":\"$UMAMI_PASS\"}" | jq -r '.token')
```

Then pull referrer metrics for the last 30 days:
```bash
START_AT=$(date -d '30 days ago' +%s)000
END_AT=$(date +%s)000
curl -s "https://umami.alterlab.io/api/websites/ccfb1cdd-5a05-4b41-8e61-48695b4ff6c0/metrics?startAt=${START_AT}&endAt=${END_AT}&type=referrer" \
  -H "Authorization: Bearer $UMAMI_TOKEN" | jq '.'
```

From the results, filter for AI_REFERRERS. Record each AI referrer's session count. If a referrer appears that is NOT in our known list but looks AI-related (contains "ai", "chat", "copilot", "assistant"), flag it as a new AI referrer.

Also pull landing page metrics to see WHERE AI traffic lands:
```bash
curl -s "https://umami.alterlab.io/api/websites/ccfb1cdd-5a05-4b41-8e61-48695b4ff6c0/metrics?startAt=${START_AT}&endAt=${END_AT}&type=url" \
  -H "Authorization: Bearer $UMAMI_TOKEN" | jq '.'
```

For previous period comparison (30-60 days ago):
```bash
PREV_START=$(date -d '60 days ago' +%s)000
PREV_END=$(date -d '30 days ago' +%s)000
curl -s "https://umami.alterlab.io/api/websites/ccfb1cdd-5a05-4b41-8e61-48695b4ff6c0/metrics?startAt=${PREV_START}&endAt=${PREV_END}&type=referrer" \
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
curl -s "https://alterlab.io/sitemap.xml" | grep -oP '<loc>\K[^<]+' | sort
```

Also check llms.txt for listed pages:
```bash
curl -s "https://alterlab.io/llms.txt"
```

And the full version:
```bash
curl -s "https://alterlab.io/llms-full.txt"
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
- PASS: og:title exists and is NOT the generic site default (e.g., not just "AlterLab" or empty)
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
curl -s "https://alterlab.io/robots.txt"
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

For each created issue, add to the GitHub Project. Reference `~/projects/forge/docs/WORKFLOW.md` → "Project Board Integration" for field IDs.

```bash
ISSUE_URL="https://github.com/RapierCraft/AlterLab/issues/${ISSUE_NUM}"
ITEM_ID=$(gh project item-add 1 --owner RapierCraft --url "$ISSUE_URL" --format json --jq '.id' 2>/dev/null)
if [ -n "$ITEM_ID" ]; then
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF6E --single-select-option-id f75ad846 2>/dev/null || true  # Status=Todo
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF98 --single-select-option-id 62864af4 2>/dev/null || true  # Lane=Fast
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF-o --single-select-option-id 214c4d65 2>/dev/null || true  # Component=Platform
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF8o --single-select-option-id {PRIORITY_OPTION_ID} 2>/dev/null || true  # Priority
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

- **Umami auth fails**: Try SOPS credentials. If still broken, skip Umami and note in report.
- **Clarity MCP fails**: Skip Clarity data, proceed with Umami only.
- **curl to alterlab.io fails**: Report "Site unreachable — cannot run compliance checks" and only show referral data.
- **No AI referral data at all**: Report "No AI referral traffic detected in the last 30 days" — this IS an insight (we need to improve discoverability).
- **Rate limits or timeouts**: Note which checks were incomplete. Partial audit > no audit.
