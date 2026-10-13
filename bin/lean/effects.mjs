// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Lean path (#4081): the real effects behind runLean's injected `io`. Argv only, no shell. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCliBackend, resolveClaudeCliBinary, getClaudeCliCapabilities, buildLeanSessionFlags, buildReadOnlyToolFlags } from "../runner.mjs";
import { makeIo } from "../engine-cli.mjs";
import { makeProjector } from "../engine/projector.mjs";

const pexec = promisify(execFile);
const script = (n) => fileURLToPath(new URL(`../../scripts/${n}`, import.meta.url));

/** Claude CLI session runner: fresh session, or `--resume <id>` for the warm builder. Resolves usage + session_id. */
export function makeLeanRunner({ runCli = runCliBackend } = {}) {
  return async ({ role, issue, cwd, model, resume, system, prompt, readOnly = false }) => {
    const bin = resolveClaudeCliBinary(cwd) || "claude";
    const caps = getClaudeCliCapabilities(cwd);
    const flags = [...buildLeanSessionFlags(caps), ...(readOnly ? buildReadOnlyToolFlags(caps) : [])];
    const r = runCli({ spec: { name: `lean-${role}` }, userMessage: prompt, systemPrompt: resume ? "" : system,
      args: [String(issue)], cwd, bin, model, sessionFlags: flags, extraArgs: resume ? ["--resume", resume] : [],
      logger: { log() {} } });
    return { text: r.text, sessionId: r.sessionId, usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs, turns: r.turns, model: r.cliModel ?? "default" };
  };
}

/** A missing or unparseable CI_LOCAL_RESULT means the gate itself is broken (BROKEN); only an explicit DEGRADED passes. */
export function parseCiLocalResult(out) {
  return /CI_LOCAL_RESULT:\s*(PASS|FAIL|DEGRADED)\b/.exec(String(out))?.[1] ?? "BROKEN";
}

export function makeLeanIo({ repo }) {
  const base = makeIo();
  const run = (bin) => async (args, opts = {}) => (await pexec(bin, args, { cwd: opts.cwd, maxBuffer: 100 * 1024 * 1024, timeout: 120000 })).stdout;
  return {
    gh: run("gh"), git: run("git"), projector: makeProjector({ gh: base.gh }), runner: makeLeanRunner(), waitCiGreen: base.waitCiGreen,
    async ciLocal({ cwd, base: baseRef }) {
      let out = "";
      try { out = (await pexec("bash", [script("ci-local.sh"), "run", "--repo", cwd, "--base", baseRef], { maxBuffer: 50 * 1024 * 1024, timeout: 3600000 })).stdout; }
      catch (e) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
      return { result: parseCiLocalResult(out), tail: out.split("\n").slice(-60).join("\n") };
    },
    async transitionLabel(issue, state) { await pexec("bash", [script("transition-label.sh"), String(issue), "-R", repo, state], { timeout: 60000 }); },
    fs: {
      read: async (p) => readFileSync(p, "utf8"),
      append: async (p, t) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, t); },
    },
  };
}
