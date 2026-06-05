---
description: Weekly failure recon — pull prod failures, test at each tier, create tier-hardening issues
argument-hint: [full | pull | test | report | issues-only]
---

# /failure-recon — Weekly Scraper Tier Hardening Pipeline

**Input**: $ARGUMENTS (default: `full`)

You are AlterLab's scraper intelligence system. Your mission: **improve the platform's scraping capabilities holistically** — tiers, detection, content extraction, and the intelligence feedback loop that ties it all together.

**The scraping ecosystem is a closed loop:**
```
BlackBox Recorder → TrafficAnalyzer → Learnings → LearningApplier → playbook:active:{domain}
                                                                            ↓
Tier Feedback (cortex:domain:stats) → get_optimal_starting_tier() → Smarter tier selection
                                                                            ↓
Challenge Detection → notify_scrape_complete() → Cortex Queue → Agents (CodeFix, AntiBot, etc.)
                                                                            ↓
scrape_diagnostics / domain_analytics → This command (failure-recon) → Issues → /work-on → Improvement
```
Every fix to ANY part of this loop compounds — better detection feeds better tier intelligence, which reduces wasted escalations, which captures better traffic data in BlackBox, which generates better learnings.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`. Pass the resolved model in every `Agent`/`Task` call. Each agent prompt specifies the exact tier to test, the Docker endpoint to hit, and the expected output format.

**Core principles:**
1. **Solve at the lowest tier.** Every URL should work at the cheapest, fastest tier possible.
2. **Platform improvements, not domain fixes.** Cortex + BlackBox Recorder handle per-domain learning automatically. This command improves the PLATFORM — the tiers, detection providers, content extraction, feedback loop, and intelligence pipeline.
3. **No domain-specific fixes.** NEVER create issues like "fix scraping for zillow.com" or "add playbook for X." Instead: "Tier 3 stealth headers don't spoof sec-fetch-* correctly" (evidenced by failures across 6 domains). Production URLs are EVIDENCE, not the target.
4. **Leverage the full ecosystem.** Issues should consider:
   - Could BlackBox Recorder capture more useful data to feed this improvement?
   - Could TrafficAnalyzer learn this pattern automatically with better signals?
   - Could the tier feedback loop (`cortex:domain:stats`) make smarter decisions here?
   - Could the LearningApplier auto-apply this fix with the right confidence threshold?
   - Could the challenge detection providers (`shared/detection/providers/`) detect this pattern?
   - Could `detected_antibot` in `scrape_diagnostics` inform future tier selection?
5. **No regressions.** Every fix must preserve what already works. Check previous fixes.
6. **GitHub is the memory.** Every issue links to prior work. Any agent picking this up later has full context.
7. **No defeatism.** "Unsolvable" means "needs a new technique," not "can't be done."

**Good issues from this command:**
- "Tier 2 TLS fingerprint provides 0% incremental bypass — rethink what capability T2 adds" (tier capability)
- "Browser tier crashes instead of extracting partial content — graceful degradation needed" (resilience)
- "CSR shell detection doesn't trigger hydration-aware waiting at T4" (content extraction)
- "detected_antibot never populated — breaking the diagnostics→intelligence feedback loop" (ecosystem plumbing)
- "Tier feedback loop doesn't account for challenge type — sites with Cloudflare should skip T1-T3" (intelligence)
- "BlackBox Recorder only captures T4 traffic — T2/T3 failures have no data for TrafficAnalyzer" (data collection gap)

**NOT acceptable:**
- "Fix scraping for zillow.com" (domain-specific — Cortex handles this)
- "Add playbook for easydrop.one" (domain-specific — CodeFixAgent handles this)
- "alternativeto.net needs X" (domain-specific — tier feedback loop handles this)

---

## Phase 1: Pull & Normalize Production Failures

First, verify local containers are up:
```bash
cd /home/mrdubey/projects/ScraperAPI/alterlab
docker compose ps --format "{{.Name}} {{.Status}}" | grep -E "api|worker|redis|postgres"
```

If containers aren't running, tell the user and offer to start them.

Then run the recon script:
```bash
cd /home/mrdubey/projects/ScraperAPI

# Full pipeline: pull → normalize → tier-by-tier test → report
python3 tools/failure-recon/recon.py full --days 7 --sample-size 10 --max-total 200 --concurrency 3

# Or specific phases:
# python3 tools/failure-recon/recon.py pull --days 7       # Pull only (no testing)
# python3 tools/failure-recon/recon.py test                 # Re-test existing sample
# python3 tools/failure-recon/recon.py report               # Re-read latest report
```

If `$ARGUMENTS` is `issues-only`, skip directly to Phase 3 (read existing report, create issues).

**This takes 30-90 minutes** depending on sample size. The script tests each URL at Tier 1, then 2, then 3, then 4 — stopping at the first tier that returns useful content. This is how we find where each tier's boundary is.

---

## Phase 2: Analyze the Report

Read the latest report:
```bash
ls -t /home/mrdubey/projects/ScraperAPI/tools/failure-recon/reports/recon_*.json | head -1
```

Read the JSON. Key sections:

### 2A: Tier Pass Rates (`tier_pass_rates`)

This is the **scoreboard**. For each tier, what percentage of failed-in-prod URLs can it handle?

```
Tier 1 (curl)    : ██░░░░░░░░░░░░░░░░░░  12/200 (6%)
Tier 2 (http)    : █████░░░░░░░░░░░░░░░  45/200 (22.5%)
Tier 3 (stealth) : ████████████░░░░░░░░  110/200 (55%)
Tier 4 (browser) : ████████████████░░░░  160/200 (80%)
```

The GAP between tiers is the hardening opportunity. If Tier 3 solves 55% but Tier 4 solves 80%, there are 50 URLs where Tier 3 ALMOST works — those are Tier 3 hardening candidates.

### 2B: Tier Hardening Findings (`tier_findings`)

Each finding says: "N URLs fail at Tier X but pass at Tier Y — here's what Tier X needs."

**Analyze the root cause for each finding:**

1. **What's the detection vector?** Read the errors and protection type.
   - `blocked_403` + Cloudflare → TLS fingerprint or header mismatch at this tier
   - `timeout` + DataDome → Solver not triggering or too slow
   - `empty_response` → Content extraction failing, not necessarily blocked
   - `soft_block` → Page loads but returns challenge HTML instead of content

2. **What does the passing tier do differently?** Compare tier capabilities:
   - Tier 1→2: Chrome TLS fingerprint. If URLs pass at T2 but not T1, the site checks TLS.
   - Tier 2→3: Proxy + stealth headers. If URLs pass at T3 but not T2, the site checks IP reputation or specific headers.
   - Tier 3→4: Full browser JS. If URLs pass at T4 but not T3, the site requires JS execution — but CAN we do lighter JS at T3?

3. **What specific code change would make the lower tier work?**
   - Better headers at Tier 1/2 (`services/worker/worker/consumers/unified_consumer.py`)
   - Better fingerprinting at Tier 2 (`services/worker/worker/anti_detection/`)
   - Better proxy selection at Tier 3 (proxy pool, country selection)
   - Better challenge detection at Tier 4 (`services/worker/worker/browser/challenge_detector.py`, solvers)

### 2C: Unsolvable URLs

URLs failing at ALL tiers need new techniques. Analyze:
- Is the protection system one we have a solver for? (Check `shared/detection/providers/`)
- Is the solver being triggered? (Check `challenge_detector.py` patterns)
- Is it a new protection variant we haven't seen?

---

## Phase 3: Research Prior Work (CRITICAL)

**Before creating ANY issue**, search GitHub for prior work in the same area. This is the context layer.

```bash
# Search for existing open scraper issues
gh issue list --state open --label "scraper" --limit 50 --json number,title

# Search for closed issues about the same protection type
gh issue list --state closed --label "scraper" --search "{protection_type}" --limit 20 --json number,title,closedAt

# Search for related PRs
gh pr list --state merged --search "tier hardening {protection}" --limit 10 --json number,title,mergedAt

# Check recent scraper-related commits
cd /home/mrdubey/projects/ScraperAPI/alterlab
git log --oneline --all --grep="tier" --grep="hardening" --since="3 months ago" | head -20
git log --oneline --all --grep="{protection_type}" --since="3 months ago" | head -20
```

**For each finding, gather:**
1. Related closed issues (what was tried before?)
2. Related merged PRs (what code was changed?)
3. Any open issues that overlap (don't duplicate!)

If an open issue already covers this finding, **comment on it** with the new test data instead of creating a duplicate.

---

## Phase 4: Create Platform Improvement Issues

**CRITICAL: Issues must describe PLATFORM-LEVEL capabilities to improve, not domain-specific fixes.**

Use production data as EVIDENCE (e.g., "observed on 6 domains including zillow.com and coles.com.au"), but the fix must be a general improvement (e.g., "add pre-timeout content extraction fallback to browser tier").

Issue categories to create:

### A. Tier Capability Gaps
When a tier has low incremental pass rate over the tier below it. The issue should propose specific anti-detection or protocol improvements to that tier.

Title pattern: `"Tier {N} ({name}): {capability problem} — {%} incremental pass rate"`

### B. Resilience / Graceful Degradation
When a tier fails catastrophically (crash, timeout with zero output) instead of returning partial results. The issue should propose fallback behaviors.

Title pattern: `"Tier {N}: {failure mode} should {graceful behavior} instead"`

### C. Content Extraction Pipeline
When content exists but isn't extracted properly (CSR shells, shadow DOM, iframes, lazy-loaded content). These are cross-tier issues.

Title pattern: `"{extraction problem} — affects {N} URLs across {M} domains"`

### D. Detection / Intelligence Pipeline
When the platform lacks data to make good decisions (e.g., `detected_antibot` not populated, tier intelligence over-escalating). These improve the feedback loop.

Title pattern: `"{data/intelligence problem} — blocking {downstream capability}"`

### Issue Body Structure

Every issue MUST include:
1. **Platform capability being improved** — what general capability is this? (fingerprinting, content extraction, wait strategy, etc.)
2. **Evidence from production** — URLs/domains as evidence, NOT as the fix target
3. **Prior work** — linked issues and PRs
4. **Investigation path** — code paths to examine, not "fix domain X"
5. **Validation plan** — how to verify the improvement works across the board, not just for one site
6. **Regression guard** — URLs that currently pass and must continue to

**NEVER frame an issue as "fix scraping for X.com" — always as "improve {capability} (evidenced by failures on X.com, Y.com, Z.com)"**
- **Prod impact**: {total_failures} failures/week from this protection type
EOF
)"
```

### Issue Template: Unsolvable URLs (New Technique Needed)

```bash
gh issue create --title "feat(scraper): add {Protection} bypass technique — {count} URLs unsolvable at all tiers" --label "feature,P1,scraper" --body "$(cat <<'EOF'
## Problem

{count} URLs fail at ALL tiers (1-4) against {Protection} protection. The platform has no working bypass for this protection type or variant.

## Root Cause (if known)

{Analysis}: Our current solver either doesn't exist for this protection type, exists but doesn't trigger for this pattern, or triggers but can't complete the challenge.
- `shared/detection/providers/{protection}.py`: {does it detect correctly?}
- `challenge_detector.py`: {what happens when detected?}

## Affected Files

Files that need changes:
1. `services/worker/worker/browser/challenge_detector.py` — {what detection changes are needed}
2. `shared/detection/providers/{protection}.py` — {solver/detection updates}
3. `{other files}` — {what needs to change}

## Acceptance Criteria

- [ ] {Protection} protection detected correctly by challenge_detector.py
- [ ] Solver triggers and completes challenge for the failing URL pattern
- [ ] Regression guard: {N} currently-passing URLs continue to pass
- [ ] Verified in next failure-recon run

## Context

### Failing URLs
{table: URL | Domain | T4 Error | T4 Status Code}

### Error Pattern
{Common errors at Tier 4 — the highest tier we tried}

### Prior Work
{Related issues and PRs}

### Investigation Path
1. [ ] Run one URL manually in Playwright to observe the challenge
2. [ ] Check if detection provider identifies the protection correctly
3. [ ] Check if solver is triggered (add logging if needed)
4. [ ] Identify what the challenge requires (fingerprint, behavioral, CAPTCHA, etc.)
5. [ ] Prototype solver or enhance existing one
6. [ ] Test with URLs from this issue
EOF
)"
```

### Issue Template: Tier Intelligence (Over-Escalation)

```bash
gh issue create --title "refactor(scraper): tier intelligence over-escalation — {count} URLs use Tier {high} but solvable at Tier {low}" --label "refactor,P2,scraper" --body "$(cat <<'EOF'
## Problem

{count} URLs used Tier {high} in production but are solvable at Tier {low} locally. The tier escalation logic or Cortex tier prediction is overshooting by 2+ tiers, wasting browser resources unnecessarily.

## Root Cause (if known)

{Analysis — is Cortex over-recommending? Is the escalation too aggressive? Are there stale tier recommendations in Redis?}

## Affected Files

Files that need changes:
1. `{cortex/tier-selection file}` — {what needs to change in escalation logic}
2. `{Redis tier cache file}` — {stale recommendation handling if applicable}

## Acceptance Criteria

- [ ] Tier escalation for {protection type} reduced by {N} tiers on average
- [ ] No regression: URLs that genuinely need higher tiers still escalate correctly
- [ ] Verified in next failure-recon run

## Context

### Examples
| URL | Prod Tier | Actual Min Tier | Tiers Saved |
|-----|-----------|-----------------|-------------|
{table rows}

### Prior Work
{Related issues}
EOF
)"
```

---

## Phase 5: Link Everything Together

After creating issues, ensure the context web is connected:

1. **Cross-reference new issues** — if Issue A (Tier 2 Cloudflare) and Issue B (Tier 3 Cloudflare) are related, comment on each linking to the other.

2. **Reference the recon report** — include the report timestamp in each issue so agents know which data to look at:
   ```
   > Data from failure-recon run {timestamp}. Report: `tools/failure-recon/reports/recon_{timestamp}.json`
   ```

3. **Label consistently**: All issues get `scraper` label. Tier hardening gets `bug`. New techniques get `feature`.

---

## Phase 6: Summary

Print the final summary:

```
## Failure Recon — Tier Hardening Report ({date})

### Production Snapshot (Last 7 Days)
- Total failures: {N} | Unique URLs: {N} | Domains: {N}

### Tier Scoreboard
| Tier | Name | Passing | Rate | Hardening Opportunity |
|------|------|---------|------|----------------------|
| 1 | curl | {n}/{total} | {%} | {gap to next tier} URLs |
| 2 | http | {n}/{total} | {%} | {gap} URLs |
| 3 | stealth | {n}/{total} | {%} | {gap} URLs |
| 4 | browser | {n}/{total} | {%} | — |
| ALL | combined | {n}/{total} | {%} | {unsolvable} unsolvable |

### Issues Created
| # | Title | Priority | Tier | Protection | Hardening Target |
|---|-------|----------|------|------------|-----------------|
{table}

### Issues Updated (prior work found)
| # | Title | New Data Added |
|---|-------|---------------|
{table of existing issues that got new comments}

### Regression Watch
{N} URLs currently passing — these MUST be preserved. Any /work-on agent picking up
a tier-hardening issue should verify these still pass before merging.
```

---

## Modes Reference

| Argument | What It Does | Duration | When |
|----------|-------------|----------|------|
| `full` (default) | Pull → Test all tiers → Report → Issues | 30-90 min | Weekly ritual |
| `pull` | Pull + normalize only | 2 min | Quick status check |
| `test` | Re-test existing sample | 20-60 min | After deploying fixes |
| `report` | Re-read latest report | Instant | Review without re-pulling |
| `issues-only` | Read report → Create issues | 5 min | Create issues from reviewed report |

---

## Philosophy

AlterLab doesn't accept failure. Every bot protection is a puzzle — Cloudflare, DataDome, Akamai, Kasada, all of them. The question isn't "can we bypass this?" — it's "which tier should bypass this?"

**Tier 1 should handle everything that doesn't check fingerprints.**
**Tier 2 should handle everything that checks TLS but not IP.**
**Tier 3 should handle everything that checks IP but not JS.**
**Tier 4 should handle everything.**

When a URL fails at Tier 4, that's not a limitation — that's a solver bug or a new pattern to learn.

This command runs weekly. Each run should produce measurable tier improvements. Compare this week's scoreboard to last week's — the numbers should go UP, never down.
