// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The service-scoped bug-fix train lane (#5570, epic #5549 Phase 5; I3, I4, Q9): a wave of single-service bug fixes branches from what
 * is live (`laneStartGuard`, #5565), is re-checked against its real diff at CUT (`recomputeAtCut`: widening demotes the wave to the
 * release lane or ejects the issue, narrowing is accepted), lands on the default branch with `Forge-Lane`/`Forge-Release`/`Forge-Epoch`
 * trailers, then deploys through the `service` pipeline with the merge sha and unit set. The roll-set comes from `rollSet` (#5559),
 * never from the classification record. Rung 1 of the ladder (#5563) runs on failure with the previous per-unit digests recorded first.
 * A web/edge unit keeps the wave in VERIFYING until the injected `ctx.purge({units, sha})` seam reports `{ok: true}`.
 */
import { readTarget, deployStep } from "./release-deploy.mjs";
import { runRollback, takeFence } from "./release-rollback.mjs";
import { claimDeploy, releaseDeploy, recordTrain } from "./release-ledger.mjs";
import { buildDispatchArgs } from "./release-control.mjs";
import { fenced, laneTrailers } from "./release-fence.mjs";
import { laneStartGuard } from "./release-p0.mjs";
import { rollSet } from "./release-plan.mjs";
import { matchesAny } from "./release-unitmap.mjs";
import { MIGRATION_PATHS } from "./release-config.mjs";

const json = (s) => { try { return JSON.parse(String(s ?? "")); } catch { return null; } };
const noMigration = (m) => !m || m === "none" || m === "false";

/**
 * CUT-time recompute of one issue from its real diff against its classification record `{units, migrations, contract}`.
 * @returns {{action: "keep"|"demote"|"eject", units: string[], migrations: boolean, contract: boolean, pipeline: string, widened: string[], narrowed: string[], why?: string}}
 * Widening by a migration, a contract file or a pipeline that forces `full` demotes the wave; a new unit ejects the issue.
 */
export function recomputeAtCut(policy, record, diff) {
  const files = diff ?? [];
  const roll = rollSet(policy, files);
  const migrations = files.some((f) => matchesAny(MIGRATION_PATHS, f));
  const contract = roll.contract.atomic;
  const had = new Set(record?.units ?? []);
  const widened = [], narrowed = [];
  for (const u of roll.units) if (!had.has(u)) widened.push(`unit:${u}`);
  for (const u of had) if (!roll.units.includes(u)) narrowed.push(`unit:${u}`);
  if (migrations && noMigration(record?.migrations)) widened.push("migration");
  if (contract && !record?.contract) widened.push("contract");
  if (!migrations && !noMigration(record?.migrations)) narrowed.push("migration");
  const base = { units: roll.units, migrations, contract, pipeline: roll.pipeline, widened, narrowed };
  if (widened.includes("migration") || widened.includes("contract") || roll.pipeline === "full") {
    return { ...base, action: "demote", why: roll.pipeline === "full" && !widened.length ? `the diff forces the full pipeline (${roll.forced.join(", ") || roll.no_service.join(", ")})` : `diff widened past the record: ${widened.join(", ")}` };
  }
  if (widened.length) return { ...base, action: "eject", why: `diff widened past the record: ${widened.join(", ")}` };
  return { ...base, action: "keep" };
}

/** `train/<date>-<n>` from `branches.train` (placeholders `<date>`, `<n>`; default pattern when unset). */
export function trainBranch(policy, date, n) {
  const name = String(policy?.branches?.train || "train/<date>-<n>").replace("<date>", date).replace("<n>", String(n));
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.includes("..") ? name : null;
}

/** Units in dispatch order: contract producer first (atomic), then the rest sorted. */
const dispatchOrder = (roll) => [...roll.contract.order, ...roll.units.filter((u) => !roll.contract.order.includes(u))];

/**
 * Run a train wave. `ctx`: {io, repo, def, state, save, config: {deploy, ...}, policy, actor, host, purge?, date, n};
 * `wave`: [{issue, pr, record}]. @returns {Promise<{status: "live"|"verifying"|"demoted"|"rolled-back"|"refused"|"queued"|"blocked"|"stopped", reason?, branch?, ejected?, units?, rollback?}>}
 */
export async function runTrain(ctx, wave) {
  const { io, state, policy } = ctx;
  const L = { claimDeploy, releaseDeploy, takeFence, recordTrain, deployStep, runRollback, ...(ctx.ledger ?? {}) }; // overridable for tests
  const d = ctx.config.deploy, pipe = d?.pipelines?.service;
  if (!pipe?.workflow) return { status: "refused", reason: "deploy.pipelines.service is not configured" };
  const name = trainBranch(policy, ctx.date, ctx.n);
  if (!name) return { status: "refused", reason: "invalid train branch name" };
  // CUT: recompute each issue from its PR's real files before anything is created (I3, I4)
  const kept = [], ejected = [];
  for (const w of wave) {
    const files = (json(await io.gh(["pr", "view", String(w.pr), "--repo", ctx.repo, "--json", "files"]))?.files ?? []).map((f) => f.path);
    const r = recomputeAtCut(policy, w.record, files);
    if (r.action === "demote") return { status: "demoted", reason: `#${w.issue}: ${r.why}; the wave moves to the release lane` };
    if (r.action === "eject") ejected.push({ issue: w.issue, reason: r.why }); else kept.push({ ...w, files });
  }
  if (!kept.length) return { status: "demoted", reason: "every issue was ejected at CUT", ejected };
  const files = [...new Set(kept.flatMap((w) => w.files))].sort();
  const roll = rollSet(policy, files);
  const units = dispatchOrder(roll);
  const g = await laneStartGuard({ ...ctx, deploy: d, release: state.id }, "train");
  if (g.refused) return { status: "refused", reason: g.refused };
  const live = await readTarget(io, d.live_release_command);
  const tr = (state.train ??= {});
  Object.assign(tr, { branch: name, live: g.live, units, order: roll.contract.order, previous: Object.fromEntries(units.map((u) => [u, live?.images?.[u] ?? null])), state: "CREATED" }); // frozen rollback inputs (#5560)
  ctx.save();
  io.git(["push", "--quiet", "origin", `${g.live}:refs/heads/${name}`]);
  for (const w of kept) {
    io.git(["fetch", "--quiet", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`]);
    const tip = io.git(["rev-parse", `refs/remotes/origin/${name}`]).trim();
    const f = await fenced(ctx.fence, { action: "merge", key: `train:${name}:${w.pr}` }, async () => {
      await io.gh(["pr", "edit", String(w.pr), "--repo", ctx.repo, "--base", name]);
      return io.gh(["pr", "merge", String(w.pr), "--repo", ctx.repo, "--merge"]);
    });
    if (f.refused) return { status: "refused", branch: name, reason: f.refused };
    tr.merged = [...(tr.merged ?? []), w.pr]; tr.tip = tip; ctx.save();
  }
  io.git(["fetch", "--quiet", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`]);
  const regen = (policy?.contracts ?? []).filter((c) => c.regenerate && files.some((f) => matchesAny(c.paths, f)));
  if (regen.length) { // contract wave: regenerate artefacts before the push so they are in the wave
    io.git(["checkout", "-q", "-B", name, `origin/${name}`]);
    for (const c of regen) {
      const r = await io.rehearse(c.regenerate, { timeout: 600_000 });
      if (!r?.ok) return { status: "refused", branch: name, reason: `contracts regenerate failed for ${c.producer}: ${String(r?.output ?? "").slice(-200)}` };
    }
    if (String(io.git(["status", "--porcelain"]) ?? "").trim()) { io.git(["add", "-A"]); io.git(["commit", "-q", "-m", `chore(train): regenerate contract artefacts for ${name}`]); io.git(["push", "--quiet", "origin", name]); }
  }
  const lctx = io.api ? { io, repo: ctx.repo, credential: "driver" } : null;
  const dctx = { ...ctx, staging: ctx.def, git: io.git, config: { ...ctx.config, deployPipeline: "service", trainDispatch: { units } } };
  try { buildDispatchArgs({ workflow: pipe.workflow, repo: ctx.repo, ref: ctx.def, inputs: { ...(pipe.inputs ?? {}), merge_sha: "0".repeat(40), units: units.join(",") } }); } catch (e) { return { status: "refused", branch: name, reason: e.message }; }
  if (io.api) {
    const fl = await L.takeFence(dctx, io.holder ?? `host-${process.pid}`);
    if (fl.refused) return { status: "refused", reason: fl.refused };
    dctx.fence = fl.fence;
  }
  if (lctx) {
    const c = await L.claimDeploy(lctx, { release: state.id, actor: ctx.actor, reason: `train ${name}`, now: io.now?.() });
    if (c.queued) return { status: "queued", branch: name, reason: c.queued };
    if (c.lost) return { status: "refused", reason: "could not claim the deploy slot in the ledger" };
  }
  try { // landing: merge-then-deploy, the merge carries the lane trailers
    const url = String(await io.gh(["pr", "create", "--repo", ctx.repo, "--base", ctx.def, "--head", name, "--title", `train: land ${name} on ${ctx.def}`, "--body", `Landing PR for train wave ${name}.`]) ?? "");
    const pr = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null;
    const head = io.git(["rev-parse", `refs/remotes/origin/${name}`]).trim();
    const m = await fenced(dctx.fence, { action: "merge", key: `train:land:${name}:${head}` }, (epoch) => io.gh(["pr", "merge", String(pr), "--repo", ctx.repo, "--merge", "--match-head-commit", head, "--body", laneTrailers({ lane: "train", release: state.id, epoch })]));
    if (m.refused) return { status: "refused", branch: name, reason: m.refused };
    const v = json(await io.gh(["pr", "view", String(pr), "--repo", ctx.repo, "--json", "state,mergeCommit"]));
    const sha = v?.mergeCommit?.oid;
    if (!sha) return { status: "stopped", branch: name, reason: `landing PR #${pr} has no merge commit yet` };
    Object.assign(tr, { landingPr: pr, merge: sha, state: "LANDED" });
    state.steps["release-pr"] = { done: true, result: { pr, issues: kept.map((w) => w.issue) } };
    state.steps["post-merge"] = { done: true, result: { merge: sha } };
    state.lane = "train"; ctx.save();
    if (lctx) await L.recordTrain(lctx, { release: state.id, state: "LANDED", branch: name, merge: sha, units }, io.now?.()); // also notes the rollout record is invalidated
    const out = await L.deployStep(dctx);
    if (out.blocked || out.stopped) {
      const rolled = state.deploy?.target && state.deploy?.runId && !out.stopped;
      const reason = out.reason ?? out.why;
      if (!rolled) return { status: out.blocked ? "blocked" : "stopped", branch: name, reason };
      const rb = await L.runRollback({ ...dctx, policy, actor: ctx.actor, host: ctx.host, trainDigests: tr.previous }, { reason, to: "flag" });
      tr.rollback = { rung: rb.rung, ok: rb.ok, digests: tr.previous }; tr.state = "ROLLED_BACK"; ctx.save();
      return { status: "rolled-back", branch: name, reason, rollback: rb };
    }
    if (out.skipped) return { status: "refused", reason: "deploy.pipelines is empty; nothing to deploy" };
    const edge = units.filter((u) => ["web", "edge"].includes(policy?.units?.[u]?.surface));
    if (edge.length) {
      const p = ctx.purge ? await ctx.purge({ units: edge, sha }) : null;
      if (!p?.ok) {
        tr.state = "VERIFYING"; tr.verifying = ctx.purge ? `purge for ${edge.join(", ")} did not report success${p?.reason ? `: ${p.reason}` : ""}` : `no purge seam configured for web/edge unit(s) ${edge.join(", ")}`; ctx.save();
        return { status: "verifying", branch: name, reason: tr.verifying, units, ...(ejected.length ? { ejected } : {}) };
      }
    }
    tr.state = "LIVE"; ctx.save();
    if (lctx) await L.recordTrain(lctx, { release: state.id, state: "LIVE", branch: name, merge: sha, units }, io.now?.());
    return { status: "live", branch: name, units, landingPr: pr, ...(ejected.length ? { ejected } : {}) };
  } finally {
    if (lctx) await L.releaseDeploy(lctx, state.id).catch(() => null);
  }
}
