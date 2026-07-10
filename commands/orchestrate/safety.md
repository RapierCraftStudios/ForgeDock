---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Safety Rules & Examples

## Safety Rules

1. **Every agent MUST invoke `/work-on` via the Skill tool.** No custom prompts. No manual implementation. Copy the Phase 4A template, fill in variables, done. (See HARD RULES at top of file.)
2. **NEVER merge anything to `main`** — agents merge to `staging` or `milestone/{slug}` only
3. **Concurrency is capped by default (12 in-flight agents)** <!-- Updated: forge#1912 --> — file overlap and dependencies still determine which issues are *eligible* to run in parallel, but Phase 4 never dispatches more than `MAX_CONCURRENT` at once (default 12); the rest queue and dispatch as running agents complete. Set `forge.yaml → orchestration.max_concurrent` to raise or lower the cap (see Engine mode § Concurrency model, and `phase-4-execution.md` Step 4A-pre.0.2).
4. **Always confirm with user before launching** — Step 3E is the mandatory checkpoint
5. **No retries** — if an agent fails, report it and move on
6. **Respect existing work** — skip issues already being worked on (`workflow:building`, `workflow:in-review`)
7. **Dependency failures cascade** — if A fails and B depends on A, all transitive dependents of A are skipped (not attempted)
8. **Always run post-batch cleanup** — Phase 5 is mandatory. Never skip `/cleanup all` after orchestration.
9. **NEVER close/skip issues as duplicates** — only `/work-on` investigation agents can make that call after examining the actual code. The orchestrator delegates, it does not adjudicate. **This is distinct from Phase 2.5 plan reconciliation**: reconciling *competing recommendations* across investigation annotations (arbitrating incompatible plans, adding `Depends on #X` serialization edges) operates only on FORGE annotations and issue bodies — it never reads code and never closes/skips/merges an issue. Both issues in a reconciled conflict still run. Adjudicating *duplicate validity* (deciding two issues are the same bug and closing one) remains forbidden. <!-- Added: forge#1192 -->
10. **Per-completion verification** — after each agent completes, check that it has `workflow:*` labels and structured comments. If an agent bypassed `/work-on`, report it as a pipeline failure.

---

## Examples

### "orchestrate milestone api-expansion"
→ Fetches all open issues in "API Expansion v1" milestone
→ Builds DAG: #1526 → #1527 → #1528 → #1529 (chain), #1530 (no predecessors)
→ Confirms with user, dispatches #1526 + #1530 immediately
→ When #1526 completes, dispatches #1527 immediately (doesn't wait for #1530)
→ Streaming continues until all issues reach terminal state

### "orchestrate #1533 #1250"
→ Fetches those 2 issues, no deps between them
→ DAG: both have empty predecessor sets
→ Confirms, dispatches both simultaneously

### "orchestrate next 5"
→ Gets top 5 priority issues, builds DAG
→ Confirms, dispatches all ready issues immediately
→ Dependent issues dispatch as predecessors complete

### "orchestrate P0"
→ Gets all P0 issues, runs them all (presumably urgent)
→ DAG: likely all independent — dispatches simultaneously
→ Confirms, executes

### "orchestrate fast-lane"
→ Gets all unmilestoned bugs/fixes
→ Builds DAG from file-conflict and domain-serialization edges
→ Dispatches all ready issues, streams dependent issues as predecessors complete

### "orchestrate milestone user-auth-v2"
→ Fetches all open issues in "User Auth v2" milestone
→ Detects #42 is an investigation issue (title: "Investigate: session expiry race condition under high concurrency")
→ Phase 2: Runs `/work-on 42` — investigation creates 3 new issues (#55-#57)
→ Re-fetches milestone issues, now includes #55-#57
→ Builds DAG: #38, #41, #55, #56 have no predecessors (ready); #39 depends on #38; #57 depends on #55
→ Dispatches #38, #41, #55, #56 simultaneously
→ When #38 completes, #39 dispatches immediately (doesn't wait for #41, #55, or #56)
→ When #55 completes, #57 dispatches immediately (doesn't wait for others)
→ Final report shows investigation spawned issues and streaming execution results
