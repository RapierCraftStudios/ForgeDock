// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Native unattended milestone train (#4658): `forgedock milestone train <slug...>`.
 *
 * One durable state file `<batchRoot>/trains/<id>/state.json` (tmp + fsync + rename, like a batch) holds the order, the
 * active set, each milestone's status and lifecycle state (#4657) and the typed STOP, if any. Deterministic, 0 LLM calls.
 * Each milestone runs as one orchestrate batch; its lanes resolve their base from the issue's milestone (lane.mjs), so
 * the train never steers them through `branches.staging` and never writes forge.yaml. After a batch the lifecycle seam
 * (`onBatchEnd`) records `shipped:staging` and closes at `milestones.close_on`. A slug is a milestone title.
 * Caps have one source, forge.yaml `orchestration.global_parallel` (see `resolveCaps`); a conflicting override is ignored.
 * Order is defined once, in the state; `insertMilestone` is the only way to add one and re-runs dependency validation.
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "./batch.mjs";
import { classifyEdges } from "../../scripts/plan-validate-live.mjs";

export const STOP_REASONS = ["dependency-unmet", "needs-human", "breaker", "budget", "cancelled", "milestone-open", "error"];
export const DEFAULT_LANE_PARALLEL = 3;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const trainRoot = (batchRoot) => join(batchRoot, "trains");
export const newTrainId = (now = Date.now()) => `train-${new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${process.pid}`;

/** Handle on one train's state file. */
export function openTrain(root, id) {
  if (!ID_RE.test(String(id))) throw new Error(`invalid train id: ${id}`);
  const file = join(trainRoot(root), id, "state.json");
  return {
    id, file,
    exists: () => existsSync(file),
    load() { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } },
    save(state) { writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`); },
  };
}

/**
 * The only cap source is `orchestration.global_parallel` (host-wide lane cap, shared with `forgedock sched cap`); unset
 * it is DEFAULT_LANE_PARALLEL. A `requested` lane cap (`--parallel`) that differs is ignored with a warning.
 * Active milestones split the cap, at least 1 lane each.
 */
export function resolveCaps({ requested = null, globalParallel = null, parallelMilestones = 1 }) {
  const cap = globalParallel ?? DEFAULT_LANE_PARALLEL;
  const warnings = [];
  if (requested != null && requested !== cap) warnings.push(`train: --parallel ${requested} conflicts with the lane cap ${cap} (${globalParallel ? "orchestration.global_parallel" : "default"}); ignored`);
  return { cap, parallelMilestones, perMilestone: Math.max(1, Math.floor(cap / parallelMilestones)), warnings };
}

/** Throws when `order` puts a milestone before one its issues depend on (`live`: {issues} as plan-validate-live reads them). */
export function validateOrder(order, live) {
  const { ok, edges } = classifyEdges({ order, issues: live.issues });
  if (!ok) {
    const bad = edges.filter((e) => e.state === "invalid").map((e) => `#${e.from} (${e.fromMilestone}) depends on #${e.to} (${e.toMilestone}), which is later in the train`);
    throw new Error(`train order invalid: ${bad.join("; ")}`);
  }
  return edges;
}

export function createTrain({ slugs, parallelMilestones = 1, repo = null, live, now = () => new Date().toISOString() }) {
  const order = [...new Set(slugs)];
  if (!order.length) throw new Error("train needs at least one milestone slug");
  if (!Number.isInteger(parallelMilestones) || parallelMilestones < 1) throw new Error("--parallel-milestones must be a positive integer");
  if (live) validateOrder(order, live);
  return { v: 1, repo, created: now(), parallelMilestones, order, active: [], stop: null,
    milestones: Object.fromEntries(order.map((s) => [s, { status: "pending", lifecycle: null, batch: null }])) };
}

/** Insert `slug` at the end, or before/after another; re-validates dependencies and leaves the state unchanged on a refusal. */
export function insertMilestone(state, slug, { before = null, after = null, live = null } = {}) {
  if (state.milestones[slug]) throw new Error(`milestone ${slug} is already in the train`);
  const anchor = before ?? after;
  if (anchor && !state.milestones[anchor]) throw new Error(`milestone ${anchor} is not in the train`);
  const order = [...state.order];
  order.splice(anchor ? order.indexOf(anchor) + (after ? 1 : 0) : order.length, 0, slug);
  if (live) validateOrder(order, live);
  return { ...state, order, milestones: { ...state.milestones, [slug]: { status: "pending", lifecycle: null, batch: null } } };
}

/** A milestone is ready when every earlier-in-train milestone its issues depend on is done (shipped to staging or later). */
export function readyMilestones(state, live) {
  const edges = live ? classifyEdges({ order: state.order, issues: live.issues }).edges : [];
  return state.order.filter((s) => state.milestones[s].status === "pending"
    && edges.every((e) => e.fromMilestone !== s || state.milestones[e.toMilestone]?.status === "done"));
}

/** Typed STOP reason of a failed milestone run: its rows' outcomes, else `error`. */
export function stopOf(result) {
  const outcomes = (result?.rows ?? []).map((r) => String(r.outcome ?? ""));
  const has = (re) => outcomes.find((o) => re.test(o));
  if (has(/^dependency-/)) return "dependency-unmet";
  if (has(/^needs-human/)) return "needs-human";
  if (has(/breaker/)) return "breaker";
  if (has(/budget/)) return "budget";
  if (has(/cancel/)) return "cancelled";
  return "error";
}

/**
 * Run the train until done or a STOP. `runMilestone(slug, {parallel, resume})` -> {ok, batch?, rows?, stop?}; `onBatchEnd([slug])`
 * is the #4657 lifecycle seam. Saves after every transition. A resume (state loaded from disk) clears the STOP and re-runs
 * milestones left `running` through their batch (`resume`). Never writes forge.yaml.
 * @returns {Promise<{ok: boolean, state: object}>}
 */
export async function runTrain({ train, state, runMilestone, onBatchEnd = async () => [], readLive = async () => null, caps, now = () => new Date().toISOString(), log = () => {} }) {
  state = { ...state, stop: null, active: [], milestones: { ...state.milestones } };
  for (const [s, m] of Object.entries(state.milestones)) if (m.status === "running" || m.status === "stopped") state.milestones[s] = { ...m, status: "pending", resume: m.batch };
  const save = () => train.save(state);
  const set = (slug, patch) => { state.milestones[slug] = { ...state.milestones[slug], ...patch }; };
  const running = new Map();
  const finish = async (slug) => {
    let r;
    try { r = await runMilestone(slug, { parallel: caps.perMilestone, resume: state.milestones[slug].resume ?? null, onBatch: (b) => { set(slug, { batch: b }); save(); } }); } catch (e) { r = { ok: false, stop: "error", detail: e?.message ?? String(e) }; }
    state.active = state.active.filter((s) => s !== slug);
    if (!r?.ok) { set(slug, { status: "stopped", batch: r?.batch ?? state.milestones[slug].batch }); state.stop ??= { reason: STOP_REASONS.includes(r?.stop) ? r.stop : stopOf(r), milestone: slug, detail: r?.detail ?? "", at: now() }; return save(); }
    let life = null;
    try { life = (await onBatchEnd([slug]))?.find((x) => x.title === slug) ?? null; } catch (e) { log(`train: lifecycle for ${slug}: ${e?.message ?? e}`); }
    if (life && !["shipped:staging", "deployed:default", "closed"].includes(life.state)) {
      set(slug, { status: "stopped", lifecycle: life.state });
      state.stop ??= { reason: "milestone-open", milestone: slug, detail: "open issues remain after the batch", at: now() };
    } else set(slug, { status: "done", lifecycle: life?.state ?? "shipped:staging", batch: r.batch ?? state.milestones[slug].batch });
    save();
  };
  save();
  for (;;) {
    while (!state.stop && running.size < state.parallelMilestones) {
      const next = readyMilestones(state, await readLive()).find((s) => !running.has(s));
      if (!next) break;
      set(next, { status: "running" }); state.active.push(next); save();
      log(`train: starting ${next}`);
      running.set(next, finish(next).finally(() => running.delete(next)));
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  const pending = state.order.filter((s) => state.milestones[s].status === "pending");
  if (!state.stop && pending.length) { state.stop = { reason: "dependency-unmet", milestone: pending[0], detail: `waiting on an earlier milestone: ${pending.join(", ")}`, at: now() }; save(); }
  return { ok: !state.stop, state };
}

const valueOf = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const intOf = (v, name) => { if (v == null) return null; const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`); return n; };

/**
 * `forgedock milestone train <slug...> [--parallel-milestones N] [--parallel K]` | `--resume <id>` | `--insert <id> <slug> [--before s|--after s]` | `--show <id>`.
 * deps: {root, readLive, runMilestone, onBatchEnd, globalParallel, repo, print}. Resolves {ok, id, state}.
 */
export async function trainCli(argv, deps) {
  const { root, readLive, print = (l) => console.log(l) } = deps;
  const usage = "usage: forgedock milestone train <slug...> [--parallel-milestones N] [--parallel K] [--repo owner/repo] | --resume <id> | --insert <id> <slug> [--before <slug>|--after <slug>] | --show <id>";
  const valued = new Set(["--parallel-milestones", "--parallel", "--repo", "--resume", "--before", "--after"]);
  const operands = []; for (let i = 0; i < argv.length; i++) { if (argv[i] === "--insert" || argv[i] === "--show") continue; if (valued.has(argv[i])) i++; else if (!argv[i].startsWith("--")) operands.push(argv[i]); }
  const open = (id) => { const t = openTrain(root, id); const state = t.load(); if (!state) throw new Error(`no train ${id} in ${trainRoot(root)}`); return { t, state }; };
  if (argv.includes("--show")) { const id = valueOf(argv, "--show"); const { state } = open(id); print(`train ${id}: ${state.order.map((s) => `${s}=${state.milestones[s].status}${state.milestones[s].lifecycle ? `(${state.milestones[s].lifecycle})` : ""}`).join(", ")}${state.stop ? `; STOP ${state.stop.reason} at ${state.stop.milestone}` : ""}`); return { ok: !state.stop, id, state }; }
  if (argv.includes("--insert")) {
    const id = valueOf(argv, "--insert"); const { t, state } = open(id); const slug = operands[1]; // operands[0] is the train id
    if (!slug) throw new Error(usage);
    const next = insertMilestone(state, slug, { before: valueOf(argv, "--before"), after: valueOf(argv, "--after"), live: await readLive() });
    t.save(next); print(`train ${id}: inserted ${slug}; order: ${next.order.join(", ")}`); return { ok: true, id, state: next };
  }
  let train, state, id;
  const pm = intOf(valueOf(argv, "--parallel-milestones"), "--parallel-milestones");
  if (argv.includes("--resume")) { id = valueOf(argv, "--resume"); ({ t: train, state } = open(id)); }
  else {
    if (!operands.length) throw new Error(usage);
    id = deps.id ?? newTrainId(); train = openTrain(root, id);
    if (train.exists()) throw new Error(`train ${id} already exists`);
    state = createTrain({ slugs: operands, parallelMilestones: pm ?? 1, repo: deps.repo ?? null, live: await readLive() });
  }
  const caps = resolveCaps({ requested: intOf(valueOf(argv, "--parallel"), "--parallel"), globalParallel: deps.globalParallel ?? null, parallelMilestones: pm ?? state.parallelMilestones });
  for (const w of caps.warnings) print(w);
  if (pm && argv.includes("--resume")) state = { ...state, parallelMilestones: pm };
  print(`train: ${id} (${train.file}); resume with: forgedock milestone train --resume ${id}`);
  const r = await runTrain({ train, state, runMilestone: deps.runMilestone, onBatchEnd: deps.onBatchEnd, readLive, caps, log: print });
  print(r.ok ? `train ${id}: done` : `train ${id}: STOP ${r.state.stop.reason} at ${r.state.stop.milestone}${r.state.stop.detail ? ` (${r.state.stop.detail})` : ""}; resume with: forgedock milestone train --resume ${id}`);
  return { ok: r.ok, id, state: r.state };
}
