// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GitHub Actions lane provider (#5748) on the remote provider seam (sandbox-remote.mjs). A lane is a `workflow_dispatch`
 * run of `.github/workflows/forgedock-lane.yml` on a hosted runner (free for public repos). The transport is the only
 * Actions-specific part:
 *   launch  dispatches the workflow with non-secret inputs only (lane_id, issue, batch, ref = the base lane, args); the Claude credential
 *           lives in the workflow's `forgedock-lane` environment and the spec's env is never sent (inputs are public)
 *   status  finds the run by its run-name `forgedock-lane <lane_id>`: queued or in_progress is running, completed exited
 *   result  the lane posts its result as an issue comment `<!-- FORGE:LANE-RESULT <lane_id> -->` + a json fence; only a
 *           comment by github-actions[bot] counts (anyone can comment on a public repo). A run that hit the 6 h limit
 *           without a result is a retryable deferral: run-issue pushes checkpoints and the retry resumes from them
 *   capacity  the plan's concurrent-job limit minus a CI reserve minus the lane runs in flight
 * GitHub stays the register: a lane id is `fdrsbx-<batch>-<issue>`, so a restarted dispatcher re-finds its run.
 */
import { spawn } from "node:child_process";
import { remoteProvider, redact } from "./sandbox-remote.mjs";

export const LANE_WORKFLOW = "forgedock-lane.yml";
export const LANE_ENVIRONMENT = "forgedock-lane";
export const LANE_RESULT_MARKER = (id) => `<!-- FORGE:LANE-RESULT ${id} -->`;
export const ACTIONS_TIMEOUT_CODE = "sandbox.actions_timeout";
const ACTIONS_TIMEOUT_RETRY_S = 60;
/** Standard concurrent-job limits per plan (docs.github.com Actions limits); an unknown plan is the smallest. */
export const PLAN_JOB_LIMITS = Object.freeze({ free: 20, pro: 40, team: 60, enterprise: 500 });
export const DEFAULT_CI_RESERVE = 5;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const RESULT_BOT = "github-actions[bot]";
const typedError = (code, message) => Object.assign(new Error(message), { code });

/** The lane-run limit: an explicit `job_limit`, else the plan's, minus the CI reserve; never below 0. */
export function laneCap({ jobLimit = null, plan = null, ciReserve = DEFAULT_CI_RESERVE } = {}) {
  const limit = Number.isInteger(jobLimit) && jobLimit > 0 ? jobLimit : PLAN_JOB_LIMITS[String(plan ?? "").toLowerCase()] ?? PLAN_JOB_LIMITS.free;
  const reserve = Number.isInteger(ciReserve) && ciReserve >= 0 ? ciReserve : DEFAULT_CI_RESERVE;
  return Math.max(0, limit - reserve);
}

/** `gh api` as an async JSON call: `api(method, path, body?)` → parsed JSON, or null for an empty body. Throws on a non-2xx. */
export function ghApi({ env = process.env, bin = "gh" } = {}) {
  return (method, path, body = null) => new Promise((resolve, reject) => {
    const args = ["api", "-X", method, path, ...(method === "GET" && /\/comments(\?|$)/.test(path) ? ["--paginate", "--slurp"] : []), ...(body ? ["--input", "-"] : [])];
    const c = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("error", reject);
    c.on("close", (code) => {
      if (code !== 0) return reject(Object.assign(new Error(err.split("\n")[0].slice(0, 300) || `gh api exited ${code}`), { status: /HTTP (\d{3})/.exec(err)?.[1] ? Number(/HTTP (\d{3})/.exec(err)[1]) : undefined }));
      try { resolve(out.trim() ? JSON.parse(out) : null); } catch (e) { reject(e); }
    });
    if (body) c.stdin.end(JSON.stringify(body)); else c.stdin.end();
  });
}

const flat = (r) => (Array.isArray(r) ? r.flat() : []);
const issueOf = (id) => /-(\d+)$/.exec(String(id))?.[1] ?? null;

/** The Actions transport over an injected `api`. Its launch never carries the spec's env. */
export function actionsTransport({ repo, settings = {}, api, now = () => Date.now() }) {
  if (typeof api !== "function") throw new Error("actions provider needs an api");
  const runs = async () => ((await api("GET", `repos/${repo}/actions/workflows/${LANE_WORKFLOW}/runs?event=workflow_dispatch&per_page=100`))?.workflow_runs ?? []);
  const runOf = async (id) => (await runs()).find((r) => r.display_title === `forgedock-lane ${id}`) ?? null;
  const launched = new Map(); // lane id -> dispatch time: a run is not listed for a few seconds
  const GRACE_MS = 120000;
  return {
    async launch(spec) {
      if (!/^fdrsbx-[A-Za-z0-9._-]+-\d+$/.test(spec.id)) throw typedError("execution.provider.misconfigured", `actions lane id ${JSON.stringify(spec.id)} is not a lane id`);
      let ref = spec.repo?.ref ?? null;
      if (!ref) { try { ref = (await api("GET", `repos/${repo}`))?.default_branch ?? null; } catch { ref = null; } } // no --lane: the repo's default branch
      if (!ref || !SAFE_REF.test(ref) || ref.includes("..")) throw typedError("execution.provider.misconfigured", `actions lane needs a base lane ref (--lane); got ${JSON.stringify(ref)}`);
      if (settings.dispatcher) {
        let login = null;
        try { login = (await api("GET", "user"))?.login ?? null; } catch { login = null; }
        if (login !== settings.dispatcher) throw typedError("actions.dispatcher_refused", `the dispatcher identity ${JSON.stringify(login)} is not the configured execution.dispatcher ${JSON.stringify(settings.dispatcher)}`);
      }
      const args = (spec.command ?? []).slice(3).filter((a, i, all) => a !== "--result-file" && all[i - 1] !== "--result-file").map(String);
      await api("POST", `repos/${repo}/actions/workflows/${LANE_WORKFLOW}/dispatches`, { ref, inputs: { lane_id: spec.id, issue: String(spec.issue), batch: String(spec.batch ?? ""), ref, args: JSON.stringify(args) } });
      launched.set(spec.id, now());
    },
    async status(id) {
      const r = await runOf(id);
      if (!r) return now() - (launched.get(id) ?? -Infinity) < GRACE_MS ? "running" : "gone";
      return r.status === "completed" ? "exited" : "running";
    },
    async result(id) {
      const issue = issueOf(id);
      if (issue) {
        const marker = LANE_RESULT_MARKER(id);
        const mine = flat(await api("GET", `repos/${repo}/issues/${issue}/comments?per_page=100`)).filter((c) => c?.user?.login === RESULT_BOT && String(c.body ?? "").startsWith(marker));
        const body = String(mine.at(-1)?.body ?? "");
        const m = /```json\s*\n([\s\S]*?)\n```/.exec(body);
        if (m) { try { const o = JSON.parse(m[1]); if (o && typeof o === "object") return o; } catch { /* unreadable: fall through */ } }
      }
      const r = await runOf(id);
      if (r?.conclusion === "timed_out") return { terminalReason: "deferred", code: ACTIONS_TIMEOUT_CODE, retryInSeconds: ACTIONS_TIMEOUT_RETRY_S, detail: `run ${r.id} hit the Actions job time limit before it posted a result; the retry resumes from the lane's pushed checkpoint` };
      return null;
    },
    async usage(id) {
      const r = await runOf(id);
      const a = Date.parse(r?.run_started_at ?? ""), b = Date.parse(r?.updated_at ?? "");
      return Number.isFinite(a) && Number.isFinite(b) && b >= a ? { minutes: Math.round(((b - a) / 60000) * 10) / 10, cost_usd: 0 } : null;
    },
    async destroy(id) {
      launched.delete(id); // a destroyed lane is gone, not "not listed yet"
      const r = await runOf(id);
      if (r && r.status !== "completed") { try { await api("POST", `repos/${repo}/actions/runs/${r.id}/cancel`); } catch (e) { if (e?.status !== 409) return false; } }
      return true;
    },
    async capacity() {
      const cap = laneCap({ jobLimit: settings.jobLimit ?? null, plan: settings.plan ?? null, ciReserve: settings.ciReserve });
      const busy = (await runs()).filter((r) => r.status !== "completed" && String(r.display_title ?? "").startsWith("forgedock-lane ")).length;
      return { free: Math.max(0, cap - busy), online: null };
    },
  };
}

/** The `actions` sandbox provider: the remote provider over `actionsTransport`; the lane log stays on GitHub (public). */
export function actionsProvider({ batch, repo, settings = {}, api = ghApi(), env = process.env, credentials, now, transport = null, ...rest }) {
  const t = transport ?? actionsTransport({ repo, settings, api, ...(now ? { now } : {}) });
  return remoteProvider({ batch, repo, settings, name: "actions", env, transport: t, ...(credentials ? { credentials } : {}), ...(now ? { now } : {}), ...rest });
}
