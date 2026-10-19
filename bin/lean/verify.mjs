// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Verify-by-CI (#4167): run the lane's heavy verification on CI runners instead of the host. The engine pushes the
 * branch, dispatches the configured workflow (or waits on the head commit's push-triggered checks), and returns the
 * failed jobs' log tails for the builder's fix loop. All GitHub effects go through the injected io.
 */
import { ciPollDelayMs } from "../engine.mjs";

export const VERIFY_MODES = Object.freeze(["local", "ci", "hybrid"]);
/** Changed files that never need the CI matrix (docs-only lanes skip CI verification). */
export const DEFAULT_SKIP_PATHS = Object.freeze(["*.md", "*.mdx", "*.rst", "*.txt", "docs/**", "devdocs/**"]);
export const DEFAULT_MAX_ROUNDS = 2;
/** Per-command timeout of the pre-PR declared check commands (#4240, `verify.precheck_timeout_seconds`). */
export const DEFAULT_PRECHECK_TIMEOUT_SECONDS = 300;
/** Total characters of failed-job log handed to the builder. */
export const LOG_CAP = 12000;
/** No run or check for the head after this long means CI is unavailable (local fallback). */
export const DEFAULT_GRACE_MS = 5 * 60000;
const LEAN_PREFIX = ".forge-lean/";
const OK = ["success", "neutral", "skipped"];

/**
 * forge.yaml `verify:` section (block style; parseForgeYaml gives strings) → {mode, workflow, pathsInput, skipPaths,
 * maxRounds, precheckTimeoutSeconds}. Invalid values fall back to the defaults; mode defaults to local (today's behaviour).
 */
export function parseVerify(sec = {}) {
  const s = sec && typeof sec === "object" ? sec : {};
  const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
  const mode = VERIFY_MODES.includes(str(s.mode)) ? str(s.mode) : "local";
  const workflow = /^[A-Za-z0-9._/-]+$/.test(str(s.workflow)) ? str(s.workflow) : null;
  const pathsInput = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(str(s.paths_input)) ? str(s.paths_input) : null;
  const rawSkip = Array.isArray(s.skip_paths) ? s.skip_paths : str(s.skip_paths) ? str(s.skip_paths).split(",") : null;
  const skipPaths = rawSkip ? rawSkip.map((x) => String(x).trim()).filter(Boolean) : [...DEFAULT_SKIP_PATHS];
  const n = Number(str(s.max_rounds));
  const maxRounds = str(s.max_rounds) !== "" && Number.isInteger(n) && n >= 0 && n <= 10 ? n : DEFAULT_MAX_ROUNDS;
  const t = Number(str(s.precheck_timeout_seconds));
  const precheckTimeoutSeconds = str(s.precheck_timeout_seconds) !== "" && Number.isInteger(t) && t >= 1 && t <= 3600 ? t : DEFAULT_PRECHECK_TIMEOUT_SECONDS;
  return { mode, workflow, pathsInput, skipPaths, maxRounds, precheckTimeoutSeconds };
}

const globRe = (g) => new RegExp(`^${g.split("**").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*")}$`);
/** A glob without "/" matches the basename anywhere (gitignore style); one with "/" matches the whole path. */
export function matchesGlob(file, glob) {
  const f = String(file), g = String(glob).replace(/^\.?\//, "");
  return g.includes("/") ? globRe(g).test(f) : globRe(g).test(f.split("/").at(-1));
}
/** Changed files that CI must see: everything except the engine's own `.forge-lean/` hand-off files. */
export const verifiableFiles = (files) => (files ?? []).filter((f) => f && !String(f).startsWith(LEAN_PREFIX));
/** True when every verifiable changed file matches a skip glob (a docs-only lane), or there is none. */
export function skipsCi(files, skipPaths = DEFAULT_SKIP_PATHS) {
  const fs = verifiableFiles(files);
  return fs.every((f) => skipPaths.some((g) => matchesGlob(f, g)));
}

/** Tail each log so the total stays under `cap` characters. */
export function capLogs(failures, cap = LOG_CAP) {
  const per = Math.max(500, Math.floor(cap / Math.max(1, failures.length)));
  return failures.map((f) => { const l = String(f.log ?? ""); return { ...f, log: l.length > per ? `…${l.slice(-per)}` : l }; });
}
const runIdOf = (url) => /\/actions\/runs\/(\d+)/.exec(String(url ?? ""))?.[1] ?? null;
/**
 * Failed checks [{name, url}] → capped [{job, url, log}]: one `failedLogs` fetch per Actions run id, the log attached to
 * the first check of that run only (#4240: shared by runCiVerify and the merge-time fix rounds).
 */
export async function collectFailedLogs(io, failedChecks) {
  const logs = {}, out = [];
  for (const c of failedChecks ?? []) {
    const id = runIdOf(c.url);
    if (id && !(id in logs)) { try { logs[id] = String((await io.failedLogs?.(id)) ?? ""); } catch { logs[id] = ""; } }
    out.push({ job: c.name, url: c.url ?? null, log: id && !out.some((x) => runIdOf(x.url) === id) ? logs[id] : "" });
  }
  return capLogs(out);
}
const sameSha = (a, b) => Boolean(a && b) && (String(a).startsWith(b) || String(b).startsWith(a));

/**
 * One CI verification of `head` on `branch`. Returns {result: pass|fail|timeout|unavailable|skipped, failures, runUrl,
 * detail, runId}. `push` is called before any CI call (never for a skipped lane); `exclude` lists run ids already judged,
 * so a re-dispatch on the same head never reuses an old run; `onPoll` runs before each wait (lease renew, progress).
 */
export async function runCiVerify({ io, branch, head, changedFiles, verify, ciMaxMinutes = 360, now = () => Date.now(), sleep, random = Math.random,
  push = async () => {}, exclude = [], onPoll = async () => {}, graceMs = DEFAULT_GRACE_MS }) {
  const v = verify ?? parseVerify({});
  const files = verifiableFiles(changedFiles);
  if (skipsCi(files, v.skipPaths)) return { result: "skipped", failures: [], runUrl: null, detail: `all ${files.length} changed file(s) match skip_paths` };
  await push();
  const startedAt = now();
  const unavailable = (detail) => ({ result: "unavailable", failures: [], runUrl: null, detail });
  if (v.workflow) {
    if (!io.dispatchWorkflow || !io.workflowRuns) return unavailable("no workflow dispatch seam");
    const inputs = v.pathsInput ? { [v.pathsInput]: files.join("\n") } : {};
    try { await io.dispatchWorkflow({ workflow: v.workflow, ref: branch, inputs }); }
    catch (e) { return unavailable(`workflow ${v.workflow} could not be dispatched: ${String(e?.stderr ?? e?.message ?? e).split("\n")[0].slice(0, 200)}`); }
  } else if (!io.commitChecks) return unavailable("no commit-checks seam");
  const skip = new Set(exclude.map(String));
  for (let i = 0; ; i++) {
    if (v.workflow) {
      let runs = [];
      try { runs = (await io.workflowRuns({ workflow: v.workflow, branch })) ?? []; } catch { runs = []; }
      const run = runs.find((r) => sameSha(r?.headSha, head) && !skip.has(String(r?.databaseId)));
      if (run && String(run.status).toLowerCase() === "completed") {
        const c = String(run.conclusion ?? "").toLowerCase();
        if (OK.includes(c)) return { result: "pass", failures: [], runUrl: run.url ?? null, runId: run.databaseId, detail: `${v.workflow} ${c}` };
        let log = "";
        try { log = String((await io.failedLogs?.(run.databaseId)) ?? ""); } catch { log = ""; }
        return { result: "fail", failures: capLogs([{ job: run.name ?? v.workflow, url: run.url ?? null, log }]), runUrl: run.url ?? null, runId: run.databaseId, detail: `${v.workflow} ${c || "failed"}` };
      }
      if (!run && now() - startedAt >= graceMs) return unavailable(`no ${v.workflow} run for ${String(head).slice(0, 12)} appeared within ${Math.round(graceMs / 60000)} min`);
    } else {
      let checks = [];
      try { checks = (await io.commitChecks(head)) ?? []; } catch { checks = []; }
      if (!checks.length && now() - startedAt >= graceMs) return unavailable(`no checks reported for ${String(head).slice(0, 12)} within ${Math.round(graceMs / 60000)} min`);
      if (checks.length && checks.every((c) => c.state !== "pending")) {
        const failed = checks.filter((c) => c.state === "failure");
        if (!failed.length) return { result: "pass", failures: [], runUrl: null, detail: `${checks.length} check(s) green` };
        return { result: "fail", failures: await collectFailedLogs(io, failed), runUrl: failed[0].url ?? null, detail: `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}` };
      }
    }
    if (now() - startedAt >= ciMaxMinutes * 60000) return { result: "timeout", failures: [], runUrl: null, detail: `CI still pending after ${ciMaxMinutes} min` };
    await onPoll();
    await sleep(ciPollDelayMs(i, random));
  }
}
