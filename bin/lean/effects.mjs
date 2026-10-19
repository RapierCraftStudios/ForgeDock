// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Core work-on: the real effects behind runCore's injected `io`. Argv only, no shell. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, appendFileSync, mkdirSync, statSync, existsSync, rmSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { homedir, hostname, freemem, loadavg, cpus, tmpdir } from "node:os";
import { promises as fsp } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCliBackendAsync, resolveClaudeCliBinary, getClaudeCliCapabilities, buildLeanSessionFlags, buildReadOnlyToolFlags } from "../runner.mjs";
import { makeIo } from "../engine-cli.mjs";
import { makeProjector } from "../engine/projector.mjs";
import { makeLedger } from "./ledger.mjs";

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

export function makeLeanRunner({ runCli = runCliBackendAsync, probe = systemdRunAvailable } = {}) {
  return async ({ role, issue, cwd, model, resume, system, prompt, readOnly = false, env = null, idleMs = 0, maxMs = 0, laneLimits = null, control = null, onSpawn = null }) => {
    const bin = resolveClaudeCliBinary(cwd) || "claude";
    const caps = getClaudeCliCapabilities(cwd);
    const flags = [...buildLeanSessionFlags(caps), ...(readOnly ? buildReadOnlyToolFlags(caps) : [])];
    const r = await runCli({ spec: { name: `core-${role}` }, userMessage: prompt, systemPrompt: resume ? "" : system,
      args: [String(issue)], cwd, bin, model, env, sessionFlags: flags, extraArgs: resume ? ["--resume", resume] : [],
      logger: { log() {} },
      idleMs, maxMs, stream: idleMs > 0, control, onSpawn, wrap: laneLimits && probe() ? (b, a) => wrapLaneLimits(b, a, laneLimits) : null });
    return { text: r.text, sessionId: r.sessionId, usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs, turns: r.turns, model: r.cliModel ?? "default" };
  };
}

export const RUN_TMP_MAX_AGE_MS = 6 * 3600 * 1000;
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
    tmpPaths: () => [...new Set([join(homedir(), ".forge", "tmp"), tmpdir(), "/tmp"].filter((x) => existsSync(x) || x === join(homedir(), ".forge", "tmp")))],
  };
}

export function makeLeanIo({ repo }) {
  const base = makeIo();
  const run = (bin) => async (args, opts = {}) => (await pexec(bin, args, { cwd: opts.cwd, maxBuffer: 100 * 1024 * 1024, timeout: 120000 })).stdout;
  return {
    gh: run("gh"), git: run("git"), docker: run("docker"), killGroup: async (pid, marker) => killLedgerPid(pid, marker), ledger: (opts) => makeLedger(opts), runTmp: makeRunTmp(), host: makeHostProbe(), projector: makeProjector({ gh: base.gh }), runner: makeLeanRunner(), waitCiGreen: base.waitCiGreen,
    /** Names of the checks the base branch requires (contexts + checks). [] on 404 / no protection. */
    async requiredChecks(lane) {
      try {
        const j = JSON.parse(await run("gh")(["api", `repos/${repo}/branches/${lane}/protection/required_status_checks`]));
        return [...new Set([...(j.contexts ?? []), ...(j.checks ?? []).map((c) => c.context)].filter(Boolean))];
      } catch { return []; }
    },
    /** [{name, state: success|failure|pending}] for the PR's checks. */
    async checkStates(pr) {
      const j = JSON.parse(await run("gh")(["pr", "view", String(pr), "-R", repo, "--json", "statusCheckRollup"]));
      return (j.statusCheckRollup ?? []).map((c) => {
        const v = String(c.conclusion || c.state || "").toUpperCase();
        const state = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v) ? "success" : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v) ? "failure" : "pending";
        return { name: c.name ?? c.context, state };
      });
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
    fs: {
      read: async (p) => readFileSync(p, "utf8"),
      exists: async (p) => existsSync(p),
      rmdir: async (p) => rmSync(p, { recursive: true, force: true }),
      stat: async (p) => { try { return { mtimeMs: statSync(p).mtimeMs }; } catch { return null; } },
      append: async (p, t) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, t); },
      write: async (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); },
    },
  };
}
