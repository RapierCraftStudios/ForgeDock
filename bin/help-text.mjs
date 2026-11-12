// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Help text and user-facing error wording (#5303). Pure functions so the text is unit-testable (bin/forgedock.mjs runs
 * its router on import). `topLevelHelp` is what `forgedock --help` prints: at most 10 everyday commands in plain
 * language, one screen. `fullHelp` is `forgedock help --all`: every command, grouped by purpose.
 */
import { TAGLINE } from "./brand.mjs";
import { wrap } from "./guide.mjs";

/** The everyday commands, in plain language. Keep to 10 or fewer. */
export const EVERYDAY_COMMANDS = [
  ["setup", "Guided setup: install ForgeDock and configure this repo"],
  ["run-issue <issue>", "Turn one GitHub issue into a reviewed, merged pull request"],
  ["orchestrate <issue...>", "Work on several issues at once, in dependency order"],
  ["watch", "Live view of what each agent is doing"],
  ["status", "Show ForgeDock state for this directory"],
  ["release", "Promote staging to your main branch as one reviewed release"],
  ["stats", "Cost, time and quality report from your GitHub history"],
  ["doctor", "Check the installation and fix what it can"],
  ["guide", "How the workflow fits together, in one screen"],
  ["uninstall", "Remove ForgeDock commands"],
];

/** `npx forgedock setup` is the same as bare `npx forgedock`; the router maps it (see bin/forgedock.mjs). */
export function topLevelHelp({ width = 100 } = {}) {
  const pad = Math.max(...EVERYDAY_COMMANDS.map(([c]) => c.length)) + 2;
  const lines = [`ForgeDock: ${TAGLINE}`, "", "Usage: npx forgedock <command>", "", "Everyday commands"];
  for (const [cmd, desc] of EVERYDAY_COMMANDS) {
    const wrapped = wrap(desc, Math.max(20, width - 2 - pad), " ".repeat(2 + pad));
    lines.push(`  ${cmd.padEnd(pad)}${wrapped.join("\n")}`);
  }
  lines.push("", "More:", "  npx forgedock help --all   every command, grouped by purpose", "  npx forgedock guide        how the workflow fits together");
  return lines.join("\n");
}

export const FULL_COMMAND_GROUPS = [
  ["Set up", [
    ["npx forgedock", "Guided setup: install commands + configure repo (default)"],
    ["npx forgedock guide", "How the workflow fits together: core commands, issue -> staging -> main, where a run ends, how to resume"],
    ["npx forgedock install", "Install commands to ~/.claude/"],
    ["npx forgedock init", "Generate forge.yaml config for your project"],
    ["npx forgedock init --minimal", "Generate a minimal forge.yaml (required sections only)"],
    ["npx forgedock enable [dir]", "Activate ForgeDock in a directory"],
    ["npx forgedock disable [dir]", "Opt a directory out of ForgeDock"],
    ["npx forgedock demo", "Set up a risk-free demo repo and print next steps"],
    ["npx forgedock first-run", "On this repo: propose 3 small issues, file them on approval, run one to a PR (stats --first-merge reports time to first merged PR)"],
    ["npx forgedock labels [setup] [--repo owner/repo] [--domain a,b,c]", "Bootstrap ForgeDock-managed labels on a GitHub repo, plus optional per-repo domain labels (idempotent)"],
    ["npx forgedock config migrate [dir]", "Backfill missing optional sections into an existing forge.yaml (idempotent)"],
    ["npx forgedock config history | diff <n> | rollback <n> | record [reason] | import-bak [--delete]", "Versioned forge.yaml: list its saved versions, diff or roll back to one, record the current one, import old .bak files"],
    ["npx forgedock auth login [--byo] [--broker-url URL] [--client-id ID] [--installation N] [--org ORG] | status | logout", "Sign in as a GitHub App so pipeline calls use a short-lived installation token instead of your own gh auth (the broker URL must be https)"],
    ["npx forgedock doctor", "Check installation health"],
    ["npx forgedock doctor --fix", "Auto-fix deterministic issues (symlinks, hook, labels, legacy block) and reclaim ForgeDock-owned leftovers (forge.yaml hygiene TTLs)"],
    ["npx forgedock doctor --verbose", "Also show internal and legacy checks (FORGE_HOME, Playwright MCP, version-gated features, resource hygiene)"],
    ["npx forgedock doctor --lanes", "Lane preflight: pool token, pool agent version, PATH shim loops, gh --json fields; prints every check pass/fail"],
    ["npx forgedock update", "Pull latest & reinstall"],
    ["npx forgedock uninstall", "Remove commands"],
    ["npx forgedock opencode install", "Install token-efficient native OpenCode commands"],
    ["npx forgedock opencode status", "Check the OpenCode adapter"],
    ["npx forgedock opencode uninstall", "Remove ForgeDock-owned OpenCode files"],
    ["npx forgedock version", "Print the installed version and check for updates"],
    ["npx forgedock help", "Show this help"],
  ]],
  ["Run work", [
    ["npx forgedock run <cmd> [args]", "Run a command headlessly (local claude CLI or Anthropic API)"],
    ["npx forgedock bootstrap <idea|docs> [--dry-run] [--spike <path>] | --plan <plan.json> [--dry-run]", "Headless /bootstrap: idea to orchestrate-ready backlog (--dry-run previews milestones, titles, DAG and estimated agent cost without GitHub writes); --plan validates and creates (or previews) a plan, and re-running resumes from GitHub"],
    ["npx forgedock run-issue <issue> [--lane <lane>] [--lane-override] [--path core|full] [--retry] [--wait-lease]", "Work one issue from claim to merge (the lane comes from the issue: its milestone, else staging; --lane only asserts it). --retry reopens a failed run, or one needing a human once the label is cleared; --wait-lease waits for another holder of the issue; exit status 75 means deferred, nothing was lost"],
    ["npx forgedock plan validate --live [--repo owner/repo] [--json]", "Re-run the bootstrap dependency-order rules on live GitHub state: each cross-milestone Depends-on edge is ok, held or invalid (fails on invalid)"],
    ["npx forgedock orchestrate <issue...> [--parallel K] [--lane L]", "Work on several issues with bounded concurrency and Depends-on ordering; each issue on its own lane, cross-lane dependencies reported"],
    ["npx forgedock orchestrate --resume <id> [N...] | --set-parallel <id> K | --set-max-remote <id> N | --set-placement <id> remote|hybrid|local | --add <id> N... | --requeue <id> N... [--reason \"...\"] | --cancel <id> | --hold <id> N... [--for 4h] [--reason \"...\"] | --adopt <issue> | --gc-orphans | --release <id> N... | --show-env <id> | --set-env <id> KEY=VAL | --unset-env <id> KEY", "Reattach to a running or finished batch (a finished one replays its report, an interrupted one resumes), change its concurrency or placement live, add, requeue, hold (with an owner and an optional expiry, --for) or release single issues, adopt an open hand-built PR, cancel orphaned batches (--gc-orphans), stop one batch without stopping the background scheduler, or print, set or unset the batch environment (secrets redacted; applies to newly started lanes)"],
    ["npx forgedock triage <issue...> [--lane L] [--dry-run]", "Already-fixed pre-filter: close issues a merged PR or green CI already resolved; print the rest"],
    ["npx forgedock probe [issue...] [--dry-run]", "Run declared acceptance probes for closed issues whose fix is on the default branch; a fail reopens the issue"],
    ["npx forgedock interfaces check|register|contract", "Interface contracts: require an Interfaces section on a spike/epic with 2+ slices, register its rows in the decision register, generate seam contract tests"],
    ["npx forgedock acceptance check|run|gate", "Feature-level acceptance: validate an epic's journeys, run them on the milestone branch, gate ship/close on a green run"],
    ["npx forgedock check [--base REF] [--json]", "Run the lane's frozen validate commands and change-scoped pre-PR checks locally in this worktree, as the engine will (no GitHub, no Actions)"],
    ["npx forgedock milestone train <slug...> [--parallel-milestones N] | --resume <id> | --insert <id> <slug> [--before s|--after s] | --show <id>", "Unattended multi-milestone train: one durable state file (order, active set, lifecycle), typed STOP reasons, resumable; never edits forge.yaml"],
    ["npx forgedock issue-watch run [--name <w>] [--repo owner/repo] [--once] [--dry-run] | status [--name <w>]", "Named, scoped, capped watches (forge.yaml issue_watch.watches) that claim matching open issues into lanes or one long-lived orchestrate batch, or (mode: release) pool them and cut themed releases; see docs/ISSUE-WATCH.md"],
    ["npx forgedock prod-watch run [--repo owner/repo] [--once] [--interval <s>] [--dry-run] | status", "Production-side watcher (forge.yaml prod_watch): read-only signal sources -> triage -> governor -> issues, kill-switch file, owner digest; see docs/PROD-WATCH.md"],
    ["npx forgedock ci budget [--repo owner/repo] [--json] [--digest] [--propose [--base REF]] [--set-mode MODE] [--budget MINUTES] [--reserve PCT] [--plan PLAN]", "Actions-minutes budget: month-to-date usage, projection and where CI runs (remote or local-first); sets the mode and budget"],
    ["npx forgedock replan apply --amendment N --repo owner/repo", "After an amendment merged, re-evaluate the open sibling issues held behind it"],
    ["npx forgedock resume-stalled [--dry-run]", "Fleet stall recovery: re-dispatch issues whose run stopped holding its claim"],
  ]],
  ["Watch and report", [
    ["npx forgedock status [dir]", "Show ForgeDock state for a directory"],
    ["npx forgedock guards list [--path p] [--json] | backfill --since <date> [--dry-run]", "Fix guards: list the records (test files + protected hunks of merged fixes) covering a path, or build them for already-merged runs"],
    ["npx forgedock limits show | clear <id>|--all", "Show or clear per-account usage-limit holds shared by orchestrate batches"],
    ["npx forgedock decisions list [--stale] [--refresh]", "List anchored decisions (FORGE:DECISION); --stale shows those with an anchor missing on the base"],
    ["npx forgedock watch [--repo owner/repo]", "Live per-agent orchestration view (Ctrl+C to exit)"],
    ["npx forgedock report [--days 30] [--md] [--json]", "30-day pipeline impact receipts for your repo"],
    ["npx forgedock stats [--since <ver|date>] [--repo owner/repo] [--json] [--refresh]", "Version-over-version cost/time/flow/review/gate report from GitHub telemetry (no model)"],
    ["npx forgedock stats --self-filed [--repo R] [--since D]", "Share of new issues the pipeline filed itself, by kind, against the 15% target (#5207)"],
    ["npx forgedock stats --conformance-outcomes [--repo owner/repo] [--since <date>] [--window-days 7] [--replay <pr,...> --enforce-domains <list>]", "Read-only: do conformance blocks predict post-merge defects (2x2 per repo, failure kind and risk surface; --replay a PR list against an enforce config)"],
    ["npx forgedock stats --depth [--since <ver|date>] [--min-n N] [--offline] [--repo owner/repo] [--json]", "Light-eligible vs ineligible lane outcomes, by reason/signal, and the #5052 light-lane promotion verdict"],
    ["npx forgedock stats --first-merge [--repo owner/repo]", "Setup start to first merged PR for a first-run repo, against the 15 min target (#5290)"],
    ["npx forgedock replay --timelapse <batch|epic> [--repo owner/repo] [--out dir] [--format gif|mp4] [--duration 30-90]", "Read-only 30-90 s time-lapse (frames, vhs tape, GIF/MP4 when vhs is installed) of a recorded batch or epic from the lifecycle event log"],
    ["npx forgedock stats --origin [--repo R] [--since D] [--json]", "Requested vs pipeline-generated issues by origin, how pipeline-found ones closed, and their cost share (#5294)"],
  ]],
  ["Release", [
    ["npx forgedock selftest [--static] | --live --repo <owner/sandbox> [--lang node|python] [--pr <N>] | --journey [--repo <owner/sandbox>] [--pr <N>] [--update-snapshots]", "Live contract harness: drives the real gh, git and orchestrate through a disposable sandbox repo (steps create, add, body, resume, merge, remote, cleanup) plus a static check of every gh --json field list; exits non-zero naming the failed step; --pr posts the FORGE:SELFTEST result the staging->main review requires; --journey runs the packed CLI as a new user (clean environment, then a sandbox repo to a merged PR) and posts FORGE:JOURNEY; see docs/SELFTEST.md"],
    ["npx forgedock review-staging [<PR>] [--thorough] [--json]", "Staging->main review pre-dispatch: route marker, open-finding gate, scope, prepare, roster; writes one reviewer brief per domain"],
    ["npx forgedock review-staging [<PR>] --finalize --test-gate-output <file>", "Staging->main review post-dispatch: delivery, test-gate verdict, extract/classify/file-prepare; prints the findings to file"],
    ["npx forgedock review-staging [<PR>] --summary [--filed <N>]...", "Staging->main review Phase 8: verdict and summary comment with the FORGE:GATE_PASS / FORGE:GATE_FAILURE marker"],
    ["npx forgedock release [--repo owner/repo] [--merge] [--watch] [--resume <id>] | release verify <sha> [--repo owner/repo]", "Staging->default release as one resumable job: preflight, release PR, review, fixes, promotion (stops at GATE_PASS unless --merge or release.auto_merge), post-merge; release.mode: snapshot cuts release/<id> from staging (lanes keep merging, fixes are cherry-picked, FORGE:RELEASE records them); verify checks a release head against that record"],
  ]],
  ["Maintenance and hosting", [
    ["npx forgedock fix-close-reasons <owner/repo> [--milestone <m>] [--apply]", "Re-close issues that were closed not planned but carry workflow:merged or workflow:decomposed (delivered, not dropped) as completed, with a comment; dry run unless --apply; workflow:invalid issues are never touched"],
    ["npx forgedock sched show | cap <N>|--clear | weight <owner/repo> <N>|--clear", "Show the host lane registry, set the host-wide lane cap shared by orchestrate batches, or set a repo's share of slots within a priority (default equal)"],
    ["npx forgedock schedd [status | watchdog]", "Host scheduler daemon hosting every orchestrate batch (auto-spawned by orchestrate; run in the foreground for a systemd-user unit); status shows its pid, batches and last tick; watchdog restarts a stalled daemon"],
    ["npx forgedock pool router [install] | enroll [--cpus N --mem GB] | status | upgrade [agent] | remove <agent>", "Built-in remote compute pool: run the router (foreground, or install it as a user service), print the one-time install command for a host, list agents, upgrade or remove them"],
    ["npx forgedock gc [--apply] [--older-than 6h] [--docker] [--worktrees] [--branches] [--tmp] [--processes] [--sandboxes]", "Report (dry-run default) and reclaim ForgeDock-owned leftovers: stale run ledgers, labelled containers/volumes, agent worktrees, abandoned branches, scratch files, orphaned processes and sandboxes; unowned resources and unpushed work are only reported"],
  ]],
];

export const FLAG_ROWS = [
  ["--fast", "Skip animation/motion"],
  ["--manual", "Plain text prompts instead of the review screen (init)"],
  ["--verbose", "Show detection sources for every field (init)"],
  ["--minimal", "Generate a minimal forge.yaml with required sections only (init)"],
  ["--refresh-context", "Regenerate review.context/tech_stack from manifests and show a diff for approval (init)"],
  ["--no-splash", "Skip installing the startup splash plugin during setup (or set FORGEDOCK_NO_SPLASH=1)"],
  ["--version, -v", "Print the installed version and check for updates"],
];

/** Every command, grouped by purpose (`forgedock help --all`). */
export function fullHelp({ width = 100 } = {}) {
  const lines = [`ForgeDock: ${TAGLINE}`, "", "Usage: npx forgedock <command>  (npx forgedock help for the everyday commands)"];
  for (const [name, rows] of FULL_COMMAND_GROUPS) {
    lines.push("", name);
    for (const [cmd, desc] of rows) {
      lines.push(`  ${cmd}`, ...wrap(desc, width - 6, "      ").map((l, i) => (i === 0 ? "      " + l : l)));
    }
  }
  lines.push("", "Flags");
  for (const [flag, desc] of FLAG_ROWS) lines.push(`  ${flag.padEnd(20)}${desc}`);
  return lines.join("\n");
}

/** User-facing run-issue errors: what happened, why, and the one command that fixes it. No engine terms. */
export const USER_ERRORS = {
  noRepoOrchestrate: "Can't tell which GitHub repository this is, because this directory has no GitHub remote. Run it inside a clone of the repository, or add --repo owner/name.",
  recoverUnsupported: "--recover only works with the default pipeline. Drop --recover, or drop --path full.",
  noRepo: "Can't tell which GitHub repository this is, because this directory has no GitHub remote. Run it inside a clone of the repository, or add --repo owner/name.",
  retryUnsupported: "That option only works with the legacy pipeline. A normal rerun already resumes from the open pull request or pushed branch, so drop the option, or add --path full to use it.",
  laneRequired: "--lane is required with --path full, so a run never targets production by accident. Add --lane staging (or --lane milestone/<slug>).",
};
