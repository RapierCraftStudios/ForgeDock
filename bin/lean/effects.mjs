// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Core work-on: the real effects behind runCore's injected `io`. Argv only, no shell. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, appendFileSync, mkdirSync, statSync, existsSync, rmSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCliBackendAsync, resolveClaudeCliBinary, getClaudeCliCapabilities, buildLeanSessionFlags, buildReadOnlyToolFlags } from "../runner.mjs";
import { makeIo } from "../engine-cli.mjs";
import { makeProjector } from "../engine/projector.mjs";

const pexec = promisify(execFile);
const script = (n) => fileURLToPath(new URL(`../../scripts/${n}`, import.meta.url));

/** Claude CLI session runner: fresh session, or `--resume <id>` for the builder. Resolves usage + session_id. */
export function makeLeanRunner({ runCli = runCliBackendAsync } = {}) {
  return async ({ role, issue, cwd, model, resume, system, prompt, readOnly = false, env = null }) => {
    const bin = resolveClaudeCliBinary(cwd) || "claude";
    const caps = getClaudeCliCapabilities(cwd);
    const flags = [...buildLeanSessionFlags(caps), ...(readOnly ? buildReadOnlyToolFlags(caps) : [])];
    const r = await runCli({ spec: { name: `core-${role}` }, userMessage: prompt, systemPrompt: resume ? "" : system,
      args: [String(issue)], cwd, bin, model, env, sessionFlags: flags, extraArgs: resume ? ["--resume", resume] : [],
      logger: { log() {} } });
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

export function makeLeanIo({ repo }) {
  const base = makeIo();
  const run = (bin) => async (args, opts = {}) => (await pexec(bin, args, { cwd: opts.cwd, maxBuffer: 100 * 1024 * 1024, timeout: 120000 })).stdout;
  return {
    gh: run("gh"), git: run("git"), runTmp: makeRunTmp(), projector: makeProjector({ gh: base.gh }), runner: makeLeanRunner(), waitCiGreen: base.waitCiGreen,
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
    fs: {
      read: async (p) => readFileSync(p, "utf8"),
      exists: async (p) => existsSync(p),
      rmdir: async (p) => rmSync(p, { recursive: true, force: true }),
      stat: async (p) => { try { return { mtimeMs: statSync(p).mtimeMs }; } catch { return null; } },
      append: async (p, t) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, t); },
    },
  };
}
