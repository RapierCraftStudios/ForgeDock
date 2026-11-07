// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock release [--repo R] [--merge] [--watch] [--resume <id>]` (#5208): the staging -> default release as one durable,
 * resumable job. State lives in `~/.forge/releases/<id>/state.json` (or `FORGEDOCK_RELEASE_DIR`), written like a batch
 * (tmp + fsync + rename, never tmpfs). Steps run in order and each completed step is recorded, so `--resume <id>` continues
 * from the last completed one. Every effect goes through `io`, so the steps are unit-testable. Review, fixes and post-merge
 * live in release-review.mjs / release-postmerge.mjs (stubs that block until their parts land). Promotion is opt-in: without
 * `--merge` or forge.yaml `release.auto_merge: true` the job stops at GATE_PASS and prints the merge command.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomic, assertDiskPath, batchRoot, listBatches, openBatch, isLaneAlive } from "./batch.mjs";
import { readBranches, DEFAULT_STAGING_BRANCH } from "./lane.mjs";
import { ghRunner } from "./issuewatch.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";
import { reviewStep, fixStep } from "./release-review.mjs";
import { postMergeStep } from "./release-postmerge.mjs";

export const STEPS = ["preflight", "release-pr", "review", "fixes", "promotion", "post-merge"];
const ID_RE = /^r\d{8}-\d{6}-\d+$/;
const BLOCKED_EXIT = 3;

export function releaseRoot(env = process.env) {
  return env.FORGEDOCK_RELEASE_DIR || join(homedir(), ".forge", "releases");
}
export function newReleaseId(now = Date.now(), pid = process.pid) {
  return `r${new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${pid}`;
}

/** Handle on one release directory; every write is atomic. */
export function openRelease(root, id) {
  if (!ID_RE.test(String(id ?? ""))) throw new Error(`invalid release id ${JSON.stringify(id)}`);
  const file = join(root, id, "state.json");
  return {
    id, file,
    exists: () => existsSync(file),
    load: () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } },
    save: (state) => { assertDiskPath(root); mkdirSync(join(root, id), { recursive: true }); writeAtomic(file, JSON.stringify(state, null, 2) + "\n", { private: true }); },
  };
}

/** forge.yaml `release.*` of `raw`: `{autoMerge, artifactCheck, versionSync}`. */
export function readReleaseConfig(raw) {
  let r = {};
  try { r = parseForgeYaml(String(raw ?? ""))?.release ?? {}; } catch { r = {}; }
  const off = (v) => ["false", "off", "no", "0", ""].includes(String(v ?? "").trim().toLowerCase());
  return { autoMerge: !off(r.auto_merge), artifactCheck: r.artifact_check || null, versionSync: !off(r.version_sync) };
}

const json = (s) => JSON.parse(String(s || "null"));

/** The bundle list of PRs merged into `base` since the last release PR (the newest merged head->base PR). */
export async function bundleList({ io, repo, head, base }) {
  const last = json(await io.gh(["pr", "list", "--repo", repo, "--base", base, "--head", head, "--state", "merged", "--limit", "1", "--json", "mergedAt"]))?.[0]?.mergedAt;
  const merged = json(await io.gh(["pr", "list", "--repo", repo, "--base", head, "--state", "merged", "--limit", "200", "--json", "number,title,mergedAt"])) ?? [];
  return merged.filter((p) => !last || p.mergedAt > last).sort((a, b) => a.number - b.number);
}

const bundleBody = (list) => `## Release bundle\n\n${list.length ? list.map((p) => `- #${p.number} ${p.title}`).join("\n") : "_No merged PRs found since the last release._"}\n`;

async function preflightStep(ctx) {
  const { io, repo, state, staging } = ctx;
  const lanes = await io.runningLanes(repo);
  if (lanes.length) return { refused: `lanes of ${repo} are running (${lanes.map((l) => `${l.batch}#${l.issue}`).join(", ")}); wait or cancel them` };
  const open = json(await io.gh(["pr", "list", "--repo", repo, "--base", staging, "--state", "open", "--json", "number"])) ?? [];
  if (open.length) return { refused: `open PRs target ${staging}: ${open.map((p) => `#${p.number}`).join(", ")}; merge or close them first` };
  // Hold: K=1 on every unfinished batch of the repo; the previous K is recorded so it can be restored, also after a kill.
  state.held ??= [];
  for (const b of await io.batches(repo)) {
    if (state.held.some((h) => h.batch === b.id)) continue;
    state.held.push({ batch: b.id, k: b.k });
    ctx.save();
    await io.setParallel(b.id, 1);
  }
  return { held: state.held.length };
}

/** Restore every held batch to its recorded K; best effort, recorded as it goes. */
export async function restoreBatches(ctx) {
  const { io, state } = ctx;
  for (const h of state.held ?? []) {
    if (h.restored) continue;
    try { await io.setParallel(h.batch, h.k ?? 1); h.restored = true; } catch (e) { io.print(`release: could not restore K=${h.k} on batch ${h.batch}: ${e.message}`); }
  }
  ctx.save();
}

async function releasePrStep(ctx) {
  const { io, repo, staging, def } = ctx;
  const found = json(await io.gh(["pr", "list", "--repo", repo, "--base", def, "--head", staging, "--state", "open", "--json", "number,headRefOid,url"]))?.[0];
  if (found) return { pr: found.number, head: found.headRefOid, url: found.url, reused: true };
  const list = await bundleList({ io, repo, head: staging, base: def });
  const url = String(await io.gh(["pr", "create", "--repo", repo, "--base", def, "--head", staging, "--title", `Release: ${staging} -> ${def}`, "--body", bundleBody(list)])).trim();
  const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!Number.isSafeInteger(n)) throw new Error(`gh pr create returned no PR url: ${url}`);
  const v = json(await io.gh(["pr", "view", String(n), "--repo", repo, "--json", "headRefOid"]));
  return { pr: n, head: v?.headRefOid, url, reused: false, bundle: list.length };
}

/** GATE_PASS marker on the PR and the `forge/deploy-gate` conclusion at `head`. */
export async function gateState({ io, repo, pr, head }) {
  const comments = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "comments"]))?.comments ?? [];
  const bodies = comments.map((c) => String(c.body ?? ""));
  let marker = null;
  for (const b of bodies) { if (b.includes("FORGE:GATE_PASS")) marker = "pass"; else if (b.includes("FORGE:GATE_FAILURE")) marker = "failure"; }
  const checks = json(await io.gh(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", "[.check_runs[] | {name, conclusion}]"])) ?? [];
  const gate = checks.find((c) => c.name === "forge/deploy-gate");
  return { marker, deployGate: gate?.conclusion ?? null };
}

async function promotionStep(ctx) {
  const { io, repo, state, opts } = ctx;
  const { pr } = state.steps["release-pr"].result;
  const view = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"]));
  const head = view?.headRefOid;
  const gate = await gateState({ io, repo, pr, head });
  if (gate.marker !== "pass") return { stopped: true, why: `no FORGE:GATE_PASS on #${pr} (last marker: ${gate.marker ?? "none"})`, head };
  const cmd = `gh pr merge ${pr} --repo ${repo} --merge --match-head-commit ${head}`;
  if (!opts.merge && !ctx.config.autoMerge) { io.print(`GATE_PASS on #${pr}. Merge when ready:\n  ${cmd}`); return { stopped: true, why: "GATE_PASS; promotion is opt-in (--merge or release.auto_merge)", cmd, head, gate }; }
  if (gate.deployGate !== "success") return { stopped: true, why: `forge/deploy-gate is ${gate.deployGate ?? "absent"}, not success`, head, gate };
  await io.gh(["pr", "merge", String(pr), "--repo", repo, "--merge", "--match-head-commit", head]);
  return { merged: true, head, gate };
}

const STEP_FNS = {
  preflight: preflightStep,
  "release-pr": releasePrStep,
  review: (ctx) => reviewStep(ctx),
  fixes: (ctx) => fixStep(ctx),
  promotion: promotionStep,
  "post-merge": (ctx) => postMergeStep(ctx),
};

/** The step table with `over` replacing steps by name (tests stub the steps that need a real repo). */
export const withStubs = (over = {}) => ({ ...STEP_FNS, ...over });

/**
 * Run the job: each step not yet done, in order. A step result with `refused`, `blocked` or `stopped` ends the run and is not
 * marked done (the next resume retries it). Batches are restored on every exit that ends the job (finished, refused, thrown).
 * @returns {{id, status: "done"|"refused"|"blocked"|"stopped", step?, reason?}}
 */
export async function runRelease({ io, repo, opts = {}, config = {}, branches = {}, root, id, steps = STEP_FNS }) {
  const rel = openRelease(root, id);
  const state = rel.load() ?? { v: 1, id, repo, startedAt: new Date(io.now()).toISOString(), steps: {}, held: [] };
  state.opts = { merge: !!(opts.merge || state.opts?.merge) };
  const ctx = { io, repo, opts: state.opts, config, state, staging: branches.staging || DEFAULT_STAGING_BRANCH, def: branches.default || "main", save: () => rel.save(state) };
  ctx.save();
  let out;
  try {
    for (const step of STEPS) {
      if (state.steps[step]?.done) continue;
      const result = await steps[step](ctx);
      if (result?.refused) { out = { id, status: "refused", step, reason: result.refused }; break; }
      if (result?.blocked) { out = { id, status: "blocked", step, reason: result.reason }; break; }
      if (result?.stopped) { state.steps[step] = { done: false, at: new Date(io.now()).toISOString(), result }; out = { id, status: "stopped", step, reason: result.why }; break; }
      state.steps[step] = { done: true, at: new Date(io.now()).toISOString(), result };
      ctx.save();
    }
    out ??= { id, status: "done" };
  } finally {
    // A stop at GATE_PASS ends the release hold as well: nothing else is waiting on the batches.
    await restoreBatches(ctx);
  }
  state.status = out.status; ctx.save();
  return out;
}

/** Real effects. `runningLanes`/`batches` read the batch dirs of `repo` (a plan without `repo` is taken as this repo's). */
export function realIo({ env = process.env, exec = execFileSync, print = (l) => console.log(l) } = {}) {
  const gh = ghRunner(exec, print);
  const root = batchRoot(env);
  const mine = (b, repo) => { const r = b.readPlan()?.repo; return !r || r === repo; };
  const unfinished = (repo) => listBatches(root).map((id) => openBatch(root, id)).filter((b) => !b.readReport() && mine(b, repo));
  return {
    gh: (args) => gh(args), print, now: () => Date.now(),
    runningLanes: (repo) => unfinished(repo).flatMap((b) => Object.entries(b.state.load()?.lanes ?? {})
      .filter(([n, rec]) => rec?.pid && isLaneAlive(rec.pid, b.resultFile(n)) && !existsSync(b.resultFile(n)))
      .map(([n]) => ({ batch: b.id, issue: n }))),
    batches: (repo) => unfinished(repo).map((b) => ({ id: b.id, k: b.readParallel() ?? 1 })),
    setParallel: async (id, k) => {
      const { orchestrateFromCli } = await import("../engine-cli.mjs");
      await orchestrateFromCli(["--set-parallel", id, String(k)]);
    },
  };
}

const flag = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
export const RELEASE_USAGE = "usage: forgedock release [--repo owner/repo] [--merge] [--watch] [--resume <id>]";

/** `forgedock release ...`; @returns the process exit code (0 done or stopped at GATE_PASS, 1 refused, 3 blocked on a manual step). */
export async function releaseFromCli(argv, deps = {}) {
  const cwd = deps.cwd ?? process.cwd(), env = deps.env ?? process.env;
  const io = deps.io ?? realIo({ env });
  const unknown = argv.filter((a, i) => a.startsWith("--") && !["--repo", "--merge", "--watch", "--resume"].includes(a) && !(argv[i - 1] === "--resume" || argv[i - 1] === "--repo"));
  if (unknown.length) throw new Error(`unknown option ${unknown[0]}; ${RELEASE_USAGE}`);
  const root = releaseRoot(env);
  const resume = flag(argv, "--resume");
  let id = resume ?? newReleaseId(io.now());
  let repo = flag(argv, "--repo");
  if (resume) {
    const st = openRelease(root, resume).load();
    if (!st) throw new Error(`no release ${resume} in ${root}`);
    repo ??= st.repo;
  }
  repo ??= JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  let raw = ""; try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { /* no forge.yaml: defaults */ }
  const r = await runRelease({ io, repo, opts: { merge: argv.includes("--merge") }, config: readReleaseConfig(raw), branches: readBranches(cwd), root, id });
  const line = r.status === "done" ? `release ${id}: done` : `release ${id}: ${r.status} at ${r.step}: ${r.reason} (resume: forgedock release --resume ${id})`;
  io.print(line);
  return r.status === "refused" ? 1 : r.status === "blocked" ? BLOCKED_EXIT : 0;
}
