---
description: Full platform QA sweep — auto-discovers every page, tests every UI element via browser automation, creates GitHub issues for all findings
argument-hint: [all | dashboard | marketing | page <route> | journey | visual | functional | a11y]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /qa-sweep — Platform-Wide QA Testing

**Input**: $ARGUMENTS

You are the QA orchestrator. Auto-discover every page across the platform (dashboard, marketing, blog, auth, docs, pricing), then systematically test every UI element, interaction, workflow, and state transition using browser automation. Create GitHub issues for every finding.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`.
**NEVER use plan mode (EnterPlanMode).**

---

## Browser Tool Reference

All browser automation uses Playwright MCP tools (`mcp__playwright__*`).

| Action | Tool | Key param |
|--------|------|-----------|
| Navigate | `browser_navigate` | `url` |
| Snapshot (a11y tree + refs) | `browser_snapshot` | — |
| Screenshot | `browser_take_screenshot` | — |
| Click | `browser_click` | `ref` |
| Type | `browser_type` | `ref`, `text`, `submit?`, `slowly?` |
| Fill form | `browser_fill_form` | fields array |
| Press key | `browser_press_key` | key name |
| Wait | `browser_wait_for` | `text`/`textGone`/`time` |
| Console | `browser_console_messages` | `level` |
| Network | `browser_network_requests` | `filter`, `static:false` |
| Evaluate JS | `browser_evaluate` | `function` |
| Resize | `browser_resize` | `width`, `height` |
| Hover | `browser_hover` | `ref` |
| Select | `browser_select_option` | `ref` |
| Dialog | `browser_handle_dialog` | `accept` |
| Tabs | `browser_tabs` | `action` |
| Back | `browser_navigate_back` | — |

**Workflow**: Always snapshot → get refs → interact using refs.

---

## Testing Philosophy

Depth-first, workflow-driven:
1. Test **features** not pages — "upgrading a plan" not "billing page"
2. Verify **state mutations** — click Create, verify item appears, persists on reload
3. Test **combinations** — filter + sort + paginate together
4. Test **unhappy path harder** — invalid inputs, boundary values, double-clicks, empty states
5. Every interaction gets **before/after check** + console error check + network check

---

## What to Test (per page)

### Functional
- **Buttons**: Click → verify outcome. Check loading/disabled states. Double-click test.
- **Forms**: Happy path (fill all, submit, verify persistence on reload). Empty submit (inline errors). Partial fill. Boundary values (0, -1, 999999999). Special chars (`<script>`, SQL injection, emoji, unicode). Tab order. Paste overflow. Cancel/reset.
- **Links**: Verify destination. Check for 404s. External → new tab.
- **Dropdowns**: All options present. Selection persists. Searchable filtering.
- **Modals**: Open/close (X, backdrop, Escape). Forms inside. Scroll lock. Fresh state on reopen.
- **Tables**: Sort each column (verify data reorders). Filter (individual + combined). Pagination (page 2+, filter resets to p1). Empty results. Row actions target correct row.
- **Search**: Valid query → relevant results. Gibberish → empty state. Clear → all return. Debounce check.
- **Delete/Destructive**: Confirmation dialog. Cancel = no-op. Confirm = removed + persists on reload.
- **Toggles**: On/off verify persistence on reload. Rapid toggle stress test.

### Visual & Design
- Number formatting consistency across all displays
- Typography, spacing, colors, icons, alignment, hover/focus states
- Truncation (ellipsis, not overflow), empty areas, card consistency
- **Squint test**: What draws the eye? Is visual hierarchy correct? Do destructive actions use muted styling? Does anything look bolted-on or AI-generated without design review?

### Accessibility
- Alt text on images, aria-labels on interactive elements, labels on inputs
- Keyboard navigation (Tab order logical, all elements reachable, focus ring visible)
- Color not sole information channel

---

## Command Router

| Input | Action |
|-------|--------|
| `all` / empty | Full sweep: all pages + journeys |
| `dashboard` | Dashboard pages + dashboard journeys |
| `marketing` | Public/marketing pages + conversion journey |
| `page <route>` | Deep single-page test |
| `journey` | Cross-page workflow testing only |
| `visual` / `functional` / `a11y` | All pages, restricted scope |
| `diff` | Only pages with changed files (staging vs main) |

---

## Phase 0: Setup & Auth

**Load config from forge.yaml** before running any checks:

```bash
QA_CONFIG=$(python3 - <<'PYEOF'
import yaml, sys, os

config_path = os.environ.get('FORGE_CONFIG', 'forge.yaml')
try:
    cfg = yaml.safe_load(open(config_path))
except FileNotFoundError:
    print('ERROR: forge.yaml not found. Run `cp forge.yaml.example forge.yaml` and configure your project.')
    sys.exit(1)

paths = cfg.get('paths', {})
root = paths.get('root', '')
if not root:
    print('ERROR: forge.yaml missing paths.root — qa-sweep needs the project root to discover pages and start services.')
    sys.exit(1)

svc = cfg.get('services', {})
app_url = svc.get('app_url', 'http://localhost:3000')
api_url = svc.get('api_url', 'http://localhost:8000')

# Read QA credentials from credentials file (graceful: empty string if not set)
creds = paths.get('credentials', {})
creds_file = creds.get('file', '') if isinstance(creds, dict) else ''
qa_user = ''
qa_pass = ''
if creds_file:
    try:
        creds_data = yaml.safe_load(open(creds_file))
        qa_section = creds_data.get('qa', {})
        qa_user = qa_section.get('username', '')
        qa_pass = qa_section.get('password', '')
    except (FileNotFoundError, AttributeError):
        pass  # Credentials file optional — will surface as empty QA_USER/QA_PASS

print(root)
print(app_url)
print(api_url)
print(qa_user)
print(qa_pass)
PYEOF
)

if echo "$QA_CONFIG" | grep -q '^ERROR:'; then
    echo "$QA_CONFIG"
    exit 1
fi

PROJECT_ROOT=$(echo "$QA_CONFIG" | sed -n '1p')
APP_URL=$(echo "$QA_CONFIG" | sed -n '2p')
API_URL=$(echo "$QA_CONFIG" | sed -n '3p')
QA_USER=$(echo "$QA_CONFIG" | sed -n '4p')
QA_PASS=$(echo "$QA_CONFIG" | sed -n '5p')

if [ -z "$QA_USER" ] || [ -z "$QA_PASS" ]; then
    echo "WARNING: QA credentials not configured in credentials file."
    echo "Add qa.username and qa.password to the credentials file at paths.credentials.file in forge.yaml."
    echo "Proceeding — login step will require manual credential entry."
fi
```

1. Verify services: `curl -s -o /dev/null -w "%{http_code}" $APP_URL` and `$API_URL/api/v1/health`
2. If down: `cd $PROJECT_ROOT && docker compose up -d --build web api`
3. Login via Playwright: navigate `/auth/login`, fill `$QA_USER` / `$QA_PASS`, submit
4. Capture baseline data from dashboard/sidebar: balance (exact number + format), user info, plan/tier, notification counts, nav items

---

## Phase 1: Auto-Discover Pages

**Dynamic discovery from filesystem** (NOT hardcoded):

```bash
# Read pages root from forge.yaml review.layout.pages, fall back to web/src/app
PAGES_ROOT=$(yq '.review.layout.pages // "web/src/app"' $PROJECT_ROOT/forge.yaml 2>/dev/null || echo "web/src/app")

cd $PROJECT_ROOT/$PAGES_ROOT
PAGES=$(find . -name "page.tsx" -o -name "page.js" | sort)

# Loud failure when zero pages found — prevents silent no-op qa-sweep runs
if [ -z "$PAGES" ]; then
  echo "ERROR: Zero pages discovered under $PAGES_ROOT. If your project uses a different layout, set review.layout.pages in forge.yaml (e.g., 'apps/web/src/app' or 'src/pages')."
  exit 1
fi

echo "$PAGES"
```

Convert paths to routes: `./dashboard/billing/page.tsx` → `/dashboard/billing`

**Categorize**: Dashboard (auth required), Auth, Marketing, Blog/Docs, Other.

**Resolve dynamic routes** (`[param]`) by fetching real IDs from API. Test invalid IDs too.

**For `diff` mode**: `git diff --name-only origin/main...origin/staging -- $PAGES_ROOT/` → map to affected pages.

**Present test plan to user** (page count by category, journey count, estimated waves). Wait for confirmation.

---

## Phase 2: Spawn Page Agents

Group into waves of ~3. Priority order: dashboard core → financial → tools → marketing → content → auth → edge cases.

Each agent prompt includes:
- Page route, category, auth requirement
- Baseline data for cross-page comparison
- Browser tool reference
- Full testing protocol: Element Inventory → Feature Identification → Workflow Testing (happy/unhappy/edge) → Visual Audit → Mobile (393x852) → Accessibility → Cross-page consistency

**Mobile testing**: Resize to 393x852, verify single-column layout, no overflow, touch targets >=44px, forms usable, modals fit. Re-test critical features at mobile size.

---

## Phase 2B: User Journey Agents

Cross-page workflow testing. Spawn after (or parallel to) per-page agents.

**Standard journeys** (build dynamically from discovered pages):
1. New User Onboarding (register → dashboard → keys → playground)
2. API Key Lifecycle (list → create → detail → edit → delete → verify gone)
3. Scrape → Verify → Export (playground → usage → jobs)
4. Billing & Plan Management (billing → pricing → settings, verify consistency)
5. Batch Operations (list → create → detail → usage)
6. Navigation Consistency (all dashboard pages: active states, titles, balance, back/forward)
7. Error Recovery (404s, unsaved changes, failed submissions, logged-out access)
8. Marketing → Conversion (homepage → pricing → register/checkout)

Each journey agent: maintain state ledger, verify outcomes cross-step, report data inconsistencies.

---

## Phase 3: Collect Results & Create Issues

1. Parse all agent findings
2. Deduplicate (prefer journey context over page-only findings)
3. Reprioritize: found in 3+ pages → bump severity; blocks journey → P0
4. Create GitHub issues:

```bash
gh issue create --title "{fix|feat}: {title} on {page}" --label "qa,{bug_or_enhancement},{priority}" --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what the QA sweep found. What's broken or missing, with specific observable behavior.}

## Root Cause (if known)

{Where in the code the issue originates — component, route, state condition. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}
- [ ] Verified in next QA sweep on {page}
- [ ] No regression on cross-page {related feature}

## Context

**Source**: QA sweep on {DATE}
**Page**: {page}
**Device**: {Desktop/Mobile}
**Type**: {Bug|UX|Performance|Accessibility}
**Severity**: {P0|P1|P2|P3}
**Journey context**: {Which user journey was affected, if any}

## Steps to Reproduce

1. {Step 1}
2. {Step 2}
3. Expected: {expected behavior}
4. Actual: {actual behavior}

## Cross-Page Impact

{List other pages where this issue was also observed, or "None"}
BODY_EOF
)"
```

Issue body includes: Source, Page, Device, Type, Severity, Journey context, Description, Steps to Reproduce, State Context, Cross-Page Impact.

5. Cross-page consistency table (compare balance/tier/email across all pages)
6. Journey results table (status, steps completed, issues found)

---

## Phase 4: Summary & Ship Decision

Report: pages tested, journeys tested, issues by severity/type/page, journey results.

**Ship decision checklist**: All P0 resolved, all journeys PASS, no console errors, no 4xx/5xx on load, cross-page consistency verified, mobile not broken.

If P0/journey blockers exist → DO NOT SHIP. If only P2/P3 → SHIP WITH KNOWN ISSUES.

Next steps: `/orchestrate` on P0/P1 issues before deploy.

---

## Safety Rules

1. NEVER modify production data — only read/interact. CAN create+delete test data.
2. Test user only: `$QA_USER` (configured in credentials file via forge.yaml)
3. Handle dialogs gracefully (accept/dismiss, don't leave hanging)
4. Snapshot before interactions
5. Check console after EVERY interaction
6. Clean up test data before finishing
7. If a step fails, record and continue
