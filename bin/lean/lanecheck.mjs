// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4866: lane preflight. Host and environment faults (no pool token, a stale pool agent, a PATH wrapper that loops back
 * to the heavy shim, a gh without a --json field the engine reads) used to surface inside lanes as 401s, fork loops or
 * untyped engine-errors. Each check here returns `{code, ok, detail, scope}`; `scope` is "remote" (only remote lanes are held)
 * or "all". The orchestrator holds admission while any check fails and re-checks each pass (never the breaker); `forgedock
 * doctor --lanes` prints every check. Pure: all I/O is injected (`io`), so a fixed cause clears on the next call.
 */
import { readFileSync } from "node:fs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { findShimLoops } from "./heavy.mjs";

/** The running CLI's package version. */
export const cliVersion = () => JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const UPGRADE_COMMAND = "npx forgedock pool upgrade";
/** The `gh <cmd> --json` fields the engine reads (keep next to the call sites' lists in engine-cli.mjs and lean/*.mjs). */
export const GH_FIELDS = Object.freeze({
  "issue view": ["number", "title", "body", "state", "stateReason", "labels", "comments", "milestone", "author", "createdAt", "updatedAt"],
  "pr view": ["number", "state", "mergeable", "mergeStateStatus"],
  "repo view": ["nameWithOwner", "defaultBranchRef"],
});
const pass = (code, detail, scope) => ({ code, ok: true, detail, scope });
const fail = (code, detail, scope) => ({ code, ok: false, detail, scope });
const C = OUTCOME_CODES;

/** A remote or hybrid execution is configured (the only case the pool checks apply to). */
export const usesPool = (exec) => Boolean(exec) && (exec.mode === "remote" || exec.mode === "hybrid") && ["pool", "remote"].includes(exec.provider ?? "pool");

/** The pool token resolves (env/keychain `token_env`, else the router's `forgedock_token_file`) and the router does not answer 401/403 to an authenticated ping. */
export async function checkPoolAuth({ exec, router = null, credential = () => null, ping = null }) {
  const code = C.PREFLIGHT_POOL_AUTH;
  if (!usesPool(exec)) return pass(code, "skipped: no remote or hybrid execution", "remote");
  const name = exec.tokenEnv ?? "COMPUTESHARE_TOKEN";
  const fromEnv = credential(name);
  const token = fromEnv || router?.token || null;
  if (!token) return fail(code, `pool token does not resolve: tried env/keychain ${name}, ${router ? "the router's forgedock_token_file" : "no router config (COMPUTESHARE_CONFIG / ~/.config/computeshare/router.json)"}`, "remote");
  const endpoint = exec.endpoint ?? router?.endpoint ?? null;
  if (!endpoint || typeof ping !== "function") return pass(code, `token resolved from ${fromEnv ? name : "forgedock_token_file"}`, "remote");
  let r = null;
  try { r = await ping(endpoint, token); } catch { r = null; }
  if ([401, 403].includes(r?.status)) return fail(code, `router ${endpoint} answered HTTP ${r.status} to the token from ${fromEnv ? name : "forgedock_token_file"}`, "remote");
  return pass(code, `token resolved from ${fromEnv ? name : "forgedock_token_file"}${r ? "" : "; router unreachable (not an auth failure)"}`, "remote");
}

/** Every online pool agent runs the CLI's version. `agents` is the router's `GET /agents` list (each spreads versionOf: version, image). */
export function checkPoolVersion({ exec, agents = null, cliVersion }) {
  const code = C.PREFLIGHT_POOL_VERSION;
  if (!usesPool(exec)) return pass(code, "skipped: no remote or hybrid execution", "remote");
  if (!Array.isArray(agents)) return pass(code, "skipped: pool agents not readable", "remote");
  const bad = agents.filter((a) => a?.ok !== false && typeof a?.version === "string" && a.version !== cliVersion);
  if (!bad.length) return pass(code, `${agents.length} agent(s) at ${cliVersion}`, "remote");
  return fail(code, bad.map((a) => `agent ${a.name ?? "?"} runs image version ${a.version}, CLI is ${cliVersion}`).join("; ") + `; upgrade: ${UPGRADE_COMMAND}`, "remote");
}

/** No PATH wrapper dir resolves a heavy-shimmed tool back to the shim. */
export function checkPathLoop({ env = {}, loops = findShimLoops }) {
  const code = C.PREFLIGHT_PATH_LOOP;
  const skip = env.FORGE_HEAVY_SHIM_DIR ? [env.FORGE_HEAVY_SHIM_DIR] : [];
  const found = loops(env.PATH ?? "", { skip });
  if (!found.length) return pass(code, "no PATH wrapper loops back to the heavy shim", "all");
  return fail(code, found.map((l) => `${l.dir} wraps ${l.name} and resolves back to the heavy shim`).join("; "), "all");
}

/** Parse the field names `gh <cmd> --json bogus` lists as available (null when the output has no list). */
export function availableFields(text) {
  const m = /Available fields:\s*([\s\S]*)$/i.exec(String(text ?? ""));
  if (!m) return null;
  const f = m[1].split(/\s+/).map((x) => x.trim()).filter((x) => /^[A-Za-z]\w*$/.test(x));
  return f.length ? f : null;
}

/** The installed gh offers every `--json` field the engine uses; `exec(args) -> {stdout, stderr}`. An unreadable gh passes (not this check's fault). */
export async function checkGhFields({ exec, fields = GH_FIELDS }) {
  const code = C.PREFLIGHT_GH_FIELDS;
  let version = "unknown";
  try { version = /gh version (\S+)/.exec(String((await exec(["--version"]))?.stdout ?? ""))?.[1] ?? "unknown"; } catch { return pass(code, "skipped: gh not runnable", "all"); }
  const missing = [];
  for (const [cmd, want] of Object.entries(fields)) {
    let r;
    try { r = await exec([...cmd.split(" "), "--json", "forgedock_probe"]); } catch { continue; }
    const have = availableFields(`${r?.stderr ?? ""}\n${r?.stdout ?? ""}`);
    if (!have) continue;
    for (const f of want) if (!have.includes(f)) missing.push(`${f} (gh ${cmd} --json)`);
  }
  return missing.length ? fail(code, `gh ${version} lacks --json field ${missing.join(", ")}`, "all") : pass(code, `gh ${version} has every --json field the engine uses`, "all");
}

/** Run every check; never throws (a check that throws passes with the error as its detail). */
export async function runLaneChecks({ exec = null, env = process.env, cliVersion: cliV = cliVersion(), io = {} } = {}) {
  const safe = async (code, scope, fn) => { try { return await fn(); } catch (e) { return pass(code, `check errored: ${String(e?.message ?? e).split("\n")[0]}`, scope); } };
  let router = null;
  try { router = io.router?.() ?? null; } catch { router = null; }
  const ping = io.ping ?? null;
  const agentsOf = async () => { try { return (await io.agents?.(exec?.endpoint ?? router?.endpoint, exec?.tokenEnv ? (io.credential?.(exec.tokenEnv) ?? router?.token) : router?.token)) ?? null; } catch { return null; } };
  return [
    await safe(C.PREFLIGHT_POOL_AUTH, "remote", () => checkPoolAuth({ exec, router, credential: io.credential, ping })),
    await safe(C.PREFLIGHT_POOL_VERSION, "remote", async () => checkPoolVersion({ exec, agents: usesPool(exec) ? await agentsOf() : null, cliVersion: cliV })),
    await safe(C.PREFLIGHT_PATH_LOOP, "all", () => checkPathLoop({ env: { ...env, PATH: env.PATH ?? "" }, ...(io.loops ? { loops: io.loops } : {}) })),
    await safe(C.PREFLIGHT_GH_FIELDS, "all", () => (io.ghExec ? checkGhFields({ exec: io.ghExec }) : pass(C.PREFLIGHT_GH_FIELDS, "skipped: no gh", "all"))),
  ];
}

/** One line per check: `PASS|FAIL code  detail`. */
export const formatLaneChecks = (checks) => checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.code}  ${c.detail}`).join("\n");

/** Real-host io for the daemon, the batch and `doctor --lanes`. gh output is cached per process (it cannot change under a running engine). */
export async function hostLaneIo({ env = process.env } = {}) {
  const { poolRouterConfig } = await import("./execution.mjs");
  const { resolveCredential } = await import("./credentials.mjs");
  const { execFile } = await import("node:child_process");
  const call = (url, token, timeoutMs = 5000) => fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  const run = (args) => new Promise((res, rej) => execFile("gh", args, { timeout: 15000, env }, (e, stdout, stderr) => (e && e.code === "ENOENT" ? rej(e) : res({ stdout, stderr }))));
  const memo = new Map();
  return {
    router: () => poolRouterConfig({ env }),
    credential: (n) => resolveCredential(n, { env }),
    ping: async (endpoint, token) => ({ status: (await call(`${endpoint}/status`, token)).status }),
    agents: async (endpoint, token) => { const r = await call(`${endpoint}/agents`, token); return r.ok ? (await r.json())?.agents ?? null : null; },
    ghExec: (args) => { const k = args.join(" "); if (!memo.has(k)) memo.set(k, run(args)); return memo.get(k); },
  };
}
