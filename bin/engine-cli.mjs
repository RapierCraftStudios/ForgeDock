/**
 * Headless entry point: `forgedock run-issue <issue>` drives one issue through the
 * durable engine; scanStalls finds dead-lease issues for the orchestrator to resume.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { runIssue } from "./engine.mjs";

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
function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
