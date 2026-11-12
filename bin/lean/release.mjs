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
import { rehearsalStep, parseRehearsalConfig } from "./release-rehearsal.mjs";
import { budgetReportLine, releaseRuns } from "./ci-budget.mjs";
import { cutSnapshot, writeRecord, checkChain, verifyRelease, DEFAULT_PATTERN } from "./release-snapshot.mjs";
import { createReleaseLedger, writeRelease, readLedger, acquireLease, heartbeat } from "./release-ledger.mjs";
import { fenced, epochTrailer } from "./release-fence.mjs";
import { hostPreflightStep, markReadyStep, parsePreflightConfig } from "./release-preflight.mjs";

export const RELEASE_STEPS = ["preflight", "host-preflight", "release-pr", "review", "fixes", "mark-ready", "rehearsal", "promotion", "post-merge"];
const ID_RE = /^r\d{8}-\d{6}-\d+$/;
const BLOCKED_EXIT = 3;

export function releaseRoot(env = process.env) {
  return env.FORGEDOCK_RELEASE_DIR || join(homedir(), ".forge", "releases");
}
export function newReleaseId(now = Date.now(), pid = process.pid) {
  return `r${new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${pid}`;
}

/** Handle on one release directory; every write is atomic. */
export function openRelease(root, id, mounts) {
  if (!ID_RE.test(String(id ?? ""))) throw new Error(`invalid release id ${JSON.stringify(id)}`);
  const file = join(root, id, "state.json");
  return {
    id, file,
    exists: () => existsSync(file),
    load: () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } },
    save: (state) => { assertDiskPath(root, mounts); mkdirSync(join(root, id), { recursive: true }); writeAtomic(file, JSON.stringify(state, null, 2) + "\n", { private: true }); },
  };
}

/** forge.yaml `release.*` of `raw`: `{autoMerge, artifactCheck, versionSync, publishWorkflow, rehearsal, preflight, mode, branchPattern, fixMode}` (#5253, #5276, #5277). */
export function readReleaseConfig(raw) {
  let r = {};
  try { r = parseForgeYaml(String(raw ?? ""))?.release ?? {}; } catch { r = {}; }
  const off = (v) => ["false", "off", "no", "0", ""].includes(String(v ?? "").trim().toLowerCase());
  return { autoMerge: !off(r.auto_merge), artifactCheck: r.artifact_check || null, versionSync: !off(r.version_sync), publishWorkflow: r.publish_workflow || null, ...(r.managed !== undefined && !off(r.managed) ? { managed: true } : {}), ...optKeys(r), ...snapshotKeys(r) };
}

/** `{mode, branchPattern, fixMode}` only when configured (#5276): mode `snapshot` cuts release/<id>; anything else is `freeze`. */
const snapshotKeys = (r) => {
  const pick = (v, ok, dflt) => (ok.includes(String(v).trim().toLowerCase()) ? String(v).trim().toLowerCase() : dflt);
  return {
    ...(r.mode ? { mode: pick(r.mode, ["snapshot", "freeze"], "freeze") } : {}),
    ...(r.branch_pattern ? { branchPattern: String(r.branch_pattern) } : {}),
    ...(r.fix_mode ? { fixMode: pick(r.fix_mode, ["cherry-pick", "recut"], "cherry-pick") } : {}),
  };
};
export const isSnapshot = (config) => config?.mode === "snapshot";

/** `{rehearsal}` / `{preflight}` only when configured, so the config of a repo without them keeps its shape. */
const optKeys = (r) => { const rehearsal = parseRehearsalConfig(r), preflight = parsePreflightConfig(r); return { ...(rehearsal ? { rehearsal } : {}), ...(preflight ? { preflight } : {}) }; };

const json = (s) => JSON.parse(String(s || "null"));

/** The bundle list of PRs merged into `base` since the last release PR (the newest merged head->base PR). */
export async function bundleList({ io, repo, head, base }) {
  const last = json(await io.gh(["pr", "list", "--repo", repo, "--base", base, "--head", head, "--state", "merged", "--limit", "1", "--json", "mergedAt"]))?.[0]?.mergedAt;
  const merged = json(await io.gh(["pr", "list", "--repo", repo, "--base", head, "--state", "merged", "--limit", "200", "--json", "number,title,mergedAt,closingIssuesReferences"])) ?? [];
  return merged.filter((p) => !last || p.mergedAt > last).sort((a, b) => a.number - b.number);
}

const bundleBody = (list) => `## Release bundle\n\n${list.length ? list.map((p) => `- #${p.number} ${p.title}`).join("\n") : "_No merged PRs found since the last release._"}\n`;

async function preflightStep(ctx) {
  const { io, repo, state, staging } = ctx;
  // Snapshot mode: lanes keep merging to staging; the release is cut from a fixed SHA, so nothing is refused or held (#5276).
  if (isSnapshot(ctx.config)) return { snapshot: true, held: 0 };
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

/** Snapshot mode: cut release/<id> (once; a resume reuses the recorded branch) and open release/<id> -> default. */
async function snapshotPrStep(ctx) {
  const { io, repo, staging, def, state } = ctx;
  if (!io.git) throw new Error("snapshot releases need io.git");
  if (!state.release) {
    const bundle = await bundleList({ io, repo, head: staging, base: def });
    const cut = await cutSnapshot({ io, git: io.git, repo, staging, def, pattern: ctx.config.branchPattern ?? DEFAULT_PATTERN, id: state.id, bundle });
    if (cut.refused) return { refused: cut.refused };
    state.release = cut.record; state.releaseBundle = bundle;
    ctx.save();
  }
  const { branch } = state.release;
  const found = json(await io.gh(["pr", "list", "--repo", repo, "--base", def, "--head", branch, "--state", "open", "--json", "number,headRefOid,url"]))?.[0];
  if (found) return { pr: found.number, head: found.headRefOid, url: found.url, reused: true, branch };
  const list = state.releaseBundle ?? [];
  const url = String(await io.gh(["pr", "create", "--repo", repo, "--base", def, "--head", branch, "--title", `Release: ${branch} -> ${def}`, "--body", bundleBody(list)])).trim();
  const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!Number.isSafeInteger(n)) throw new Error(`gh pr create returned no PR url: ${url}`);
  state.steps["release-pr"] = { done: false, result: { pr: n } }; // writeRecord reads the PR number from here
  await writeRecord(ctx);
  const v = json(await io.gh(["pr", "view", String(n), "--repo", repo, "--json", "headRefOid"]));
  return { pr: n, head: v?.headRefOid, url, reused: false, bundle: list.length, branch };
}

async function releasePrStep(ctx) {
  if (isSnapshot(ctx.config)) return snapshotPrStep(ctx);
  const { io, repo, staging, def } = ctx;
  const found = json(await io.gh(["pr", "list", "--repo", repo, "--base", def, "--head", staging, "--state", "open", "--json", "number,headRefOid,url"]))?.[0];
  if (found) return { pr: found.number, head: found.headRefOid, url: found.url, reused: true };
  const list = await bundleList({ io, repo, head: staging, base: def });
  const url = String(await io.gh(["pr", "create", "--repo", repo, "--base", def, "--head", staging, "--title", `Release: ${staging} -> ${def}`, "--body", bundleBody(list), ...(ctx.config.preflight ? ["--draft"] : [])])).trim();
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
  let gate = checks.find((c) => c.name === "forge/deploy-gate");
  // gate-marker-check.yml posts forge/deploy-gate as a commit STATUS (POST /statuses), not a check run: read the
  // combined status too, or promotion never sees the gate it waits for.
  if (!gate) {
    const statuses = json(await io.gh(["api", `repos/${repo}/commits/${head}/status`, "--jq", "[.statuses[] | {name: .context, conclusion: .state}]"])) ?? [];
    gate = statuses.find((c) => c.name === "forge/deploy-gate");
  }
  return { marker, deployGate: gate?.conclusion ?? null };
}

const GATE_POLLS = 12, GATE_POLL_MS = 10_000;

/** Re-run the newest gate-marker-check run on `head`: the bot's GATE_PASS comment never triggers it, so the status would stay pending. */
async function retriggerGate({ io, repo, head, fence }) {
  try {
    const runs = json(await io.gh(["run", "list", "--repo", repo, "--workflow", "gate-marker-check.yml", "--commit", head, "--json", "databaseId", "--limit", "1"])) ?? [];
    if (!runs[0]?.databaseId) return null;
    const f = await fenced(fence, { action: "rerun", key: `rerun:${runs[0].databaseId}` }, () => io.gh(["run", "rerun", String(runs[0].databaseId), "--repo", repo]));
    return f.refused ?? null; // #5553: a fenced host stops here
  } catch { return null; /* a run still in progress cannot be rerun, and it re-reads the markers anyway: just wait */ }
}

/** Re-trigger the gate, then poll (bounded) until `forge/deploy-gate` is success or failure; @returns the last gateState. */
async function awaitGate({ io, repo, pr, head, gate, fence }) {
  const refused = await retriggerGate({ io, repo, head, fence });
  if (refused) return { ...gate, fenced: refused };
  for (let i = 0; i < GATE_POLLS && gate.deployGate !== "success" && gate.deployGate !== "failure"; i++) {
    await io.sleep(GATE_POLL_MS);
    gate = await gateState({ io, repo, pr, head });
  }
  return gate;
}

async function promotionStep(ctx) {
  const { io, repo, state, opts } = ctx;
  const { pr } = state.steps["release-pr"].result;
  const view = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "state,mergeCommit,headRefOid"]));
  const head = view?.headRefOid;
  // Already merged (by hand, or by a crashed --merge run): hand the merge sha to post-merge; never gate or merge again.
  if (view?.state === "MERGED" && view?.mergeCommit?.oid) return { merged: true, alreadyMerged: true, mergeCommit: view.mergeCommit.oid, head };
  if (view?.state === "CLOSED") return { stopped: true, why: `release PR #${pr} was closed without merging`, head };
  if (state.release) {
    const chain = checkChain({ git: io.git, record: state.release, sha: head, staging: ctx.staging, exact: true });
    if (!chain.ok) return { stopped: true, why: `release head ${head} is not snapshot + recorded cherry-picks: ${chain.why}`, head };
  }
  let gate = await gateState({ io, repo, pr, head });
  if (gate.marker !== "pass") return { stopped: true, why: `no FORGE:GATE_PASS on #${pr} (last marker: ${gate.marker ?? "none"})`, head };
  if (gate.deployGate !== "success" && gate.deployGate !== "failure") gate = await awaitGate({ io, repo, pr, head, gate, fence: ctx.fence });
  if (gate.fenced) return { refused: gate.fenced, head };
  const cmd = `gh pr merge ${pr} --repo ${repo} --merge --match-head-commit ${head}`;
  if (!opts.merge && !ctx.config.autoMerge) { io.print(`GATE_PASS on #${pr}. Merge when ready:\n  ${cmd}`); return { stopped: true, why: "GATE_PASS; promotion is opt-in (--merge or release.auto_merge)", cmd, head, gate }; }
  if (gate.deployGate !== "success") return { stopped: true, why: `forge/deploy-gate is ${gate.deployGate ?? "absent"}, not success${gate.deployGate === "failure" ? "" : ` after ${GATE_POLLS} polls`}`, head, gate };
  const f = await fenced(ctx.fence, { action: "merge", key: `merge:${pr}:${head}` }, (epoch) => io.gh(["pr", "merge", String(pr), "--repo", repo, "--merge", "--match-head-commit", head, ...(epoch != null ? ["--body", epochTrailer(epoch)] : [])]));
  if (f.refused) return { refused: f.refused, head, gate };
  return { merged: true, head, gate };
}

const OPTIONAL_STEPS = ["host-preflight", "mark-ready"];

const STEP_FNS = {
  preflight: preflightStep,
  "host-preflight": hostPreflightStep,
  "release-pr": releasePrStep,
  review: (ctx) => reviewStep(ctx),
  fixes: (ctx) => fixStep(ctx),
  "mark-ready": markReadyStep,
  rehearsal: (ctx) => rehearsalStep(ctx),
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
export async function runRelease({ io, repo, opts = {}, config = {}, branches = {}, root, id, steps = STEP_FNS, mounts }) {
  const rel = openRelease(root, id, mounts);
  // #5550: managed releases read the ledger first (it is authoritative; the local file is a cache); off = no ledger call at all.
  const lctx = config.managed && io.api ? { io, repo, credential: "driver" } : null;
  const led = lctx ? await readLedger(lctx, id) : null;
  if (led?.rejected) return { id, status: "refused", step: "ledger", reason: `ledger of ${id} rejected: ${led.rejected}` };
  let ledgerHead = led?.head ?? null;
  const mirror = async (s) => { // best effort: a lost race means another writer owns the release, which stops this run
    const r = ledgerHead ? await writeRelease(lctx, id, s, ledgerHead) : await createReleaseLedger(lctx, id, s);
    if (r.ok) ledgerHead = r.sha; else throw new Error(`release ${id}: ledger write lost the race (another writer holds the release)`);
  };
  const state = led?.state ?? rel.load() ?? { v: 1, id, repo, startedAt: new Date(io.now()).toISOString(), steps: {}, held: [] };
  state.opts = { merge: !!(opts.merge || state.opts?.merge) };
  const holder = io.holder ?? `host-${process.pid}`;
  const takeLease = async () => { // #5553: the epoch fences every irreversible effect; the release PR carries the heartbeat comment
    const l = await acquireLease(lctx, { holder, release: id, issue: state.steps["release-pr"].result.pr, ttlS: config.leaseTtlS ?? 120, now: io.now() });
    if (!l.ok) return l.refused ?? "lease lost the race";
    const record = async (rec) => { const a = (state.intents ??= []); const i = a.findIndex((x) => x.key === rec.key); if (i < 0) a.push(rec); else a[i] = rec; ctx.save(); await mirror(state); };
    ctx.fence = { lctx, lease: l.lease, record, now: () => new Date(io.now()).toISOString() };
    return null;
  };
  const ctx = { io, repo, opts: state.opts, config, state, staging: branches.staging || DEFAULT_STAGING_BRANCH, def: branches.default || "main", git: io.git, save: () => rel.save(state) };
  ctx.save();
  let out;
  try {
    for (const step of RELEASE_STEPS) {
      if (state.steps[step]?.done) continue;
      if (lctx && !ctx.fence && state.steps["release-pr"]?.done) { const why = await takeLease(); if (why) { out = { id, status: "refused", step: "lease", reason: why }; break; } }
      const result = await steps[step](ctx);
      if (result?.refused) { out = { id, status: "refused", step, reason: result.refused }; break; }
      if (result?.blocked) { out = { id, status: "blocked", step, reason: result.reason }; break; }
      if (result?.skipped && OPTIONAL_STEPS.includes(step)) continue; // unconfigured: leaves no trace in the state
      if (result?.stopped) { state.steps[step] = { done: false, at: new Date(io.now()).toISOString(), result }; out = { id, status: "stopped", step, reason: result.why }; break; }
      state.steps[step] = { done: true, at: new Date(io.now()).toISOString(), result };
      ctx.save();
      if (lctx) await mirror(state);
      if (lctx && !ctx.fence && step === "release-pr") { const why = await takeLease(); if (why) { out = { id, status: "refused", step: "lease", reason: why }; break; } }
      if (ctx.fence) { // an unreadable _active ends the run too (I5): the next irreversible step would refuse anyway
        const hb = await heartbeat(lctx, ctx.fence.lease).catch((e) => ({ unreadable: e.message }));
        if (hb.fenced || hb.unreadable) { out = { id, status: "refused", step, reason: hb.fenced ? "fenced: another host took over the release lease" : `cannot read _active (${hb.unreadable})` }; break; }
      }
    }
    out ??= { id, status: "done" };
  } finally {
    // A stop at GATE_PASS ends the release hold as well: nothing else is waiting on the batches.
    await restoreBatches(ctx);
  }
  state.status = out.status; ctx.save();
  if (lctx) await mirror(state);
  return out;
}

/** Real effects. `runningLanes`/`batches` read the batch dirs of `repo` (a plan without `repo` is taken as this repo's). */
export function realReleaseIo({ env = process.env, exec = execFileSync, print = (l) => console.log(l), cwd = process.cwd() } = {}) {
  const gh = ghRunner(exec, print);
  const root = batchRoot(env);
  const mine = (b, repo) => { const r = b.readPlan()?.repo; return !r || r === repo; };
  const unfinished = (repo) => listBatches(root).map((id) => openBatch(root, id)).filter((b) => !b.readReport() && mine(b, repo));
  return {
    gh: (args) => gh(args), print,
    api: (method, path, body) => { // JSON in and out for the ledger (#5550); the error carries the HTTP status
      try { return JSON.parse(String(exec("gh", ["api", "-X", method, path, ...(body ? ["--input", "-"] : [])], { encoding: "utf8", input: body ? JSON.stringify(body) : undefined, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", "pipe"] })) || "null"); }
      catch (e) { throw Object.assign(new Error(`gh api ${method} ${path} failed: ${String(e?.stderr ?? e?.message ?? e).split("\n")[0]}`), { status: Number(/HTTP (\d{3})/.exec(String(e?.stderr ?? ""))?.[1]) || undefined }); }
    }, now: () => Date.now(),
    git: (args, { env: extra, input } = {}) => exec("git", args, { cwd, encoding: "utf8", input, env: { ...env, ...extra }, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", "pipe"] }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    run: async (cmd) => { try { exec("sh", ["-c", cmd], { stdio: "ignore", timeout: 120_000 }); return { ok: true }; } catch { return { ok: false }; } },
    rehearse: async (cmd, { timeout } = {}) => {
      try { return { ok: true, code: 0, output: String(exec("sh", ["-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 << 20 })) }; }
      catch (e) { return { ok: false, code: e.status ?? null, timedOut: e.code === "ETIMEDOUT", output: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message) }; }
    },
    runningLanes: (repo) => unfinished(repo).flatMap((b) => Object.entries(b.store.load()?.lanes ?? {})
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
export const RELEASE_USAGE = "usage: forgedock release [--repo owner/repo] [--merge] [--watch] [--resume <id>] | forgedock release verify <sha> [--repo owner/repo] | forgedock release check-config [--ref <git ref>] | forgedock release init";

/** `forgedock release ...`; @returns the process exit code (0 done or stopped at GATE_PASS, 1 refused, 3 blocked on a manual step). */
export async function releaseFromCli(argv, deps = {}) {
  const cwd = deps.cwd ?? process.cwd(), env = deps.env ?? process.env;
  const io = deps.io ?? realReleaseIo({ env, cwd });
  if (argv[0] === "verify") return verifyFromCli(argv.slice(1), { io, cwd });
  if (argv[0] === "check-config" || argv[0] === "init") { // #5551: policy file, loaded lazily (release-config imports this module)
    const { checkConfigFromCli, initFromCli } = await import("./release-config.mjs");
    return (argv[0] === "init" ? initFromCli : checkConfigFromCli)(argv.slice(1), { io, cwd });
  }
  const unknown = argv.filter((a, i) => a.startsWith("--") && !["--repo", "--merge", "--watch", "--resume"].includes(a) && !(argv[i - 1] === "--resume" || argv[i - 1] === "--repo"));
  if (unknown.length) throw new Error(`unknown option ${unknown[0]}; ${RELEASE_USAGE}`);
  const root = releaseRoot(env);
  const resume = flag(argv, "--resume");
  let id = resume ?? newReleaseId(io.now());
  let repo = flag(argv, "--repo");
  let raw = ""; try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { /* no forge.yaml: defaults */ }
  const config = readReleaseConfig(raw);
  if (resume) {
    const st = openRelease(root, resume).load();
    if (!st && !config.managed) throw new Error(`no release ${resume} in ${root}`); // managed: the ledger may hold it (another host)
    repo ??= st?.repo;
  }
  repo ??= JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const budget = async (since) => { // #5278: the Actions-minutes line (and any auto switch to local-first); never fails the job
    try { io.print(await budgetReportLine({ cwd, repo, gh: (a) => io.gh(a), now: io.now(), release: since ? await releaseRuns({ gh: (a) => io.gh(a), repo, sinceMs: since }) : null })); } catch { /* best effort */ }
  };
  await budget(null);
  const r = await runRelease({ io, repo, opts: { merge: argv.includes("--merge") }, config, branches: readBranches(cwd), root, id, mounts: deps.mounts });
  const line = r.status === "done" ? `release ${id}: done` : `release ${id}: ${r.status} at ${r.step}: ${r.reason} (resume: forgedock release --resume ${id})`;
  io.print(line);
  try { await budget(Date.parse(openRelease(root, id).load()?.startedAt) || null); } catch { /* best effort */ }
  return r.status === "refused" ? 1 : r.status === "blocked" ? BLOCKED_EXIT : 0;
}

/** `forgedock release verify <sha> [--repo R]`: exit 0 when the release head is the snapshot plus its recorded cherry-picks of staging commits, else 1. */
async function verifyFromCli(argv, { io, cwd }) {
  const sha = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--repo");
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`release verify needs a commit sha; ${RELEASE_USAGE}`);
  const repo = flag(argv, "--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const full = io.git(["rev-parse", sha]).trim();
  const r = await verifyRelease({ io, git: io.git, repo, staging: readBranches(cwd).staging || DEFAULT_STAGING_BRANCH, sha: full });
  io.print(r.ok ? `release verify ${full}: ok (snapshot + ${r.picks} cherry-pick(s), PR #${r.pr})` : `release verify ${full}: FAILED: ${r.why}`);
  return r.ok ? 0 : 1;
}
