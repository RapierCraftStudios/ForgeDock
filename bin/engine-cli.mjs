/**
 * Headless entry point: `forgedock run-issue <issue>` drives one issue through the
 * durable engine; scanStalls finds dead-lease issues for the orchestrator to resume.
 * `forgedock resume-stalled [--dry-run] [--lane <lane>]` enumerates all in-flight
 * issues, calls scanStalls, and re-dispatches each stalled issue via run-issue.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { runIssue } from "./engine.mjs";
import { makeProjector } from "./engine/projector.mjs";

const pexec = promisify(execFile);

/** Real gh/git accessors. */
export function makeIo() {
  const run = (bin) => async (args) => {
    const { stdout } = await pexec(bin, args, { maxBuffer: 100 * 1024 * 1024 });
    return stdout;
  };
  return { gh: run("gh"), git: run("git") };
}

export function runDir() { return join(homedir(), ".forge", "runs"); }

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

export async function runFromCli(argv) {
  const issue = parseInt(argv[0], 10);
  if (!Number.isInteger(issue)) throw new Error("usage: forgedock run-issue <issue-number>");
  const lane = flag(argv, "--lane") || "staging";
  const io = makeIo();
  const agentId = `cli_${process.pid}`;
  const res = await runIssue({ issue, dir: runDir(), agentId, lane, io,
    runner: (await import("./runner.mjs")).runCommand, now: () => Date.now() });
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
 *   --lane      Lane to pass to run-issue (default: "staging").
 *   --repo      GitHub repo (owner/repo). Defaults to the repo inferred by gh.
 *
 * Exit codes: 0 on success or dry-run. Non-zero on dispatch error.
 */
export async function resumeStalledFromCli(argv) {
  const dryRun = argv.includes("--dry-run");
  const lane   = flag(argv, "--lane") || "staging";
  const repo   = flag(argv, "--repo");

  const io = makeIo();
  const projector = makeProjector(io);
  const now = Date.now();

  // Collect candidate issue numbers from all non-terminal workflow labels.
  const ACTIVE_LABELS = [
    "workflow:investigating",
    "workflow:ready-to-build",
    "workflow:building",
    "workflow:in-review",
  ];

  const repoFlag = repo ? ["--repo", repo] : [];
  const issueSet = new Set();

  for (const label of ACTIVE_LABELS) {
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
    return { stalled: [], dispatched: [] };
  }

  const candidates = [...issueSet];
  const stalled = await scanStalls(candidates, projector, now);

  if (stalled.length === 0) {
    console.log("resume-stalled: all in-flight issues have active leases — nothing stalled.");
    return { stalled: [], dispatched: [] };
  }

  console.log(`resume-stalled: ${stalled.length} stalled issue(s) found: ${stalled.map((n) => `#${n}`).join(", ")}`);

  if (dryRun) {
    console.log("resume-stalled: --dry-run — not dispatching.");
    return { stalled, dispatched: [] };
  }

  const dispatched = [];
  for (const issue of stalled) {
    console.log(`resume-stalled: dispatching #${issue} …`);
    await runFromCli([String(issue), "--lane", lane, ...(repo ? ["--repo", repo] : [])]);
    dispatched.push(issue);
  }

  return { stalled, dispatched };
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
