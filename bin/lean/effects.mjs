// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Core work-on: the real effects behind runCore's injected `io`. Argv only, no shell. */
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, appendFileSync, mkdirSync, statSync, existsSync, rmSync, writeFileSync, renameSync, readdirSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, hostname, freemem, loadavg, cpus, tmpdir } from "node:os";
import { promises as fsp } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCliBackendAsync, resolveClaudeCliBinary, getClaudeCliCapabilities, buildLeanSessionFlags, buildReadOnlyToolFlags } from "../runner.mjs";
import { makeIo } from "../engine-cli.mjs";
import { makeProjector } from "../engine/projector.mjs";
import { makeLedger, countLiveLanes, ledgerRoot } from "./ledger.mjs";
import { makeDepCache } from "./depcache.mjs";
import { makeHeavyIo } from "./heavy.mjs";
import { gatherContextFacts } from "./context.mjs";
import { enumeratingTests, missingEntries } from "./enumerating.mjs";
import { sequenceCollisions, snapshotLane, verifyRenumber } from "./sequence.mjs";

const pexec = promisify(execFile);
const script = (n) => fileURLToPath(new URL(`../../scripts/${n}`, import.meta.url));
/** Argv-only child with stdin input; resolves stdout, rejects on a non-zero exit with stderr attached. */
export function runWithInput(bin, args, input, timeout = 120000) {
  return new Promise((res, rej) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; rej(err); } else res(String(stdout));
    });
    // A child that exits before reading stdin closes the pipe: EPIPE must reject via the exit callback, never crash the lane.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Claude CLI session runner: fresh session, or `--resume <id>` for the builder. Resolves usage + session_id. */
let systemdProbe = null;
/** `systemd-run --user --scope` usable here? Probed once and cached. */
export function systemdRunAvailable() {
  if (systemdProbe === null) {
    try { execFileSync("systemd-run", ["--user", "--scope", "-q", "true"], { stdio: "ignore", timeout: 5000 }); systemdProbe = true; } catch { systemdProbe = false; }
  }
  return systemdProbe;
}
const MEM_RE = /^\d+(\.\d+)?[KMGT]?$/i, CPU_RE = /^\d+%$/;
/** Cap the whole lane process tree: spawn under `systemd-run --user --scope -p MemoryMax=.. -p CPUQuota=..`. Unset or invalid limits leave the spawn unchanged. */
export function wrapLaneLimits(bin, args, limits) {
  const mem = limits?.memory_max && MEM_RE.test(String(limits.memory_max)) ? String(limits.memory_max) : null;
  const cpu = limits?.cpu_quota && CPU_RE.test(String(limits.cpu_quota)) ? String(limits.cpu_quota) : null;
  if (!mem && !cpu) return { bin, args };
  return { bin: "systemd-run", args: ["--user", "--scope", "-q", ...(mem ? ["-p", `MemoryMax=${mem}`] : []), ...(cpu ? ["-p", `CPUQuota=${cpu}`] : []), "--", bin, ...args] };
}

/** #4211: a judgment call over data in the prompt only (the refactor:split grouping call): no tool can read a file. */
export const noToolFlags = (caps) => (caps?.strictMcp ? ["--tools", ""]
  : ["--disallowedTools", "Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task"]);

export function makeLeanRunner({ runCli = runCliBackendAsync, probe = systemdRunAvailable } = {}) {
  return async ({ role, issue, cwd, model, resume, system, prompt, readOnly = false, noTools = false, env = null, idleMs = 0, maxMs = 0, laneLimits = null, control = null, onSpawn = null }) => {
    const bin = resolveClaudeCliBinary(cwd) || "claude";
    const caps = getClaudeCliCapabilities(cwd);
    const flags = [...buildLeanSessionFlags(caps), ...(noTools ? noToolFlags(caps) : readOnly ? buildReadOnlyToolFlags(caps) : [])];
    const r = await runCli({ spec: { name: `core-${role}` }, userMessage: prompt, systemPrompt: resume ? "" : system,
      args: [String(issue)], cwd, bin, model, env, sessionFlags: flags, extraArgs: resume ? ["--resume", resume] : [],
      logger: { log() {} },
      idleMs, maxMs, stream: idleMs > 0, control, onSpawn, wrap: laneLimits && probe() ? (b, a) => wrapLaneLimits(b, a, laneLimits) : null });
    return { text: r.text, sessionId: r.sessionId, usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs, turns: r.turns, model: r.cliModel ?? "default" };
  };
}

/** Parent pid from /proc/<pid>/stat (the field after the parenthesised command name); 0 when unreadable. */
const ppidOf = (root, pid) => { try { const st = readFileSync(join(root, String(pid), "stat"), "utf8"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]) || 0; } catch { return 0; } };
/**
 * #4162: processes whose cwd is `dir` or inside it, from /proc (Linux). Excludes this process and its ancestors.
 * Returns [{pid, cmd}]; [] where /proc is unavailable (the caller then skips stopping them).
 */
export function procsInDir(dir, { procRoot = "/proc", self = process.pid } = {}) {
  if (!dir || !existsSync(procRoot)) return [];
  try { dir = realpathSync(dir); } catch { /* not on disk: compare as given */ } // /proc cwd links are resolved paths
  const skip = new Set();
  for (let p = self, i = 0; p > 1 && i < 64 && !skip.has(p); i++) { skip.add(p); p = ppidOf(procRoot, p); }
  const out = [];
  for (const e of readdirSync(procRoot)) {
    if (!/^\d+$/.test(e) || skip.has(Number(e))) continue;
    let at; try { at = readlinkSync(join(procRoot, e, "cwd")); } catch { continue; }
    if (at !== dir && !at.startsWith(`${dir}/`)) continue;
    let cmd = ""; try { cmd = readFileSync(join(procRoot, e, "cmdline"), "utf8").split("\0").filter(Boolean).join(" ").slice(0, 200); } catch { /* exited */ }
    out.push({ pid: Number(e), cmd });
  }
  return out;
}

export const RUN_TMP_MAX_AGE_MS = 6 * 3600 * 1000;
/** Timeout of the Checks API POST that reports the forgedock/verify check run (#4270). */
export const CHECK_RUN_TIMEOUT_MS = 60000;
export const runTmpRoot = () => join(homedir(), ".forge", "tmp", "runs");
const OWNER = ".forge-run-owner";
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } };

/** Per-run scratch dirs under ~/.forge/tmp/runs/<issue>-<run>/. Only dirs carrying our owner marker are ever removed. */
export function makeRunTmp({ root = runTmpRoot(), now = () => Date.now(), alive = pidAlive, host = hostname() } = {}) {
  const inside = (d) => { const r = resolve(d); return r.startsWith(resolve(root) + sep) && !r.slice(resolve(root).length + 1).includes(sep); };
  return {
    /** The dir make(issue, runId) creates, so a ledger can register it first (#4179). */
    path: (runId) => join(root, String(runId)),
    async make(issue, runId) {
      const dir = join(root, String(runId));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, OWNER), JSON.stringify({ issue, pid: process.pid, host, created: now() }));
      return dir;
    },
    /** Remove a dir this module created (marker present, direct child of the runs root). */
    async remove(dir) {
      if (!dir || !inside(dir) || !existsSync(join(dir, OWNER))) return false;
      rmSync(dir, { recursive: true, force: true });
      return true;
    },
    /** Best-effort: dirs older than 6h whose owner pid is dead on this host. Never touches dirs without our marker. */
    async prune({ maxAgeMs = RUN_TMP_MAX_AGE_MS } = {}) {
      const removed = [];
      let names = [];
      try { names = readdirSync(root); } catch { return removed; }
      for (const n of names) {
        const dir = join(root, n);
        try {
          if (!lstatSync(dir).isDirectory()) continue;
          const own = JSON.parse(readFileSync(join(dir, OWNER), "utf8"));
          if (now() - Number(own.created) < maxAgeMs) continue;
          if (own.host === host && Number.isSafeInteger(own.pid) && alive(own.pid)) continue;
          if (own.host !== host) continue;
          rmSync(dir, { recursive: true, force: true });
          removed.push(n);
        } catch { /* not ours or unreadable: leave it */ }
      }
      return removed;
    },
  };
}

/**
 * SIGTERM to a ledger-registered pid's process group (#4179). Only when the pid is alive and, where /proc exists, its
 * command line still names `marker`, so a reused pid is never signalled. Returns true when the pid is gone or signalled.
 */
export function killLedgerPid(pid, marker, { kill = process.kill.bind(process), procDir = "/proc" } = {}) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 1) return false;
  if (!pidAlive(n)) return true;
  if (marker && existsSync(procDir)) {
    let cmd = "";
    try { cmd = readFileSync(join(procDir, String(n), "cmdline"), "utf8"); } catch { return true; } // exited meanwhile
    if (!cmd.includes(String(marker))) return true; // pid reused by something else: not ours any more
  }
  try { kill(-n, "SIGTERM"); return true; } catch { try { kill(n, "SIGTERM"); return true; } catch (e) { return e?.code === "ESRCH"; } }
}

/** Real host probes for admission (#4105). MemAvailable from /proc/meminfo (fallback os.freemem), statfs for tmp. */
export function makeHostProbe() {
  return {
    memAvailableMb() {
      try {
        const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
        if (m) return Math.floor(Number(m[1]) / 1024);
      } catch { /* not Linux */ }
      return Math.floor(freemem() / 1048576);
    },
    async freeMb(p) {
      let dir = p;
      while (dir && !existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      const s = await fsp.statfs(dir);
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1048576);
    },
    loadAvg1: () => loadavg()[0],
    cores: () => cpus().length || 1,
    /** Live lanes on this host from the ledger (#4182), this lane included once it registered. */
    activeLanes: () => countLiveLanes({ root: ledgerRoot(), host: hostname() }),
    tmpPaths: () => [...new Set([join(homedir(), ".forge", "tmp"), tmpdir(), "/tmp"].filter((x) => existsSync(x) || x === join(homedir(), ".forge", "tmp")))],
  };
}

/**
 * Required status checks for `lane` (#4158): the union of classic branch protection (contexts + checks) and the
 * repository rulesets that apply to the branch (`rules/branches/{lane}`, type required_status_checks). Each source
 * fails independently to [] (404, no protection, no rulesets, bad JSON), so one never hides the other.
 */
export async function requiredChecksFor({ gh, repo, lane }) {
  const classic = async () => {
    const j = JSON.parse(String(await gh(["api", `repos/${repo}/branches/${lane}/protection/required_status_checks`])));
    return [...(j.contexts ?? []), ...(j.checks ?? []).map((c) => c?.context)];
  };
  const rulesets = async () => {
    // --jq emits one context per line across all pages, so pagination needs no JSON stitching.
    const out = String(await gh(["api", "--paginate", `repos/${repo}/rules/branches/${lane}`,
      "--jq", '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]?.context']));
    return out.split("\n").map((x) => x.trim());
  };
  const safe = async (f) => { try { const v = await f(); return Array.isArray(v) ? v : []; } catch { return []; } };
  const all = [...(await safe(classic)), ...(await safe(rulesets))];
  return [...new Set(all.filter((x) => typeof x === "string" && x))];
}

/** Combined stdout+stderr kept per declared check command (tail). */
const CHECK_OUTPUT_CAP = 64000;
/** #4240: run a forge.yaml declared check command locally (no gh, no Actions); {rc, output}, rc 124 on timeout. */
export function runCheckCommand({ command, cwd, timeoutMs = 300000 }) {
  return new Promise((done) => {
    let out = "", timedOut = false, child;
    const add = (b) => { out += String(b); if (out.length > 2 * CHECK_OUTPUT_CAP) out = out.slice(-CHECK_OUTPUT_CAP); };
    try { child = spawn("bash", ["-c", String(command)], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { done({ rc: 127, output: String(e?.message ?? e) }); return; }
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on("data", add); child.stderr.on("data", add);
    child.on("error", (e) => { clearTimeout(timer); done({ rc: 127, output: `${out}${String(e?.message ?? e)}`.slice(-CHECK_OUTPUT_CAP) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = out.slice(-CHECK_OUTPUT_CAP);
      done(timedOut ? { rc: 124, output: `${tail}\n(timed out after ${Math.round(timeoutMs / 1000)}s)` } : { rc: Number.isInteger(code) ? code : 1, output: tail });
    });
  });
}

export function makeLeanIo({ repo }) {
  const base = makeIo();
  const run = (bin) => async (args, opts = {}) => (await pexec(bin, args, { cwd: opts.cwd, maxBuffer: 100 * 1024 * 1024, timeout: 120000 })).stdout;
  return {
    gh: run("gh"), git: run("git"), docker: run("docker"), killGroup: async (pid, marker) => killLedgerPid(pid, marker), ledger: (opts) => makeLedger(opts), runTmp: makeRunTmp(), host: makeHostProbe(), heavy: makeHeavyIo({ host: makeHostProbe() }), projector: makeProjector({ gh: base.gh }), runner: makeLeanRunner(), waitCiGreen: base.waitCiGreen,
    /** Shared dependency cache (#4220): the repo's own package manager, argv only, bounded by the cache's timeout. */
    deps: makeDepCache({ exec: async (cmd, args, { cwd, env, timeoutMs } = {}) => String((await pexec(cmd, args, { cwd, env: { ...process.env, ...(env ?? {}) }, timeout: timeoutMs ?? 0, maxBuffer: 100 * 1024 * 1024 })).stdout) }),
    /** Names of the checks the base branch requires: classic protection plus rulesets (#4158). [] when neither has any. */
    async requiredChecks(lane) { return requiredChecksFor({ gh: run("gh"), repo, lane }); },
    /** [{name, state: success|failure|pending, url, head}] for the PR's checks; `head` is the PR head the rollup belongs to (#4240). */
    async checkStates(pr) {
      const j = JSON.parse(await run("gh")(["pr", "view", String(pr), "-R", repo, "--json", "statusCheckRollup,headRefOid"]));
      return (j.statusCheckRollup ?? []).map((c) => {
        const v = String(c.conclusion || c.state || "").toUpperCase();
        const state = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v) ? "success" : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v) ? "failure" : "pending";
        return { name: c.name ?? c.context, state, url: c.detailsUrl || c.targetUrl || null, head: j.headRefOid ?? null };
      });
    },
    /** #4240: one declared check command (`bash -c`) in `cwd`; never throws. A timeout kills the process group and gives rc 124. */
    runCommand: runCheckCommand,
    /** #4167 verify-by-CI: `gh workflow run` on the lane branch; inputs become -f key=value. */
    async dispatchWorkflow({ workflow, ref, inputs = {} }) {
      await run("gh")(["workflow", "run", String(workflow), "-R", repo, "--ref", String(ref), ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
    },
    /** Recent workflow_dispatch runs of `workflow` on `branch`, newest first: [{databaseId, headSha, status, conclusion, url, name}]. */
    async workflowRuns({ workflow, branch }) {
      return JSON.parse(await run("gh")(["run", "list", "-R", repo, "--workflow", String(workflow), "--branch", String(branch), "--event", "workflow_dispatch",
        "--limit", "10", "--json", "databaseId,headSha,status,conclusion,url,name"]) || "[]");
    },
    /** Check runs on a commit (push-triggered CI): [{name, state: success|failure|pending, url}], same mapping as checkStates. */
    async commitChecks(sha) {
      const out = String(await run("gh")(["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs`, "--jq", ".check_runs[] | {name, status, conclusion, url: .html_url} | @json"]));
      return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).map((c) => {
        const v = String(c.status === "completed" ? c.conclusion ?? "" : "").toUpperCase();
        const state = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v) ? "success" : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(v) ? "failure" : "pending";
        return { name: c.name, state, url: c.url ?? null };
      });
    },
    /**
     * #4270 verify.check_run: one completed check run on `sha` (`gh api -X POST repos/<repo>/check-runs`, JSON on stdin).
     * Needs a token allowed to create check runs (GitHub App, checks:write). Resolves {id, html_url}; throws on failure.
     */
    async createCheckRun({ sha, name, conclusion, title, summary, text }) {
      const body = JSON.stringify({ name, head_sha: sha, status: "completed", conclusion, output: { title, summary, text } });
      const out = await runWithInput("gh", ["api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-"], body, CHECK_RUN_TIMEOUT_MS);
      const j = JSON.parse(out || "{}");
      return { id: j.id ?? null, html_url: j.html_url ?? null };
    },
    /** Failed-job logs of an Actions run (`gh run view --log-failed`), tail-capped; "" when unreadable. */
    async failedLogs(runId) {
      try { const out = String(await run("gh")(["run", "view", String(runId), "-R", repo, "--log-failed"])); return out.length > 64000 ? out.slice(-64000) : out; } catch { return ""; }
    },
    async transitionLabel(issue, state) { await pexec("bash", [script("transition-label.sh"), String(issue), "-R", repo, state], { timeout: 60000 }); },
    /**
     * File (or append to) the parent's ONE batched follow-up issue (scripts/file-deferred-followups.sh: trusted lookup,
     * append, create, claim marker, duplicate re-check). items: [{key, why}]. Returns {key: issueNumber}; throws on exit 3/4.
     */
    async fileFollowups({ parent, items }) {
      const tsv = items.map((i) => `${i.key}\t${i.why}\t`).join("\n") + "\n";
      const out = await runWithInput("bash", [script("file-deferred-followups.sh"), "--parent", String(parent), "--repo", repo], tsv, 180000);
      const map = {};
      for (const l of out.split("\n")) { const [k, n] = l.split("\t"); if (k && /^\d+$/.test(String(n ?? "").trim())) map[k] = Number(n); }
      return map;
    },
    /**
     * forge#4163: forge.yaml env.setup, once per fresh lane worktree: `bash -c <command>` in cwd with the lane env.
     * Resolves {exit, stdout, stderr} (output tails); a non-zero exit, timeout or spawn error never throws.
     */
    runSetup({ cwd, command, env = null, timeoutMs = 15 * 60000 }) {
      return new Promise((res) => {
        execFile("bash", ["-c", command], { cwd, env: { ...process.env, ...(env ?? {}) }, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          const tail = (x) => String(x ?? "").slice(-2000);
          if (!err) return res({ exit: 0, stdout: tail(stdout), stderr: tail(stderr) });
          const exit = Number.isInteger(err.code) ? err.code : 1;
          const why = err.killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : typeof err.code === "string" ? err.code : "";
          res({ exit: exit === 0 ? 1 : exit, stdout: tail(stdout), stderr: tail([stderr, why].filter(Boolean).join("\n")) });
        });
      });
    },
    /** forge#4159: scripts/structure-delta.sh over base...HEAD in cwd; null on any failure (never fails a run). */
    async structureDelta({ cwd, base }) {
      try { return JSON.parse((await pexec("bash", [script("structure-delta.sh"), `${base}...HEAD`], { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout); } catch { return null; }
    },
    /** forge#4275: the context pack's facts for one issue (bin/lean/context.mjs), from gh and git only; sources fail independently. */
    contextFacts: (args) => gatherContextFacts({ ...args, io: { gh: run("gh"), git: run("git"), exists: async (p) => existsSync(p) } }),
    /** forge#4195: scripts/hotspots.sh facts for `paths` in cwd (growth since base when given); null on any failure. */
    async hotspots({ cwd, base = null, paths = [] }) {
      const args = [script("hotspots.sh"), ...(base ? ["--base", base] : []), "--", ...paths];
      try { return JSON.parse((await pexec("bash", args, { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout); } catch { return null; }
    },
    /** #4322: tests enumerating the members of the given paths, and new members those tests miss (bin/lean/enumerating.mjs); [] on failure. */
    enumeratingTests: ({ cwd, paths = [] }) => enumeratingTests({ git: (a) => run("git")(a, { cwd }), cwd, paths }),
    enumeratingMissing: ({ cwd, base }) => missingEntries({ git: (a) => run("git")(a, { cwd }), cwd, base }),
    /** #4322: sequence-numbered files the lane shares with the base (bin/lean/sequence.mjs); snapshot before, verify after a renumber. */
    sequenceCheck: ({ cwd, base }) => sequenceCollisions({ git: (a) => run("git")(a, { cwd }), base }),
    sequenceSnapshot: ({ cwd, base }) => snapshotLane({ git: (a) => run("git")(a, { cwd }), base }),
    sequenceVerify: ({ cwd, base, before }) => verifyRenumber({ git: (a) => run("git")(a, { cwd }), base, before }),
    /** #4271: scripts/acceptance-red-green.sh for the frozen repro_test in cwd; {base, head} words, or null on any failure. */
    async redGreen({ cwd, base, command, timeoutSec = 300 }) {
      const args = [script("acceptance-red-green.sh"), "--repo-path", cwd, "--base-ref", base, "--test-cmd", command, "--timeout", String(timeoutSec)];
      try {
        const m = /BASE=(\w+) HEAD=(\w+)/.exec(String((await pexec("bash", args, { cwd, timeout: (timeoutSec * 2 + 60) * 1000, maxBuffer: 4 * 1024 * 1024 })).stdout ?? ""));
        return m ? { base: m[1], head: m[2] } : null;
      } catch { return null; }
    },
    /**
     * The target repo's own docs-move-with-code rule, when it has one (scripts/check-devdocs-freshness.sh, forge#4185),
     * over base...HEAD in cwd. null when the repo has no such script or it cannot run (exit 2+, timeout): never blocks.
     * Otherwise {ok, output} with the script's stdout+stderr (exit 0 = ok, exit 1 = stale docs).
     */
    async docsFreshness({ cwd, base }) {
      const s = join(cwd, "scripts", "check-devdocs-freshness.sh");
      if (!existsSync(s)) return null;
      try {
        const r = await pexec("bash", [s, base], { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PR_BODY: "" } });
        return { ok: true, output: String(r.stdout ?? "") };
      } catch (e) {
        if (e?.code !== 1) return null;
        return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 6000) };
      }
    },
    /** #4162: processes left running inside a lane worktree (Linux /proc). */
    proc: { inDir: async (dir) => procsInDir(dir), alive: pidAlive, kill: (pid, sig) => { try { process.kill(pid, sig); } catch { /* already gone */ } } },
    fs: {
      read: async (p) => readFileSync(p, "utf8"),
      exists: async (p) => existsSync(p),
      rmdir: async (p) => rmSync(p, { recursive: true, force: true }),
      stat: async (p) => { try { return { mtimeMs: statSync(p).mtimeMs }; } catch { return null; } },
      append: async (p, t) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, t); },
      write: async (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); },
      rename: async (from, to) => renameSync(from, to),
      list: async (d) => { try { return readdirSync(d); } catch { return []; } },
      rm: async (p) => rmSync(p, { force: true }),
    },
  };
}
