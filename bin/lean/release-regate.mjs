// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Gate-only fix lane (#5584, epic #5549 N5, rule R4): `forgedock release control regate <id> --ref <fix> --reason ...`
 * re-evaluates the gates of an already-deployed release sha with the gate code of the fix ref, without a merge cycle.
 * `classifyGateOnly` decides from the changed paths whether the fix is limited to gate artifacts; anything that ships in an
 * image (app, migration, image path, a workflow hunk outside `gates.workflow_steps`) is the normal lane. `regatePlan` refuses
 * closed (no recorded live record/rollback target, a run-set freeze with migration evidence, not gate-only); `regateDispatch`
 * sends the one fenced dispatch (`forge_epoch`, never `override_freeze`, I26) and records the gate-script sha. Nothing here
 * runs unless the verb is called.
 */
import { createHash } from "node:crypto";
import { buildDispatchArgs } from "./release-control.mjs";
import { fenced } from "./release-fence.mjs";
import { acquireLease } from "./release-ledger.mjs";
import { parseGatesConfig } from "./release-gates.mjs";
import { MIGRATION_PATHS } from "./release-config.mjs";

export const IMAGE_PATH = /(^|\/)(Dockerfile[^/]*|[^/]*\.dockerfile|docker-compose[^/]*\.ya?ml|\.dockerignore)$/i;
export const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const reOf = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")}$`);
export const releaseRegateMatchesAny = (path, globs) => globs.some((g) => reOf(g).test(path));

/**
 * @param {string[]} changedPaths files changed between the failed release sha and the candidate fix
 * @param {object} policy release policy (`gates.paths`, `gates.workflow_steps`)
 * @param {{workflowSteps?: Record<string, Array<string|null>>}} [o] per workflow file, the step name (null: outside any step) of each changed hunk
 * @returns {{gateOnly: boolean, offenders: {path: string, kind: string}[]}}
 */
export function classifyGateOnly(changedPaths, policy, { workflowSteps = {} } = {}) {
  const cfg = parseGatesConfig(policy), offenders = [];
  for (const path of changedPaths) {
    let kind = null;
    if (releaseRegateMatchesAny(path, MIGRATION_PATHS)) kind = "migration";
    else if (IMAGE_PATH.test(path)) kind = "image";
    else if (WORKFLOW_PATH.test(path)) {
      const steps = workflowSteps[path];
      if (!Array.isArray(steps) || !steps.length || steps.some((s) => s == null || !cfg.workflowSteps.includes(s))) kind = "workflow-hunk";
    } else if (!releaseRegateMatchesAny(path, cfg.paths)) kind = "app";
    if (kind) offenders.push({ path, kind });
  }
  return { gateOnly: !!changedPaths.length && !offenders.length, offenders };
}

/** The step name each changed hunk of workflow `file` (between `base` and `ref`) lies in; null for a line outside any named step. */
export function hunkSteps(io, base, ref, file) {
  const diff = String(io.git(["diff", "-U0", `${base}..${ref}`, "--", file]));
  const lines = String(io.git(["show", `${ref}:${file}`])).split("\n");
  const indent = (l) => l.length - l.trimStart().length;
  const items = [];
  lines.forEach((l, i) => {
    if (!/^\s*-\s/.test(l)) return;
    const ind = indent(l);
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].trim().startsWith("#") || indent(lines[end]) > ind || (indent(lines[end]) === ind && !/^\s*-\s/.test(lines[end])))) end++;
    let name = null;
    for (let j = i; j < end; j++) { const m = new RegExp(`^\\s{${j === i ? ind : ind + 2}}(?:-\\s+)?name:\\s*["']?(.+?)["']?\\s*$`).exec(lines[j]); if (m) { name = m[1]; break; } }
    if (name) items.push({ start: i, end, name });
  });
  const out = [];
  for (const m of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const c = Number(m[1]), d = m[2] === undefined ? 1 : Number(m[2]);
    const from = Math.max(c - 1, 0), to = d === 0 ? from : c - 2 + d; // 0-based inclusive; a pure deletion maps to the line it follows
    for (let ln = from; ln <= to; ln++) out.push(items.filter((it) => it.start <= ln && ln < it.end).pop()?.name ?? null);
  }
  return out;
}

const rev = (io, r) => String(io.git(["rev-parse", "--verify", `${r}^{commit}`])).trim();

/** sha1 over `path blob` of each changed gate path at `ref`: identifies the gate code that evaluates. */
export function gateScriptSha(io, ref, paths) {
  const lines = [...paths].sort().map((p) => { let b = "deleted"; try { b = String(io.git(["rev-parse", `${ref}:${p}`])).trim(); } catch { /* deleted at ref */ } return `${p} ${b}`; });
  return createHash("sha1").update(lines.join("\n")).digest("hex");
}

/**
 * Every refusal happens before anything is written or dispatched.
 * `ctx`: {io, repo, policy, state}; `args`: {ref, gateFixRef?}.
 * @returns {{refuse: string} | {plan: {sha, refName, ref, gateSha, gateFixRef, workflow, changed}}}
 */
export async function regatePlan({ io, repo, policy, state }, { ref, gateFixRef = null }) {
  const d = state?.deploy;
  if (!d?.target?.sha || !d.merge) return { refuse: "no recorded live record/rollback target for this release (I9); nothing to re-evaluate" };
  if (!ref) return { refuse: "--ref <fix branch or sha> is required" };
  const workflow = policy?.verify?.workflow;
  if (!workflow) return { refuse: "policy verify.workflow is not set; nothing to dispatch" };
  let refSha, changed;
  try {
    refSha = rev(io, ref);
    changed = String(io.git(["diff", "--name-only", `${d.merge}..${refSha}`])).split("\n").filter(Boolean);
  } catch (e) { return { refuse: `cannot diff ${String(d.merge).slice(0, 8)}..${ref}: ${String(e?.message ?? e).split("\n")[0]}` }; }
  const name = policy?.deploy?.freeze_variable;
  if (name) {
    let v = ""; try { v = String(await io.gh(["variable", "get", name, "--repo", repo])).trim(); } catch { /* unset */ }
    if (v && !d.freezeBefore) { // set during the deploy: the run froze it
      let mig;
      try { mig = String(io.git(["diff", "--name-only", `${d.target.sha}..${d.merge}`, "--", ...MIGRATION_PATHS])).split("\n").filter(Boolean); } catch { mig = ["(unreadable)"]; }
      if (mig.length) return { refuse: `${name} was set by the run and migration evidence exists (${mig[0]}); a human decides with override_freeze (I26)` };
    }
  }
  let workflowSteps = {};
  try { for (const f of changed.filter((p) => WORKFLOW_PATH.test(p))) workflowSteps[f] = hunkSteps(io, d.merge, refSha, f); } catch { workflowSteps = {}; }
  const c = classifyGateOnly(changed, policy, { workflowSteps });
  if (!c.gateOnly) return { refuse: `not a gate-only fix; use the normal lane (${c.offenders.slice(0, 3).map((o) => `${o.path}: ${o.kind}`).join(", ") || "no changed paths"})` };
  if ((state.regates ?? []).some((r) => r.ref === refSha)) return { refuse: `${refSha.slice(0, 8)} was already re-evaluated for this release` };
  return { plan: { sha: d.merge, refName: ref, ref: refSha, gateSha: gateScriptSha(io, refSha, changed), gateFixRef, workflow, changed } };
}

/** The lease that fences the dispatch (own epoch, `forge_epoch` input); no `io.api`: unmanaged, no fence. */
async function takeFence(ctx, holder) {
  if (!ctx.io.api) return { fence: null };
  const lctx = { io: ctx.io, repo: ctx.repo, credential: "driver" };
  const l = await acquireLease(lctx, { holder, release: ctx.state.id, issue: ctx.state.steps?.["release-pr"]?.result?.pr, ttlS: 300, now: ctx.io.now() });
  if (!l.ok) return { refused: l.refused ?? "lease lost the race" };
  const record = async (rec) => { const a = (ctx.state.intents ??= []); const i = a.findIndex((x) => x.key === rec.key); if (i < 0) a.push(rec); else a[i] = rec; ctx.save?.(); };
  return { fence: { lctx, lease: l.lease, record, now: () => new Date(ctx.io.now()).toISOString() } };
}

/**
 * One fenced dispatch of the verification workflow at the fix ref for the same release sha. LIVE_CHECK (I28) is the
 * workflow's and the caller's: the live record is not touched here.
 * @returns {Promise<{ok: true, entry} | {refused: string}>}
 */
export async function regateDispatch(ctx, plan, { actor, host }) {
  const { io, repo, state } = ctx;
  const f = ctx.fence ? { fence: ctx.fence } : await takeFence(ctx, io.holder ?? `host-${process.pid}`);
  if (f.refused) return { refused: f.refused };
  const inputs = { sha: plan.sha, regate: "true", gate_sha: plan.gateSha, ...(plan.gateFixRef ? { gate_fix_ref: plan.gateFixRef } : {}) };
  let epoch = null;
  const r = await fenced(f.fence, { action: "dispatch", key: `${state.id}:regate:${f.fence?.lease?.epoch ?? 0}:${plan.ref}` }, (e) => {
    epoch = e;
    return io.gh(buildDispatchArgs({ workflow: plan.workflow, repo, ref: plan.refName, inputs: { ...inputs, ...(e != null ? { forge_epoch: e } : {}) } }));
  });
  if (r.refused) return { refused: `dispatch ${r.refused}` };
  const entry = { at: new Date(io.now?.() ?? Date.now()).toISOString(), ref: plan.ref, sha: plan.sha, gate_sha: plan.gateSha, ...(plan.gateFixRef ? { gate_fix_ref: plan.gateFixRef } : {}), workflow: plan.workflow, actor, host: host ?? null, forge_epoch: epoch };
  (state.regates ??= []).push(entry);
  ctx.save?.();
  return { ok: true, entry };
}
