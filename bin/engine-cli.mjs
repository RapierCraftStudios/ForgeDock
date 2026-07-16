/**
 * Headless entry point: `forgedock run-issue <issue>` drives one issue through the
 * durable engine; scanStalls finds dead-lease issues for the orchestrator to resume.
 * `forgedock resume-stalled [--dry-run] [--lane <lane>]` enumerates all in-flight
 * issues, calls scanStalls, and re-dispatches each stalled issue via run-issue.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runIssue } from "./engine.mjs";
import { makeProjector } from "./engine/projector.mjs";
import { readLog, deriveState } from "./engine/runlog.mjs";

/**
 * Workflow labels that mark an issue as "in the pipeline" (not yet terminal).
 * Shared by resume-stalled's candidate enumeration and countEngineActivity()
 * (the re-entry dashboard's in-flight/stalled counter, #1945) so both surfaces
 * agree on what "in-flight" means — a single source of truth rather than two
 * lists that can silently drift apart.
 */
export const ACTIVE_WORKFLOW_LABELS = [
  "workflow:investigating",
  "workflow:ready-to-build",
  "workflow:building",
  "workflow:in-review",
];

const pexec = promisify(execFile);

/**
 * Real gh/git accessors.
 *
 * `timeout: 10000` matches the convention already used for the sibling
 * `gh pr list` call in the interactive dashboard (bin/forgedock.mjs's
 * gatherDashboardData()). Every io.gh()/io.git() call site issues a single,
 * normally-fast metadata command (gh issue view, gh api .../comments,
 * gh pr list/view, git rev-list --count) — none are legitimately
 * long-running — so one shared timeout is appropriate across all callers
 * (the interactive status dashboard, run-issue, and resume-stalled). A
 * hung/black-holed gh process (flaky network, corporate proxy, stuck auth
 * prompt) would otherwise hang commands like `npx forgedock status`
 * indefinitely (#1962). Callers already wrap every io.gh()/io.git() call in
 * try/catch and degrade to null/"unknown" on any rejection, so a timeout
 * fails closed gracefully with no additional error handling required.
 */
export function makeIo() {
  const run = (bin) => async (args) => {
    const { stdout } = await pexec(bin, args, { maxBuffer: 100 * 1024 * 1024, timeout: 10000 });
    return stdout;
  };
  return { gh: run("gh"), git: run("git") };
}

export function runDir() { return join(homedir(), ".forge", "runs"); }

/**
 * Resolves the repo `gh` would target by default (i.e. resolved from the cwd
 * git remote), via `gh repo view`. Used to validate an explicit `--repo` flag
 * against the ambient context — see `assertRepoMatchesCwd`.
 * @param {{gh: Function}} io
 * @returns {Promise<string|null>} "owner/repo", or null if it can't be determined
 */
async function resolveDefaultRepo(io) {
  try {
    const out = await io.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    const repo = String(out).trim();
    return repo || null;
  } catch {
    return null;
  }
}

/**
 * Guards against cross-repo state confusion (forge#1593): `--repo` used to be
 * threaded into the `gh issue list` enumeration call but never into the
 * projector's state reads/writes or into re-dispatch, so a mismatched
 * `--repo` silently read/wrote FORGE:STATE in the cwd-resolved repo instead
 * of the requested one. Fully threading `--repo` through every `io.gh`/
 * `io.git` call site the engine makes during a run (phases.mjs, reconcile.mjs,
 * projector.mjs) would be a much larger, riskier change. Instead, this fails
 * closed: if `--repo` is given and doesn't match the repo `gh` would use by
 * default, refuse to run at all rather than silently mixing repos.
 * @param {{gh: Function}} io
 * @param {string|null} repo
 * @returns {Promise<void>}
 */
async function assertRepoMatchesCwd(io, repo) {
  if (!repo) return;
  const defaultRepo = await resolveDefaultRepo(io);
  if (defaultRepo === null) {
    throw new Error(
      `--repo ${repo} was given, but the current repo could not be determined (\`gh repo view\` failed) to ` +
      `verify it matches. Refusing to run cross-repo without verification.`
    );
  }
  if (defaultRepo !== repo) {
    throw new Error(
      `--repo ${repo} does not match the current repo (${defaultRepo}). Cross-repo dispatch is not supported — ` +
      `state reads/writes (issue view/edit) are cwd-scoped and would silently target ${defaultRepo} instead of ` +
      `${repo}. Run this command with cwd set to a checkout of ${repo}, or omit --repo to operate on ${defaultRepo}.`
    );
  }
}

/**
 * @param {number[]} issues
 * @param {{readState:(i:number)=>Promise<{terminal:boolean,lease:?{until:number}}|null>}} io
 * @param {number} now
 * @returns {Promise<number[]>} issues that appear stalled (expired lease, non-terminal)
 */
export async function scanStalls(issues, io, now) {
  const stalled = [];
  for (const i of issues) {
    const s = await io.readState(i);
    if (s && !s.terminal && s.lease && s.lease.until < now) stalled.push(i);
  }
  return stalled;
}

/**
 * Read-only in-flight/stalled counter for the `status`/`install` re-entry
 * dashboard (#1945). Reuses the exact same enumeration + lease-expiry logic
 * as `resumeStalledFromCli` (workflow-label search via `gh issue list`, then
 * `scanStalls` against the GitHub-authoritative FORGE:STATE via the
 * projector) — GitHub is this codebase's source of truth for run state, not
 * the local `~/.forge/runs` hot-path log, so the dashboard counts the same
 * way the orchestrator does. Never dispatches or mutates anything.
 *
 * Best-effort: a `gh issue list` failure for one label is swallowed (treated
 * as zero matches for that label) — consistent with resumeStalledFromCli's
 * existing tolerance — so one bad label search never blocks the others.
 *
 * @param {{gh: Function}} io
 * @param {string|null} repo - "owner/repo", or null to use gh's cwd-resolved default
 * @param {number} now
 * @returns {Promise<{total: number, inFlight: number, stalled: number}>}
 */
export async function countEngineActivity(io, repo, now) {
  const repoFlag = repo ? ["--repo", repo] : [];
  const issueSet = new Set();

  for (const label of ACTIVE_WORKFLOW_LABELS) {
    try {
      const out = await io.gh([
        "issue", "list",
        ...repoFlag,
        "--state", "open",
        "--label", label,
        "--limit", "100",
        "--json", "number",
      ]);
      const items = JSON.parse(out);
      for (const { number } of items) issueSet.add(number);
    } catch {
      // gh may return non-zero when no issues match, or fail transiently —
      // treat as empty for this label rather than aborting the whole count.
    }
  }

  if (issueSet.size === 0) return { total: 0, inFlight: 0, stalled: 0 };

  const projector = makeProjector(io);
  const candidates = [...issueSet];
  const stalled = await scanStalls(candidates, projector, now);
  return { total: candidates.length, inFlight: candidates.length - stalled.length, stalled: stalled.length };
}

/**
 * Best-effort summary of the most recently modified local run-log under
 * `~/.forge/runs` (runDir()). This is a MACHINE-LOCAL view — the crash-safe
 * hot-path log described in engine/runlog.mjs, not the GitHub-authoritative
 * state used by countEngineActivity() above. Appropriate only for a "what did
 * I last run here" dashboard row, not for cross-machine in-flight/stalled
 * counts.
 *
 * Never throws: returns null when the runs dir doesn't exist, holds no
 * `.jsonl` files, or the newest file can't be read/parsed. A single corrupt
 * or unreadable file is skipped in favor of the next-newest one rather than
 * failing the whole lookup (forge#1528 — batch operations here must not abort
 * on one bad item).
 *
 * @param {string} dir - runDir()
 * @returns {{issue: number, terminal: boolean, terminalReason: string|null} | null}
 */
export function lastLocalRun(dir) {
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  // Sort newest-first by mtime so a corrupt newest file falls through to the
  // next-newest candidate instead of giving up entirely.
  const withMtime = [];
  for (const f of entries) {
    try {
      withMtime.push({ f, mtime: statSync(join(dir, f)).mtimeMs });
    } catch {
      // unreadable — skip
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);

  for (const { f } of withMtime) {
    const issue = parseInt(f.slice(0, -".jsonl".length), 10);
    if (!Number.isInteger(issue)) continue;
    try {
      const events = readLog(dir, issue);
      if (events.length === 0) continue;
      const state = deriveState(events);
      return { issue, terminal: state.terminal, terminalReason: state.terminalReason };
    } catch {
      continue; // corrupt file — try the next-newest
    }
  }
  return null;
}

/**
 * @param {string[]} argv
 * @param {{io?: {gh: Function}, runIssue?: Function}} [deps]
 *   Injectable for tests — defaults to real `gh`/`git` (makeIo()) and the real
 *   `runIssue` engine driver.
 *
 * Flags:
 *   --lane <lane>          Required — e.g. `main` or `staging`.
 *   --repo <owner/repo>    Optional — must match the cwd-resolved repo (forge#1593).
 *   --backend <cli|api|auto>  Optional (forge#2028). Forwarded to every phase's
 *                          `runCommand()` call. Omit to keep runner.mjs's own
 *                          default ("auto" ladder — probes the `claude` CLI, falls
 *                          back to the API). Mirrors `bin/forgedock.mjs`'s `run()`
 *                          `--backend` semantics — validation (rejecting invalid
 *                          values) is left to `runCommand()`'s own `resolveBackend()`
 *                          rather than duplicated here.
 *   --model <id>           Optional (forge#2028). Forwarded to every phase's
 *                          `runCommand()` call; only applies on the "api" backend.
 *                          Omit to keep runner.mjs's default (`FORGEDOCK_MODEL` env
 *                          or its built-in default).
 */
export async function runFromCli(argv, deps = {}) {
  const issue = parseInt(argv[0], 10);
  if (!Number.isInteger(issue)) throw new Error("usage: forgedock run-issue <issue-number> --lane <lane>");
  const lane = flag(argv, "--lane");
  if (!lane) throw new Error("--lane is required: e.g. --lane main or --lane staging. No default to prevent accidental production targeting.");
  const repo = flag(argv, "--repo");
  const backend = flag(argv, "--backend");
  const model = flag(argv, "--model");
  const io = deps.io ?? makeIo();
  await assertRepoMatchesCwd(io, repo);
  const runIssueFn = deps.runIssue ?? runIssue;
  const agentId = `cli_${process.pid}`;
  const res = await runIssueFn({ issue, dir: runDir(), agentId, lane, io,
    runner: (await import("./runner.mjs")).runCommand, now: () => Date.now(),
    // Only forwarded when explicitly provided — omitting them preserves
    // runIssue's/runner.mjs's existing defaults (forge#2028).
    ...(backend ? { backend } : {}),
    ...(model ? { model } : {}) });
  console.log(`issue #${issue} → ${res.terminalReason}`);
  return res;
}

/**
 * `forgedock resume-stalled [--dry-run] [--lane <lane>] [--repo <owner/repo>]`
 *
 * Enumerates all open issues carrying non-terminal workflow labels, reads each
 * issue's FORGE:STATE block via the projector, identifies those with an expired
 * lease (stalled), and re-dispatches them through the existing run-issue path.
 *
 * Flags:
 *   --dry-run   Print the stalled list and exit 0 without dispatching anything.
 *   --lane      Lane to pass to run-issue (required — no default to prevent accidental production targeting).
 *   --repo      GitHub repo (owner/repo). Must match the repo `gh` resolves by default
 *               (the cwd git remote) — cross-repo dispatch is refused (forge#1593),
 *               since state reads/writes are cwd-scoped and would otherwise silently
 *               target the wrong repo. Omit --repo to operate on the cwd-resolved repo.
 *
 * Per-issue dispatch failures are caught and isolated — one issue's engine error
 * (e.g. NO_API_KEY/NO_SDK or any other uncaught phase error from runIssue) does
 * not abort dispatch of the remaining stalled issues in the batch. Failures are
 * recorded in the returned `failed` array; the caller decides how to surface them.
 *
 * @param {string[]} argv
 * @param {{io?: {gh: Function}, dispatch?: (argv: string[]) => Promise<any>}} [deps]
 *   Injectable for tests — defaults to real `gh`/`git` (makeIo()) and the real
 *   `runFromCli` dispatcher.
 */
export async function resumeStalledFromCli(argv, deps = {}) {
  const dryRun = argv.includes("--dry-run");
  const lane   = flag(argv, "--lane");
  if (!lane) throw new Error("--lane is required for resume-stalled: e.g. --lane main or --lane staging.");
  const repo   = flag(argv, "--repo");

  const io = deps.io ?? makeIo();
  await assertRepoMatchesCwd(io, repo);
  const dispatch = deps.dispatch ?? runFromCli;
  const projector = makeProjector(io);
  const now = Date.now();

  // Collect candidate issue numbers from all non-terminal workflow labels
  // (ACTIVE_WORKFLOW_LABELS — shared with countEngineActivity() so both
  // surfaces agree on what "in-flight" means).
  const repoFlag = repo ? ["--repo", repo] : [];
  const issueSet = new Set();

  for (const label of ACTIVE_WORKFLOW_LABELS) {
    try {
      const out = await io.gh([
        "issue", "list",
        ...repoFlag,
        "--state", "open",
        "--label", label,
        "--limit", "100",
        "--json", "number",
      ]);
      const items = JSON.parse(out);
      for (const { number } of items) issueSet.add(number);
    } catch {
      // gh may return non-zero when no issues match — treat as empty.
    }
  }

  if (issueSet.size === 0) {
    console.log("resume-stalled: no in-flight issues found.");
    return { stalled: [], dispatched: [], failed: [] };
  }

  const candidates = [...issueSet];
  const stalled = await scanStalls(candidates, projector, now);

  if (stalled.length === 0) {
    console.log("resume-stalled: all in-flight issues have active leases — nothing stalled.");
    return { stalled: [], dispatched: [], failed: [] };
  }

  console.log(`resume-stalled: ${stalled.length} stalled issue(s) found: ${stalled.map((n) => `#${n}`).join(", ")}`);

  if (dryRun) {
    console.log("resume-stalled: --dry-run — not dispatching.");
    return { stalled, dispatched: [], failed: [] };
  }

  const dispatched = [];
  const failed = [];
  for (const issue of stalled) {
    console.log(`resume-stalled: dispatching #${issue} …`);
    try {
      await dispatch([String(issue), "--lane", lane, ...(repo ? ["--repo", repo] : [])]);
      dispatched.push(issue);
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`resume-stalled: #${issue} failed: ${message}`);
      failed.push({ issue, error: message });
    }
  }

  if (failed.length > 0) {
    console.log(
      `resume-stalled: ${dispatched.length} dispatched, ${failed.length} failed: ` +
        `${failed.map((f) => `#${f.issue}`).join(", ")}`,
    );
  }

  return { stalled, dispatched, failed };
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
