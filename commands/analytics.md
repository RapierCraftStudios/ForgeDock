---
description: Pull production analytics from GSC, Bing Webmaster, Clarity, Umami, Cloudflare, Stripe, and GA4 — generate insights and create actionable GitHub issues. Trigger when user says things like "check analytics", "look at prod analytics", "make issues from analytics", "what's happening on the site", "audit the site", "check revenue", etc.
---

# /analytics — Production Analytics Audit & Issue Generator

You are the analytics orchestrator. Pull data from ALL available analytics platforms (Google Search Console, Bing Webmaster, Microsoft Clarity, Umami, Cloudflare, Google Analytics 4), cross-reference the findings, generate actionable insights, and decompose them into concrete GitHub issues that the `/work-on` pipeline can pick up.

**You have access to ALL tools** — MCP tools for GSC/Clarity/Stripe, Bash for Umami/Cloudflare/Bing APIs, Agent tool for parallel data collection.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`. Pass the resolved model in every `Agent` tool call. Each agent prompt includes specific queries, exact API endpoints, and the credentials file path so the model can execute without guessing.

---

## Config Preamble (REQUIRED — run before anything else)

**Before any data collection, credentials access, or phase execution**, read `forge.yaml` from the project root and resolve all constants. If the config is missing or incomplete, stop and tell the user what to add.

```bash
# Locate forge.yaml (project root = directory containing the forge.yaml file)
FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"

if [ ! -f "$FORGE_YAML" ]; then
  echo "ERROR: forge.yaml not found at $FORGE_YAML"
  echo ""
  echo "The /analytics command requires forge.yaml to be configured."
  echo "Run: cp forge.yaml.example forge.yaml"
  echo "Then fill in the required sections (project, paths, branches) and the"
  echo "optional services.analytics section for this command."
  exit 1
fi

# Read config with Python (YAML parser — values are shell-quoted via shlex.quote)
ANALYTICS_CONFIG=$(python3 -c "
import yaml, sys, shlex
cfg = yaml.safe_load(open(sys.argv[1]))
svc = cfg.get('services', {})
analytics = svc.get('analytics', None)
if analytics is None:
    print('MISSING_ANALYTICS_CONFIG')
    sys.exit(0)
paths = cfg.get('paths', {})
creds = paths.get('credentials', {})
project = cfg.get('project', {})
board = cfg.get('project_board', {})
print('CREDENTIALS_FILE=' + shlex.quote(str(creds.get('file', ''))))
print('DOMAIN=' + shlex.quote(str(svc.get('domain', ''))))
print('SITE_URL=' + shlex.quote(str(svc.get('gsc_property', ''))))
print('HISTORY_FILE=' + shlex.quote(str(analytics.get('history_file', ''))))
print('UMAMI_URL=' + shlex.quote(str(analytics.get('umami', {}).get('url', ''))))
print('UMAMI_WEBSITE_ID=' + shlex.quote(str(analytics.get('umami', {}).get('website_id', ''))))
print('GA4_PROPERTY_ID=' + shlex.quote(str(analytics.get('ga4', {}).get('property_id', ''))))
print('GA4_SERVICE_ACCOUNT_KEY=' + shlex.quote(str(analytics.get('ga4', {}).get('service_account_key', ''))))
print('REPO_PATH=' + shlex.quote(str(cfg.get('paths', {}).get('root', ''))))
print('GH_REPO=' + shlex.quote(str(project.get('owner', '')) + '/' + str(project.get('repo', ''))))
print('PROJECT_BOARD_OWNER=' + shlex.quote(str(board.get('owner', project.get('owner', '')))))
print('PROJECT_NUMBER=' + shlex.quote(str(board.get('project_number', ''))))
print('PROJECT_ID=' + shlex.quote(str(board.get('project_id', ''))))
" "$FORGE_YAML")

if echo "$ANALYTICS_CONFIG" | grep -q "MISSING_ANALYTICS_CONFIG"; then
  echo "ERROR: forge.yaml is missing the 'services.analytics' section."
  echo ""
  echo "Add the following to your forge.yaml to use /analytics:"
  echo ""
  echo "  services:"
  echo "    domain: \"your-domain.com\""
  echo "    gsc_property: \"https://your-domain.com\""
  echo "    analytics:"
  echo "      history_file: \"/path/to/analytics-history.yaml\""
  echo "      umami:"
  echo "        url: \"https://umami.your-domain.com\""
  echo "        website_id: \"your-umami-website-id\""
  echo "      ga4:"
  echo "        property_id: \"your-ga4-property-id\""
  echo "        service_account_key: \"/path/to/ga4-service-account.json\""
  echo ""
  echo "See docs/CONFIG.md for the full services.analytics schema."
  exit 1
fi

# Export resolved constants — all downstream phases use these variables
# Values are shell-quoted by the Python block above; eval is safe against metacharacters in forge.yaml values
eval "$ANALYTICS_CONFIG"
```

All downstream phases use these resolved constants: `{CREDENTIALS_FILE}`, `{DOMAIN}`, `{SITE_URL}`, `{HISTORY_FILE}`, `{UMAMI_URL}`, `{UMAMI_WEBSITE_ID}`, `{GA4_PROPERTY_ID}`, `{GA4_SERVICE_ACCOUNT_KEY}`, `{REPO_PATH}`, `{GH_REPO}`.

---

## Credentials

**ALL credentials live in one file** at the path resolved from `forge.yaml → paths.credentials.file` (`{CREDENTIALS_FILE}`).

Agents MUST read this file for API keys, tokens, and login creds. Do NOT grep SOPS, do NOT hardcode tokens, do NOT look in `.mcp.json`.

```bash
# Read any credential:
python3 -c "import yaml; creds=yaml.safe_load(open('{CREDENTIALS_FILE}')); print(creds['section']['key'])"
```

---

## Constants

```
CREDENTIALS_FILE = {forge.yaml → paths.credentials.file}
SITE_URL         = {forge.yaml → services.gsc_property}
DOMAIN           = {forge.yaml → services.domain}
HISTORY_FILE     = {forge.yaml → services.analytics.history_file}
TODAY = (current date in YYYY-MM-DD)
SEVEN_DAYS_AGO = (TODAY minus 7 days)
TWENTY_EIGHT_DAYS_AGO = (TODAY minus 28 days)
SEO_RECENT_CHANGE_DAYS = 30
```

All platform-specific constants (project IDs, zone IDs, API keys, base URLs) are in `{CREDENTIALS_FILE}` — read them from there.

---

## Phase 0: Load Audit History

**Before any data collection**, read the persistent audit history file. This gives you a multi-run baseline for trend analysis and tells you what issues were created in past audits so you can measure their impact and avoid duplicates.

```bash
HISTORY_FILE="{HISTORY_FILE}"

if [ -f "$HISTORY_FILE" ]; then
  HISTORY_AVAILABLE=true
  # Read last 5 audit snapshots (Python for YAML parsing — same pattern as credentials file)
  python3 -c "
import yaml, json, sys
history = yaml.safe_load(open(sys.argv[1])) or []
# Keep only last 5 entries
recent = history[-5:] if len(history) >= 5 else history
print(json.dumps(recent, indent=2))
" "$HISTORY_FILE"
else
  HISTORY_AVAILABLE=false
  echo 'First audit — no historical baseline. History file will be created at end of this run.'
fi
```

**What to extract when HISTORY_AVAILABLE=true**:
- Last 3-5 audit dates and key metric values (for multi-audit trend table in Phase 3)
- All `issues_created` entries from recent audits (for Phase 2.5 impact validation and Issue Quality Gate duplicate check)
- Tracking integrity verdicts from past runs (context for interpreting current integrity)

**Graceful degradation**: If the file is missing, corrupt, or unreadable — set `HISTORY_AVAILABLE=false`, note it in the report, and proceed. All history-dependent sections in Phase 3 are gated on `HISTORY_AVAILABLE` and will be omitted cleanly.

---

## Phase 1: Data Collection (Parallel)

Launch ALL 7 data collection agents simultaneously using `run_in_background=true`. Every audit pulls from every platform — no scoping, no arguments.

### Agent 1: GSC Data Collector

Launch as a background Agent (subagent_type: general-purpose, model: sonnet):

**Mission**: Collect Google Search Console data for `{DOMAIN}`. Use the MCP GSC tools directly.

**Queries to run:**

1. **Overall performance (last 28 days)** — `mcp__gsc__enhanced_search_analytics` with dimensions: "date", rowLimit: 28
2. **Top queries by impressions (last 28 days)** — dimensions: "query", rowLimit: 50
3. **Top pages by clicks (last 28 days)** — dimensions: "page", rowLimit: 50
4. **Device breakdown** — dimensions: "device"
5. **Country breakdown** — dimensions: "country", rowLimit: 20
6. **Quick wins** — `mcp__gsc__detect_quick_wins` with minImpressions: 30, positionRangeMin: 4, positionRangeMax: 20, maxCtr: 3
7. **Previous 28 days** (for trend comparison) — same query/page queries but for the prior period

All queries use `siteUrl: "{SITE_URL}"`.

**Return**: Total clicks, impressions, avg CTR, avg position (current + previous + % change). Top 20 queries and pages. Quick wins list. Device/country splits. Rising and declining queries.

### Agent 2: Clarity Data Collector

Launch as a background Agent (subagent_type: general-purpose, model: sonnet):

**Mission**: Collect Microsoft Clarity behavior analytics. Use `mcp__clarity__query-analytics-dashboard` and `mcp__clarity__list-session-recordings` tools.

**Dashboard queries** (each is a separate `query-analytics-dashboard` call):
- "Total sessions last 7 days"
- "Distinct users last 7 days"
- "Average session duration last 7 days"
- "Bounce rate last 7 days"
- "Dead clicks count last 7 days"
- "Rage clicks count last 7 days"
- "Quick backs count last 7 days"
- "Top pages by page views last 7 days"
- "Top channels last 7 days"
- "Top referrers last 7 days"
- "Average largest contentful paint last 7 days"
- "Average cumulative layout shift last 7 days"
- "Top javascript errors last 7 days"
- "Smart events last 7 days"

**Session recordings** (use `list-session-recordings`):
- Rage click sessions: `rageClickPresent: true`, last 7 days, count: 10
- Dead click sessions: `deadClickPresent: true`, last 7 days, count: 10

**Return**: Session summary, UX health (rage/dead/quick-back rates), CWV ratings, JS errors, traffic sources, recording links for problem sessions.

### Agent 3: Umami Data Collector

Launch as a background Agent (subagent_type: general-purpose, model: sonnet):

**Mission**: Collect Umami analytics via REST API.

**Auth**: Read credentials from `{CREDENTIALS_FILE}` (under `umami:`), then authenticate:
```bash
# Read umami creds
python3 -c "import yaml; c=yaml.safe_load(open('{CREDENTIALS_FILE}')); print(c['umami']['username'], c['umami']['password'])"
# Login: POST {UMAMI_URL}/api/auth/login with {"username": "...", "password": "..."}
```

**Queries** (all use website ID `{UMAMI_WEBSITE_ID}`, last 28 days):
- `/api/websites/{id}/stats` — overall stats
- `/api/websites/{id}/pageviews?unit=day` — daily trend
- `/api/websites/{id}/metrics?type=url` — top pages
- `/api/websites/{id}/metrics?type=referrer` — referrers
- `/api/websites/{id}/metrics?type=country` — countries
- `/api/websites/{id}/metrics?type=browser` — browsers
- `/api/websites/{id}/metrics?type=device` — devices
- `/api/websites/{id}/metrics?type=event` — custom events

**If auth or API fails**: Report "Umami data unavailable" and return what you have. Do NOT block the audit.

**Return**: Pageviews, unique visitors, bounce rate, avg duration, top pages, referrers, countries, devices, events, daily trends.

### Agent 4: Cloudflare Data Collector

Launch as a background Agent (subagent_type: general-purpose, model: sonnet):

**Mission**: Collect Cloudflare traffic/performance data via GraphQL API.

**Auth**: Read from `{CREDENTIALS_FILE}`:
```bash
CF_TOKEN=$(python3 -c "import yaml; print(yaml.safe_load(open('{CREDENTIALS_FILE}'))['cloudflare']['api_token'])")
CF_ZONE=$(python3 -c "import yaml; print(yaml.safe_load(open('{CREDENTIALS_FILE}'))['cloudflare']['zone_id'])")
```

**GraphQL queries** (zone from `{CREDENTIALS_FILE} → cloudflare.zone_id`, last 7 days):
1. HTTP requests daily — requests, pageViews, bytes, cachedBytes, threats, countryMap, uniques
2. Status code breakdown — responseStatusMap
3. Threats/bot traffic — threatPathingMap
4. Bandwidth & cache — bytes, cachedBytes, encryptedBytes
5. Content types — contentTypeMap

**If API fails**: Report "Cloudflare data unavailable" and return what you have.

**Return**: Total requests, page views, uniques, cache hit ratio, bandwidth, threat count, status code distribution, top countries, daily trends.

### Agent 5: Bing Webmaster Data Collector

Launch as a background Agent (subagent_type: general-purpose, model: sonnet):

**Mission**: Collect Bing Webmaster Tools data for `{DOMAIN}` via REST API. Bing powers ChatGPT search, so Bing indexing/ranking data = AI discoverability signal.

**Auth**: Read from `{CREDENTIALS_FILE}`:
```bash
BING_KEY=$(python3 -c "import yaml; print(yaml.safe_load(open('{CREDENTIALS_FILE}'))['bing_webmaster']['api_key'])")
BING_SITE=$(python3 -c "import yaml; print(yaml.safe_load(open('{CREDENTIALS_FILE}'))['bing_webmaster']['site_url'])")
BING_BASE=$(python3 -c "import yaml; print(yaml.safe_load(open('{CREDENTIALS_FILE}'))['bing_webmaster']['api_base'])")
```

**Auth method**: Query param `?apikey={BING_KEY}`
**Site URL**: URL-encode the site_url value from `{CREDENTIALS_FILE} → bing_webmaster.site_url` in siteUrl param

**Queries to run:**

1. **Query stats** — `GetQueryStats?siteUrl={site}&apikey={key}` — Bing search queries with impressions, clicks, position
2. **Crawl stats** — `GetCrawlStats?siteUrl={site}&apikey={key}` — How well Bing is crawling the site
3. **URL traffic info** — `GetUrlTrafficInfo?siteUrl={site}&apikey={key}` — Pages getting Bing traffic
4. **Keyword data** — `GetKeywordData?siteUrl={site}&apikey={key}` — Keywords we rank for on Bing

**If any endpoint fails**: Log the error and continue with what you have. Bing API can be flaky.

**Return**: Top Bing queries (impressions, clicks, position), crawl health (pages crawled, errors, crawl rate), top pages by Bing traffic, keyword rankings. Compare with GSC data where possible — Bing vs Google ranking differences are interesting (especially for ChatGPT discoverability).

### Agent 6: Stripe Revenue Collector

Launch as a background Agent (subagent_type: general-purpose, model: sonnet):

**Mission**: Collect Stripe billing and revenue data using Stripe MCP tools. First load them via `ToolSearch query: "+stripe"`, then call the relevant tools.

**Data to collect:**

1. **Active subscriptions** — list subscriptions with status=active, count and group by price/plan
2. **MRR calculation** — sum of active subscription amounts (monthly normalized)
3. **Recent charges (last 28 days)** — total revenue, successful vs failed count
4. **Failed payments (last 28 days)** — list failed charges with failure reasons and customer info
5. **Refunds/disputes (last 28 days)** — any refunds or disputes opened
6. **New customers (last 28 days)** — count of customers created
7. **Churned subscriptions (last 28 days)** — subscriptions canceled in the period
8. **Balance** — current Stripe balance and pending payouts

**If Stripe MCP is unavailable**: Report "Stripe data unavailable" and return what you have. Do NOT block the audit.

**Return**: MRR, total revenue (period), active subscriber count, new customers, churn count, failed payment count + top failure reasons, refund/dispute count, net revenue trend. Flag any customers with repeated failed payments (involuntary churn risk).

### Agent 7: GA4 Data Collector

Launch as a background Agent (subagent_type: general-purpose, model: sonnet):

**Mission**: Collect Google Analytics 4 data via the GA4 Data API (v1beta) using a service account.

**Auth**: JWT-based service account authentication:
```bash
# Service account key and property ID resolved from forge.yaml:
SA_KEY="{GA4_SERVICE_ACCOUNT_KEY}"
GA4_PROPERTY_ID="{GA4_PROPERTY_ID}"

# Generate JWT and exchange for access token:
python3 -c "
import json, sys, time, jwt, requests
sa = json.load(open(sys.argv[1]))
now = int(time.time())
payload = {'iss': sa['client_email'], 'scope': 'https://www.googleapis.com/auth/analytics.readonly', 'aud': sa['token_uri'], 'iat': now, 'exp': now + 3600}
signed = jwt.encode(payload, sa['private_key'], algorithm='RS256')
token = requests.post(sa['token_uri'], data={'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion': signed}).json()['access_token']
print(token)
" "$SA_KEY"
```

If `jwt` (PyJWT) is not installed, use: `pip install PyJWT requests`

**API Base**: `https://analyticsdata.googleapis.com/v1beta/properties/{GA4_PROPERTY_ID}:runReport`

**Reports to run** (all use POST with Bearer token, last 28 days):

1. **Overall metrics** — metrics: `sessions`, `totalUsers`, `newUsers`, `screenPageViews`, `bounceRate`, `averageSessionDuration`, `engagedSessions`, `engagementRate`
2. **Daily trend** — dimensions: `date`, metrics: `sessions`, `totalUsers`, `screenPageViews`
3. **Top pages** — dimensions: `pagePath`, metrics: `screenPageViews`, `sessions`, `bounceRate`, `averageSessionDuration`, orderBy: screenPageViews desc, limit: 30
4. **Traffic sources** — dimensions: `sessionDefaultChannelGroup`, metrics: `sessions`, `totalUsers`, `engagementRate`
5. **Source/medium** — dimensions: `sessionSourceMedium`, metrics: `sessions`, `totalUsers`, limit: 20
6. **Device category** — dimensions: `deviceCategory`, metrics: `sessions`, `totalUsers`, `bounceRate`
7. **Country** — dimensions: `country`, metrics: `sessions`, `totalUsers`, limit: 20
8. **Landing pages** — dimensions: `landingPage`, metrics: `sessions`, `bounceRate`, `engagementRate`, limit: 20
9. **Events** — dimensions: `eventName`, metrics: `eventCount`, limit: 20

**Example request body:**
```json
{
  "dateRanges": [{"startDate": "28daysAgo", "endDate": "yesterday"}],
  "dimensions": [{"name": "pagePath"}],
  "metrics": [{"name": "screenPageViews"}, {"name": "sessions"}],
  "limit": 30,
  "orderBys": [{"metric": {"metricName": "screenPageViews"}, "desc": true}]
}
```

**If auth or API fails**: Report "GA4 data unavailable" and return what you have. Do NOT block the audit. Common issues: service account not granted Viewer access in GA4 property, or GA4 Data API not enabled in Google Cloud.

**Return**: Total sessions, users, new users, pageviews, bounce rate, engagement rate, avg session duration. Top pages, traffic sources, source/medium, devices, countries, landing pages, events. Daily trend for 28 days. Compare with Umami/Clarity/GSC data where possible.

---

## Phase 1.5: Tracking Integrity Check (REQUIRED — run before ANY analysis)

Before drawing ANY conclusions from analytics data, validate that the tracking itself is trustworthy. Broken tracking produces confident-sounding but wrong findings.

### Step 1: Cross-Platform Traffic Sanity Check

Compare user/session counts across platforms. Write them side-by-side:

```
Cloudflare uniques/day: ___
GA4 sessions (28d):     ___  → ___/day
Umami visits (28d):     ___  → ___/day
Clarity sessions (Nd):  ___  → ___/day
```

**Expected relationships** (for a developer-audience site):
- Cloudflare >> all others (includes bots, crawlers, API traffic)
- Umami ≈ 1.5-2.5x GA4 (self-hosted Umami dodges ad blockers; GA4 is blocked by ~30-50% of developer users)
- Clarity ≈ GA4 (both are third-party scripts, similar blocking rate)

**Red flags that BLOCK analysis until explained**:
- GA4 users < 10% of Umami visitors → GA4 tag is broken. Mark ALL GA4 event data as "UNVERIFIED."
- Clarity sessions < 20% of GA4 sessions → Clarity script not loading. Mark ALL Clarity UX data as "UNVERIFIED."
- Umami and GA4 agree but both are < 1% of Cloudflare uniques AND Cloudflare threat count is low → tracking scripts only fire on some pages (partial instrumentation).

If any platform is marked UNVERIFIED, do NOT create issues based solely on that platform's data.

### Step 2: Conversion Event Ground Truth (REQUIRED)

**Stripe is the source of truth for all purchase/revenue data.** Analytics events are observations that may be lossy. When they disagree, Stripe wins. Always.

Run this comparison:

```
Stripe successful charges (28d):  ___
GA4 `purchase` events (28d):      ___
Umami `purchase` events (28d):    ___
Ratio (GA4/Stripe):               ___
Ratio (Umami/Stripe):             ___
```

**If analytics purchase events < 80% of Stripe charges**: The `purchase` event tracking is broken (common causes: script load race on redirect pages, ad blockers, consent gates). Do NOT create any "low conversion rate" or "checkout abandonment" issue. Instead, create a "fix purchase event tracking" issue.

**If `begin_checkout` events < Stripe charges**: `begin_checkout` is under-instrumented (every purchase required beginning checkout). Flag as tracking gap.

**If `begin_checkout` events > 3x Stripe charges**: `begin_checkout` is likely over-counting — firing on non-checkout actions (e.g., free CTA clicks, page loads). Investigate the event definition in code before using it in any funnel analysis.

**If Stripe data is unavailable**: Downgrade ALL conversion/funnel/revenue findings to "Observation — unverified (no Stripe ground truth)." Do NOT create issues about checkout abandonment or funnel drop-off.

### Step 3: Event Instrumentation Check

For key funnel events (`begin_checkout`, `purchase`, `sign_up`, `generate_lead`), verify they measure what you think:

1. Check the Umami/GA4 custom events list from the data collection agents.
2. If the event exists, note its count. If it doesn't exist, note "NOT INSTRUMENTED" — you cannot compute a funnel ratio for an event that doesn't exist.
3. If an event count seems implausible (e.g., `begin_checkout` > total sessions, or `purchase` = 0 when Stripe has charges), the event definition is wrong — it's a tracking issue, not a user behavior issue.

**Write down the tracking integrity verdict before proceeding:**
```
Tracking Integrity:
- GA4: ✓ Trusted / ⚠ Partially trusted / ✗ Unverified
- Umami: ✓ / ⚠ / ✗
- Clarity: ✓ / ⚠ / ✗
- Stripe: ✓ / ✗ unavailable
- Conversion events: ✓ verified against Stripe / ✗ broken (specify which)
```

---

## Phase 2: Cross-Platform Analysis

After tracking integrity is validated, synthesize findings. Write down key data points immediately — agent outputs may get compacted.

**CRITICAL RULE**: Every finding must be corroborated by at least 2 platforms, or explicitly labeled as "single-source — lower confidence." Single-source findings from an UNVERIFIED platform are not findings — they are noise.

**Historical trend context (when HISTORY_AVAILABLE=true)**: For each key metric, compare the current value not just to the previous GSC period, but to the full multi-run trend from Phase 0 history. A metric declining for 3 consecutive audits is a persistent problem, not a one-time fluctuation. A metric that spiked last audit and recovered this audit is likely noise. Use trend direction to calibrate priority: persistent trends get P0/P1, single-period anomalies get P2/P3 unless corroborated by other signals.

### Cross-Reference Dimensions

**SEO + UX overlap**: Pages with high GSC impressions but low clicks AND Clarity rage clicks = broken UX killing rankings. Highest priority.

**Quick wins (with git history check — hard gate)**: GSC queries at position 4-20 with decent impressions but low CTR = title/meta optimization. **BUT FIRST**: For every page you'd propose a title/meta rewrite, run the git history check using `SEO_RECENT_CHANGE_DAYS`:
```bash
git -C "{REPO_PATH}" log --since="${SEO_RECENT_CHANGE_DAYS} days ago" --oneline -- web/src/app/<page>/page.tsx
```
For blog posts stored in DB, check migration files:
```bash
grep -rl "<slug>" "{REPO_PATH}/infra/migrations/" 2>/dev/null
```
**If metadata changed within `SEO_RECENT_CHANGE_DAYS` days**: **Do NOT add to Proposed Actions.** Instead, add the page to the **"Recently Updated — Monitor"** section of the report (see Phase 3 template) with the note: "Updated {date} — allow 1 SEO cycle before re-evaluating. Current GSC data may reflect pre-change state." Only pages with stable metadata (unchanged for more than `SEO_RECENT_CHANGE_DAYS` days) may appear in Proposed Actions for SEO rewrites.

Quantify the opportunity (e.g., "500 impressions/month at 1.2% CTR → industry avg 5% at position 6 → ~19 extra clicks/month").

**Performance**: Clarity CWV ratings cross-referenced with GSC mobile data — poor mobile CWV hurts mobile rankings. Cloudflare cache hit ratio — **interpret in context**: API-first projects have low cache rates by design, so dynamic HTML+JSON responses should NOT be cached. Only flag cache issues if static assets (JS, CSS, images, fonts) have low cache rates. Check content type breakdown from Cloudflare data before claiming "low cache rate."

**Bing vs Google divergence**: Compare Bing Webmaster keyword rankings with GSC. Keywords ranking well on Bing but not Google (or vice versa) reveal optimization gaps. Bing rankings matter for ChatGPT search discoverability. **But**: only flag as actionable if the query has >50 impressions on the platform where ranking is weak. Below 50, position data is too noisy.

**Revenue + Traffic correlation**: Cross-reference Stripe revenue/subscriber trends with traffic data. Rising traffic but flat revenue = conversion problem — **but only if Stripe ground truth was verified in Phase 1.5**. Failed payments spiking = billing infrastructure issue.

For "signups vs customers" comparison: Only compute if Umami custom events include a `signup`, `register`, `sign_up`, or `auth-signup-complete` event. Check the events list first. If no such event exists, this comparison is meaningless — note "signup event not instrumented" and skip.

**Churn signals**: Stripe canceled subscriptions cross-referenced with Clarity rage clicks on dashboard/billing pages = UX-driven churn. Failed payments with no retry success = involuntary churn needing dunning improvements.

**Error signals**: Cloudflare 4xx/5xx spikes, Clarity JS errors, pages in Umami but missing from GSC (indexing gaps), Bing crawl errors. **For Cloudflare status codes**: Check if 4xx responses are intentional bot-blocking (WAF/firewall rules) before flagging as errors. For Bing crawl errors, check robots.txt and bot-handling middleware — 403s on auth-gated paths are correct behavior, not bugs.

**Content**: Which blog posts drive traffic across all platforms? Which have UX issues? Which convert (Clarity smart events)?

### Over-Counting & Under-Counting Awareness

Before treating any event count as meaningful:

**Over-counting red flags**:
- Event counts implausibly high vs session count (e.g., 50 `begin_checkout` with 30 sessions = double-fire or wrong trigger)
- Same event name used for multiple actions (common: `begin_checkout` fires on both real purchases AND free-tier CTA clicks)
- Rage/dead click counts > session count → bot interactions inflating behavioral data
- Cloudflare threat count > 50% of total requests → subtract bot traffic from ALL per-request metrics

**Under-counting awareness** (developer audience):
- Developer-focused projects see ad blockers at 3-5x the general population rate.
- GA4 event counts likely undercount true user actions by 20-50%.
- Never create a "low conversion rate" issue if Stripe successful charges roughly match or exceed analytics purchase events — the funnel is healthy, tracking is lossy.
- Self-hosted Umami is more reliable than GA4 for this audience — prefer Umami event counts when they diverge.

### Prioritize Findings

| Factor | Weight |
|--------|--------|
| Traffic impact (users affected) | 40% |
| Revenue impact (conversion pages) | 25% |
| Effort to fix (S/M/L) | 20% |
| Quick win potential (results in 1-2 weeks) | 15% |

Classify:
- **P0**: Broken functionality, major UX issues on high-traffic pages, significant ranking drops
- **P1**: Quick wins with measurable impact, CWV failures, JS errors on key pages
- **P2**: Content optimization, cache improvements, minor UX fixes
- **P3**: Nice-to-haves, long-tail stuff

---

## Issue Quality Gate (REQUIRED — run before building Proposed Actions table)

Every candidate finding must pass this gate. If any check fails, downgrade to "Observation — monitor" or drop entirely. Do NOT add to Proposed Actions.

### For ALL findings:
- [ ] **Multi-source corroboration**: Is this finding supported by at least 2 platforms? Single-source findings must include explicit uncertainty note and cannot be higher than P2.
- [ ] **Sample size**: State N. If N < 10 affected sessions (UX) or N < 100 impressions (SEO), cap priority at P3 and add "(low sample — monitor first)".
- [ ] **Not a tracking artifact**: Could this finding be explained by broken tracking rather than a real user problem? If yes, create a tracking-fix issue instead.

### For conversion/funnel findings:
- [ ] **Stripe cross-validated**: Have you compared analytics events to Stripe charges? If Stripe says conversions are healthy, this is a tracking issue, not a funnel issue.
- [ ] **Event logic verified**: Does `begin_checkout` actually mean "started paying"? Does `purchase` fire reliably? If unsure, note "event definition unverified."

### For SEO/content findings:
- [ ] **Git history checked (hard gate)**: Run `git log --since="${SEO_RECENT_CHANGE_DAYS} days ago"` on the page file (and migration files for DB-driven blog posts). If the page's title/meta changed within `SEO_RECENT_CHANGE_DAYS` days → **do NOT add to Proposed Actions**. Move it to the "Recently Updated — Monitor" section with the note: "Updated {date} — allow 1 SEO cycle before re-evaluating." This check covers both file-based pages (`web/src/app/<page>/page.tsx`) and DB-driven blog posts (grep migration files for slug). This gate cannot be skipped.
- [ ] **Impression threshold**: >100 impressions for the query/page? Below 100, position/CTR data is noisy — one ranking fluctuation changes the average. Cap at P3.

### For UX findings (dead clicks, rage clicks, bounce):
- [ ] **Element identified**: Do you know WHICH specific element is being rage/dead-clicked? Page-level counts without element drill-down are not actionable — you can't fix what you can't identify.
- [ ] **Post-redesign data**: Has the page been redesigned recently? If so, is the data from before or after the redesign? Stale UX data about a page that's already changed is not an issue.

### For infra/performance findings:
- [ ] **Context-appropriate**: Is the metric bad in context? Low cache hit on an API-first platform is expected. High 403 rate with active bot blocking is working-as-designed. Interpret metrics in the context of what the system is designed to do.

### Duplicate detection (history-aware, REQUIRED when HISTORY_AVAILABLE=true):
- [ ] **Not already tracked**: Before adding a finding to Proposed Actions, check if an open issue in history's `issues_created` list already covers the same finding:
  ```bash
  # For each issue number from history's issues_created:
  gh issue view {PAST_ISSUE_NUMBER} -R {GH_REPO} --json state,title --jq '{state, title}'
  # If state=OPEN and the title/category matches the current finding → skip creation, note "Already tracked in #{PAST_ISSUE_NUMBER}"
  ```
  If the past issue is closed (fixed), the finding may recur — create a new issue and note the recurrence.

---

## Phase 2.5: Action Validation (REQUIRED when HISTORY_AVAILABLE=true)

**Skip this entire phase if `HISTORY_AVAILABLE=false`.** When history exists, validate whether past issues moved the needle before the current report is written.

For each issue in the last audit's `issues_created` list, fetch its current metric value and compare to the value recorded at creation time:

```bash
# For each past issue from history:
PAST_ISSUE_NUMBER="{number from history.issues_created}"
METRIC="{metric field from history, e.g. cf_5xx_7d}"
THEN_VALUE="{value recorded in history snapshot}"
NOW_VALUE="{current value from this audit's data collection}"

# Compute verdict:
# If NOW < THEN * 0.8 → "✓ improved"
# If NOW > THEN * 1.2 → "⚠ worsened"
# Otherwise → "→ unchanged"
```

Emit an impact table:

```markdown
### Impact of Previous Actions (from {LAST_AUDIT_DATE} audit)
| Issue | Metric | Then | Now | Verdict |
|-------|--------|------|-----|---------|
| #{NUM} {title} | {metric} | {then} | {now} | ✓ improved / → unchanged / ⚠ worsened |
```

**If metric mapping is ambiguous** (e.g. issue title doesn't clearly map to a single metric): use the `category` field from history to guess the most relevant metric (infra → cf_5xx_7d, seo → gsc_clicks, product → first_scrape). If no mapping is possible, mark verdict as "— unmeasured" and do not skip the row.

**If a past issue is still open and shows ⚠ worsened**: Escalate its priority in the current Proposed Actions table if it appears again as a current finding.

---

## Phase 3: Present Report

Show the user a structured report BEFORE creating issues. This is the checkpoint.

```markdown
## Analytics Audit — {DATE}

**Period**: Last 28 days (GSC/Umami) | Last 7 days (Clarity/CF)
**Sources**: GSC ✓/✗ | GA4 ✓/✗ | Bing ✓/✗ | Clarity ✓/✗ | Umami ✓/✗ | Cloudflare ✓/✗ | Stripe ✓/✗

### Tracking Integrity
| Platform | Status | Notes |
|----------|--------|-------|
| GA4 | ✓/⚠/✗ | {reason if not trusted} |
| Umami | ✓/⚠/✗ | |
| Clarity | ✓/⚠/✗ | |
| Stripe | ✓/✗ | |
| Conversion events | ✓/✗ | {Stripe charges vs analytics purchase events — ratio} |

{If any conversion event tracking is broken, state it prominently here. E.g.: "purchase event fires 6% of the time (2 events vs 33 Stripe charges) — all funnel metrics from analytics are unreliable. Stripe is ground truth."}

<!-- When HISTORY_AVAILABLE=true, insert the two sections below. When HISTORY_AVAILABLE=false, omit both sections entirely (no empty tables). -->

### Impact of Previous Actions _(omit when HISTORY_AVAILABLE=false)_
{Paste the impact table from Phase 2.5 here. If all past issues are closed with no recurrence, write: "All tracked issues from last audit closed — no active follow-ups."}

### Multi-Audit Trends _(omit when HISTORY_AVAILABLE=false)_
| Metric | {DATE-3} | {DATE-2} | {DATE-1} | {TODAY} | Trend |
|--------|----------|----------|----------|---------|-------|
| GSC Clicks | | | | | ↑/↓/→ |
| GSC CTR | | | | | |
| Umami Visitors | | | | | |
| Stripe MRR | | | | | |
| CF 5xx (7d) | | | | | |
| Signups | | | | | |

Fill in historical values from the Phase 0 history snapshots. Leave cells blank (—) for dates where a metric was not recorded. Use at most the 3 prior audit dates before today.

### Executive Summary
{3-5 sentences. Lead with the biggest opportunity or problem. If tracking is broken, lead with that — bad data is the #1 risk.}

### Key Metrics
| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Clicks (GSC) | | | |
| Impressions (GSC) | | | |
| Avg Position | | | |
| CTR | | | |
| Sessions (Clarity) | | | |
| Bounce Rate | | | |
| Page Views (Umami) | | | |
| Sessions (GA4) | | | |
| Engagement Rate (GA4) | | | |
| Cache Hit % (CF) | | | |
| MRR (Stripe) | | | |
| Active Subs (Stripe) | | | |
| Failed Payments (Stripe) | | | |

### Revenue & Billing (Stripe)
{MRR, active subscribers, new customers, churn count, failed payments with top failure reasons, refunds/disputes. Flag involuntary churn risks (repeated failures). Revenue trend vs traffic trend.}

### SEO: Quick Wins
{Top queries with position 4-20, high impressions, low CTR — with recommended actions. Only pages with stable metadata (unchanged for >`SEO_RECENT_CHANGE_DAYS` days) appear here.}

### SEO: Recently Updated — Monitor
{Pages skipped from Proposed Actions because their metadata changed within `SEO_RECENT_CHANGE_DAYS` days. Do NOT propose rewrites for these — current GSC data may reflect the pre-change state. Format each entry as:}
- **{page path}**: Updated {date} — allow 1 SEO cycle before re-evaluating. Current GSC data may reflect pre-change state.
{If no pages were recently updated: omit this section entirely.}

### Bing / ChatGPT Discoverability
{Bing crawl health, top Bing queries, Bing vs Google ranking divergence, ChatGPT discoverability signals}

### SEO: Declining & Rising Keywords
{Notable movers across both Google and Bing}

### UX: Problem Areas
{Rage clicks, dead clicks, quick backs — with session recording links}

### Performance
{CWV ratings, cache efficiency, error rates}

### Traffic Sources
{Channels, referrers, geography}

### Proposed Actions ({N} total)
| # | Priority | Category | Action | Impact | Effort |
|---|----------|----------|--------|--------|--------|
| 1 | P0 | ... | ... | ... | S/M/L |

**Create these as GitHub issues?** (yes / adjust / pick specific ones)
```

**Insight quality rules:**
- Don't just list data — interpret it. "Position 7.2" is data. "Below the fold for your primary keyword, fixing title could yield +40% CTR" is an insight.
- Cross-reference is the superpower. Declining GSC clicks + Clarity rage clicks + high Umami bounce = a story no single platform tells.
- Quantify every opportunity with numbers.
- Be honest about uncertainty. Small sample sizes or ambiguous data — say so.

**Hard thresholds for Proposed Actions (these are stops, not suggestions):**
- **UX issues** (rage clicks, dead clicks, quick backs): minimum 10 affected sessions AND specific element identified. Page-level counts without element drill-down go to "Observations" not "Proposed Actions."
- **SEO issues** (CTR, position): minimum 100 impressions for the query/page. Below 100: "Observation — insufficient data."
- **Traffic source issues**: minimum 50 sessions from that source. Below 50: "Observation — monitor."
- **Revenue/conversion issues**: ALWAYS require Stripe cross-validation. Analytics events alone are NEVER sufficient to create a conversion issue. If Stripe data contradicts analytics, Stripe wins.
- **Infra/cache issues**: must include context (is the low cache rate expected for this traffic type?). API-first platforms have low cache rates by design.

---

## Phase 4: Create GitHub Issues

**Only after user confirms.** If "adjust" — modify list. If they pick specific ones — only create those.

For each approved action:

```bash
gh issue create \
  --title "{type}: {action title}" \
  --label "{priority},{category_label}" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what the analytics data shows is wrong or suboptimal, with specific numbers.}

## Root Cause (if known)

{What's causing the metric gap — missing metadata, wrong implementation, infrastructure issue, etc. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Measurable improvement criterion — include target metric value}
- [ ] Verified in next analytics audit

## Context

Identified in analytics audit on {DATE}.
**Data Sources**: {which platforms}
**Period**: {date range}

## Evidence

{Specific data points from each platform that justify this issue}

**Current state**: {the problem, with numbers}
**Desired state**: {target metrics}

## Recommended Approach

{Technical steps}
BODY_EOF
)"
```

**Label mapping**: SEO → `seo`, UX → `ux,frontend`, Performance → `performance,infra`, Bug → `bug`. Priority: `P0`-`P3`.

If an open milestone fits, offer to assign issues to it.

### Add analytics issues to Project board

For each created issue, add it to the GitHub Project. Field IDs are resolved from `forge.yaml → project_board.field_ids` (see the ForgeDock docs for the full project board configuration schema).

```bash
ISSUE_URL="https://github.com/{GH_REPO}/issues/${ISSUE_NUM}"
ITEM_ID=$(gh project item-add {PROJECT_NUMBER} --owner {PROJECT_BOARD_OWNER} --url "$ISSUE_URL" --format json --jq '.id' 2>/dev/null)
if [ -n "$ITEM_ID" ]; then
  gh project item-edit --project-id {PROJECT_ID} --id "$ITEM_ID" --field-id {project_board.field_ids.status} --single-select-option-id {project_board.option_ids.status.todo} 2>/dev/null || true  # Status=Todo
  gh project item-edit --project-id {PROJECT_ID} --id "$ITEM_ID" --field-id {project_board.field_ids.lane} --single-select-option-id {project_board.option_ids.lane.fast} 2>/dev/null || true  # Lane=Fast
  gh project item-edit --project-id {PROJECT_ID} --id "$ITEM_ID" --field-id {project_board.field_ids.component} --single-select-option-id {project_board.option_ids.component} 2>/dev/null || true  # Component
  gh project item-edit --project-id {PROJECT_ID} --id "$ITEM_ID" --field-id {project_board.field_ids.priority} --single-select-option-id {PRIORITY_OPTION_ID} 2>/dev/null || true  # Priority (from issue)
fi
```

---

## Phase 5: Summary & History Append

### Step 5A: Display Summary

```markdown
## Audit Complete

### Issues Created
| # | Issue | Priority | Category | Impact |
|---|-------|----------|----------|--------|

### Top 3 Takeaways
1. ...
2. ...
3. ...

### Next Steps
- `/work-on #{first}` for highest priority
- `/orchestrate #{N1} #{N2} #{N3}` to batch P1s
- Re-run `/analytics` in 1-2 weeks to measure impact
```

### Step 5B: Append Audit Snapshot to History

After displaying the summary, write the current audit snapshot to the history file. This enables Phase 0 of future audits to load it.

```bash
HISTORY_FILE="{HISTORY_FILE}"

python3 -c "
import yaml, os, sys, json
from datetime import date

# Build snapshot from current audit data
snapshot = {
    'date': str(date.today()),
    'period': '28d',
    'metrics': {
        'gsc_clicks':          {GSC_CLICKS},
        'gsc_impressions':     {GSC_IMPRESSIONS},
        'gsc_ctr':             {GSC_CTR},
        'gsc_position':        {GSC_POSITION},
        'umami_visitors':      {UMAMI_VISITORS},
        'umami_sessions':      {UMAMI_SESSIONS},
        'umami_bounce':        {UMAMI_BOUNCE},
        'umami_avg_duration':  {UMAMI_AVG_DURATION},
        'stripe_revenue':      {STRIPE_REVENUE},
        'stripe_charges':      {STRIPE_CHARGES},
        'stripe_customers_new': {STRIPE_CUSTOMERS_NEW},
        'stripe_customers_paid': {STRIPE_CUSTOMERS_PAID},
        'cf_requests_7d':      {CF_REQUESTS_7D},
        'cf_5xx_7d':           {CF_5XX_7D},
        'cf_cache_hit':        {CF_CACHE_HIT},
        'bing_indexed':        {BING_INDEXED},
        'signups':             {SIGNUPS},
        'onboarding_complete': {ONBOARDING_COMPLETE},
        'first_scrape':        {FIRST_SCRAPE},
        'begin_checkout':      {BEGIN_CHECKOUT},
        'purchase_events':     {PURCHASE_EVENTS},
        'ai_referrals':        {AI_REFERRALS},
    },
    'issues_created': {ISSUES_CREATED_LIST},
    'tracking_integrity': {
        'ga4':     '{GA4_STATUS}',
        'umami':   '{UMAMI_STATUS}',
        'clarity': '{CLARITY_STATUS}',
        'stripe':  '{STRIPE_STATUS}',
    },
    'key_findings': {KEY_FINDINGS_LIST},
}

# Read existing history (or start fresh)
history = []
if os.path.exists(sys.argv[1]):
    try:
        history = yaml.safe_load(open(sys.argv[1])) or []
    except Exception:
        history = []  # corrupt file — start fresh, do not fail

# Append and cap at 12 entries
history.append(snapshot)
history = history[-12:]

# Write back
with open(sys.argv[1], 'w') as f:
    yaml.dump(history, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

print(f'History updated: {len(history)} entries in {sys.argv[1]}')
" "$HISTORY_FILE"
```

**Placeholder substitution**: Replace `{GSC_CLICKS}`, `{UMAMI_VISITORS}`, etc. with the actual numeric values from the data collection agents. For any platform that was unavailable this run, use `null` (Python None). For `{ISSUES_CREATED_LIST}`, use a list of dicts matching the schema: `[{'number': 123, 'title': '...', 'priority': 'P1', 'category': 'infra'}]`. For `{KEY_FINDINGS_LIST}`, use a list of the top 3-5 finding strings from the Executive Summary. For `{GA4_STATUS}` etc., use one of: `trusted`, `partially_trusted`, `unverified`, `unavailable`.

**If the write fails** (permissions, disk full, etc.): Log the error and continue. A failed history write is non-fatal — the audit results are already shown to the user and issues created. Do NOT re-run or retry the entire audit.

---

## Error Handling

- **General rule**: Skip failed platforms, note in report, continue. Partial audit > no audit.
- **Stripe unavailable**: Downgrade ALL conversion/funnel/revenue findings to "Observation — unverified (Stripe unavailable)." Do NOT create issues about checkout abandonment, low purchase rate, or funnel drop-off without Stripe ground truth.
- **GA4 unavailable**: Conversion event data is unverifiable unless Umami has the same events. Note that all event-based findings come from Umami only.
- **GSC unavailable**: SEO quick wins cannot be computed. Skip all SEO Proposed Actions.
- **Umami auth fails**: Read creds from `credentials.yaml`. If still broken, skip and note.
- **No data / insufficient data**: Note "insufficient data" — don't manufacture insights from noise. Never create an issue from a single data point.
- **Rate limits**: Note which queries were incomplete and whether the remaining sample is large enough to be meaningful.
