# Pipeline failure classes: measured 2026-11-26

Read this before changing a gate, the engine, the scheduler or the pool. Solve the measured classes below, not a guess.
To refresh the numbers for any repo: `node scripts/failure-census.mjs --repo owner/repo --since YYYY-MM-DD` (read-only).

Sources: 215 NEEDS_HUMAN/PARKED comments on 102 open issues with comments (this repo plus one large Python/Next.js
consumer repo), the batch logs of both repos, and two live audits of pool hosts:
[lane compute](2026-11-26-lane-compute-audit.md) and [lane lifecycle, repo storage and network](2026-11-26-lane-lifecycle-audit.md).

## 1. Why lanes parked (needs-human)

| Class | Share | Mechanism | Owner issue / fix |
|---|---|---|---|
| Remote sandbox tool gap | ~36% | `Remote sandbox lacks <tool>` with host fallback off and no recipe; one recipe per tool | #6018 generic install, #6017 registry lane image |
| Shape gates (amendment syntax, post-deploy check id, scope, recurrence design, hotspot growth) | ~30% | Rules about the form of the work; a malformed amendment replayed every rerun parked one issue 19× on identical rows | #6018 made them advisory |
| Frozen contract wrong upstream | most amendments | Plan freezes a guessed file list and validate commands it never ran (71 `add-deliverable`, some validates fail on the unchanged base) | contract-at-freeze probes (#5749) |
| Deferred/measurement rows judged as omissions | recurring | Review flags rows the contract deferred (metrics, production replays) as `conformance.omission` | #6051 |
| "no status" rows | recurring | Builder skipped a requirement; engine sends a generic resume, then parks | #6058 |
| Issue spec mixes two features | recurring | One requirement is really another feature; the builder narrows it, the gate flags it | split the issue (e.g. #6013 → #6049) |

Parks per day rose from ~5–15 to 34/70/53 on 11-23..25, when five releases shipped in three days: batches re-admit held
lanes on an engine upgrade, so each new gate judged contracts frozen before the gate existed.

## 2. Why merges conflicted
45 of 67 conflicted base-syncs were in two files the gates made every lane edit (a module dossier and
`.forge/post-deploy-checks.json`). Lanes now prefer a new `devdocs/decisions/<issue>-<slug>.md` (#6018).

## 3. Where lane time goes (merged lanes)
- Queue wait dominates: median 9 min (this repo) / 36 min (consumer repo), p90 hours. Capacity deferrals: thousands per batch.
- Model wait 31–55% of lane time; CI + merge wait ~24% with the slot held.
- Whole-repo precheck: median 149 s/lane regardless of the diff; cold dependency installs 244 s median in ~half the consumer lanes.
- Claim: 10–12 s of serial GitHub writes before any work.

## 4. Compute per lane (live cgroup data)
Average ~0.4 core / ~0.3 GB, median peak ~650 MB; the `claude` CLI is the largest RAM item (260–310 MB). Lanes are admitted
against ceilings and peak projections, not use; test runners size from the VM (`--test-concurrency=20` in a 4-CPU box);
no `--init` → zombies (#6052). Elastic lanes: #6047.

## 5. Repo storage and network
One bare mirror per repo per host and a `--shared` clone per lane (good), but every lane also keeps an unused full
checkout next to its worktree (299 MB per lane on the consumer repo). Dependencies are hardlinked from a shared cache.
The orchestrator→router→agent mirror seed sent nothing in 56/120 launches and fell back to GitHub in 20%: prefer
`execution.repo_source: github` and a worker-local mirror. Minimal local-only lane: fetch delta → worktree → hardlink deps → work → push.

## 6. Host / orchestrator incidents (one day)
- Agent upgrade built the lane image on the host under memory pressure → host crash (#6017: pull, never build).
- Another tenant on the same host filled its disk (unarchived database WAL, 215 GB) → disk guard blocked all lanes.
- Per-user WSL VMs, keepalive tasks and an SSH-held `sleep infinity` kept restarting a VM during maintenance.
- Windows installer failed when Tailscale belonged to another Windows user (#6034).
- No per-repo host placement (#6041); a breaker trip ended the batch runner (#6042); relaunches bypassed holds.
- Post-merge verification blamed PRs for base CI that was already red (#6055).

## Direction
A plug-and-play worker pool (#6056): one-command outbound workers on any host, measured-capacity admission with
elastic lanes, auto-scale/drain, registry images, per-repo affinity, a self-healing orchestrator, and local-first
lanes whose only network use is a fetch, a push, GitHub API calls and the model API.
