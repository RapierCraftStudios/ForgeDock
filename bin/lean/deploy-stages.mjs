// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deploy stage engine (#5712): a resumable stage machine behind forge.yaml `deploy.engine.enabled` (default off: `deployStep`
 * in release-deploy.mjs is untouched). The repo declares ordered stages; each is a host command (`run`) or a dispatched
 * workflow, so ssh/compose/k8s stay in the repo. Every stage has a checkpoint `{key, parts, status, outputs, sha}`: the key
 * hashes the stage definition, the git blobs matching its `inputs` globs, the service slice, the outputs of the stages it
 * needs (or, for a stage without outputs, that stage's key) and the live baseline. A stage is skipped only when its checkpoint is `done`, the key is unchanged and its optional
 * read-only `check` still passes; everything else re-runs, so a resume starts at the first failed or incomplete stage and a
 * fix commit re-runs only the stages whose inputs it touched.
 * A failure before traffic moves leaves the old colour serving: no shift, no hold, no rollback trigger. A failure at or after
 * the shift moves traffic back with `rollback.shift_back_command` inside `rollback.budget_s`; if that fails, the rollback
 * ladder (#5563) is triggered as before. Services with an unchanged image digest and config hash are skipped (`services.mode`:
 * shadow records what would be skipped and whether that agreed; enforce skips). Canary steps and waits come from the risk
 * class (`riskOf`). Rationale and idempotency contracts: devdocs/decisions/5712-deploy-stage-engine.md.
 */
import { createHash } from "node:crypto";
import { load, JSON_SCHEMA } from "../vendor/js-yaml/js-yaml.mjs";
import { fenced } from "./release-fence.mjs";
import { readTarget, liveMatches, freezeValue, BOUNDS } from "./release-deploy.mjs";
import { dispatchOnce } from "./release-rollback.mjs";
import { verifyStep, verifyConfigured } from "./release-verify.mjs";
import { deriveFacts, riskOf } from "./release-classify.mjs";
import { unitGlobToRegExp } from "./release-unitmap.mjs";
import { readActive, updateActive, heartbeat } from "./release-ledger.mjs";

/** Stage kinds and the idempotency contract a stage of that kind must keep (the engine may run any stage twice). */
export const KINDS = {
  build: "Content-addressed: the same inputs give the same image digests; a re-run reuses or rebuilds them and changes nothing that serves.",
  migrate: "Expand only (additive, compatible with the old colour); the migration tool skips what is already applied.",
  deploy: "Converges the idle (new) colour to the given digests; never touches the serving colour or the router; a re-run replaces the idle colour.",
  smoke: "Read-only, against the new colour's own address; moves no traffic and writes no production data.",
  shift: "Sets the new colour's share of traffic to FORGE_TRAFFIC_PCT; setting the same share again is a no-op.",
  verify: "Read-only: the live record check, the stage's own command, then the verification layers; a passed layer is not repeated.",
  retire: "Stops the old colour; a no-op when it is already stopped. After it there is no instant shift-back.",
  contract: "Contract (destructive) migrations, only after the old colour is retired; the migration tool skips what is already applied.",
  run: "Declared by the repo: the command must be safe to run twice.",
};
const READ_ONLY = ["smoke", "verify"];
export const CANARY = { low: { steps: [100], wait_s: 0 }, medium: { steps: [10, 100], wait_s: 120 }, high: { steps: [10, 50, 100], wait_s: 300 } };
export const STAGES_KEY = "deploy_stages";
export const ENGINE_KEYS = ["enabled", "live_release_command", "stage_timeout_s", "colour", "services", "canary", "rollback", "stages"];
const STAGE_KEYS = ["id", "kind", "run", "workflow", "inputs", "needs", "services", "check", "outputs_command", "timeout_s"];
const PART_NAMES = { def: "stage definition", paths: "files matching inputs", services: "service digests or config", needs: "an earlier stage it needs changed", base: "live baseline or colour" };

const blocked = (reason, extra = {}) => ({ blocked: true, reason, ...extra });
const tail = (s, n = 300) => String(s ?? "").trim().slice(-n);
const short = (s) => String(s ?? "").slice(0, 8);
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const hash = (v) => createHash("sha256").update(typeof v === "string" ? v : stable(v)).digest("hex").slice(0, 32);
const quote = (v) => `'${String(v ?? "").replace(/'/g, `'\\''`)}'`;
/** `cmd` with `env` exported in front of it: the existing `io.rehearse(cmd)` hook takes no environment. */
export const withEnv = (cmd, env) => `export ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(" ")}; ${cmd}`;
const parseJson = (s) => { try { const o = JSON.parse(String(s ?? "").trim()); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; } };

export const engineOn = (e) => !!e && e.enabled === true;
/** True when the `deploy:` section of the text has an `engine:` child (a line scan: used only when the YAML does not parse). */
function hasEngineBlock(text) {
  let inDeploy = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\S/.test(line)) inDeploy = line.startsWith("deploy:");
    else if (inDeploy && line.trimStart().startsWith("engine:")) return true;
  }
  return false;
}

/**
 * forge.yaml `deploy.engine`, or null when it is off. No git call unless the working copy turns it on; then the default
 * branch's forge.yaml wins when the file is tracked there, so a checkout of another branch cannot change the stages (I13).
 */
export function readEngine({ raw, io, def }) {
  const text = String(raw ?? "");
  if (!/^deploy:/m.test(text)) return null;
  const pick = (t) => { try { return load(String(t), { schema: JSON_SCHEMA })?.deploy?.engine ?? null; } catch (e) { return hasEngineBlock(t) ? { enabled: true, error: `forge.yaml is not valid YAML (${String(e?.message ?? e).split("\n")[0]})` } : null; } };
  let e = pick(text);
  if (!engineOn(e)) return null;
  if (io?.git && def) { let t = null; try { t = io.git(["show", `origin/${def}:forge.yaml`]); } catch { t = null; } if (t != null) e = pick(t); }
  return engineOn(e) ? e : null;
}

/** The engine block with defaults filled in. */
export function normalise(e) {
  const stages = (Array.isArray(e?.stages) ? e.stages : []).map((s) => ({ ...s, kind: s?.kind ?? "run", inputs: s?.inputs ?? ["**"] }));
  const sv = e?.services ?? {};
  return {
    stages, live_release_command: e?.live_release_command, stage_timeout_s: e?.stage_timeout_s ?? BOUNDS.defaultStageS,
    colour: { names: e?.colour?.names ?? ["blue", "green"], active_command: e?.colour?.active_command ?? null },
    services: { mode: sv.mode ?? (sv.desired_command ? "shadow" : "off"), desired_command: sv.desired_command ?? null, live_command: sv.live_command ?? null },
    canary: e?.canary ?? {},
    rollback: { budget_s: e?.rollback?.budget_s ?? 60, shift_back_command: e?.rollback?.shift_back_command ?? null, abort_command: e?.rollback?.abort_command ?? null },
  };
}

/** @returns {string[]} findings; empty when the block is a valid stage machine. */
export function validateEngine(e) {
  const out = [];
  if (e?.error) return [e.error];
  for (const k of Object.keys(e ?? {})) if (!ENGINE_KEYS.includes(k)) out.push(`${k}: unknown key`);
  const stages = e?.stages;
  if (!Array.isArray(stages) || !stages.length) return [...out, "stages: a non-empty list is required"];
  const seen = [];
  stages.forEach((s, i) => {
    const at = `stages[${i}]${s?.id ? ` (${s.id})` : ""}`;
    if (!s || typeof s !== "object") return void out.push(`${at}: expected a mapping`);
    for (const k of Object.keys(s)) if (!STAGE_KEYS.includes(k)) out.push(`${at}.${k}: unknown key`);
    if (typeof s.id !== "string" || !/^[a-z][\w-]*$/i.test(s.id)) out.push(`${at}: id is required (letters, digits, - and _)`);
    else if (seen.includes(s.id)) out.push(`${at}: duplicate id`);
    const kind = s.kind ?? "run";
    if (!(kind in KINDS)) out.push(`${at}: kind ${JSON.stringify(kind)} is not one of ${Object.keys(KINDS).join("|")}`);
    const execs = [s.run, s.workflow].filter((x) => typeof x === "string" && x.trim()).length;
    if (execs > 1 || (execs === 0 && kind !== "verify")) out.push(`${at}: exactly one of run or workflow is required`);
    for (const k of ["inputs", "needs"]) if (s[k] !== undefined && !(Array.isArray(s[k]) && s[k].every((x) => typeof x === "string"))) out.push(`${at}.${k}: expected a list of strings`);
    for (const n of Array.isArray(s.needs) ? s.needs : []) if (!seen.includes(n)) out.push(`${at}.needs: ${n} is not an earlier stage`);
    if (s.timeout_s !== undefined && !(typeof s.timeout_s === "number" && s.timeout_s > 0)) out.push(`${at}.timeout_s: expected a positive number`);
    seen.push(s.id);
  });
  const kinds = stages.map((s) => s?.kind ?? "run"), first = (k) => kinds.indexOf(k), last = (k) => kinds.lastIndexOf(k);
  if (first("verify") < 0) out.push("stages: a verify stage is required (the engine never goes live without the live check)");
  if (first("shift") >= 0) {
    if (!(first("smoke") >= 0 && first("smoke") < first("shift"))) out.push("stages: a smoke stage must come before the first shift stage (the new colour is smoked before traffic moves)");
    if (first("verify") >= 0 && last("verify") < last("shift")) out.push("stages: a verify stage must come after the last shift stage");
    if (first("deploy") > first("shift")) out.push("stages: deploy stages come before the first shift stage");
  }
  for (const k of ["retire", "contract"]) if (first(k) >= 0 && first("verify") >= 0 && first(k) < last("verify")) out.push(`stages: ${k} stages come after verify (the old colour is the rollback path until then)`);
  if (first("contract") >= 0 && first("retire") > first("contract")) out.push("stages: contract stages come after retire");
  const mode = e.services?.mode;
  if (mode !== undefined && !["off", "shadow", "enforce"].includes(mode)) out.push(`services.mode: ${JSON.stringify(mode)} is not one of off|shadow|enforce`);
  for (const [risk, c] of Object.entries(e.canary ?? {})) {
    if (risk === "health_command") continue;
    if (!(risk in CANARY)) { out.push(`canary.${risk}: unknown risk class (low|medium|high)`); continue; }
    const st = c?.steps;
    if (st !== undefined && !(Array.isArray(st) && st.length && st.every((p, i) => Number.isInteger(p) && p > 0 && p <= 100 && (i === 0 || p > st[i - 1])) && st.at(-1) === 100)) out.push(`canary.${risk}.steps: ascending percentages ending in 100`);
    if (c?.wait_s !== undefined && !(typeof c.wait_s === "number" && c.wait_s >= 0)) out.push(`canary.${risk}.wait_s: expected a number >= 0`);
  }
  const b = e.rollback?.budget_s;
  if (b !== undefined && !(typeof b === "number" && b > 0)) out.push("rollback.budget_s: expected a positive number");
  return out;
}

/** Canary steps (percent of traffic on the new colour) and the wait after each step below 100, by risk class. */
export function canaryPlan(eng, risk) {
  const c = { ...(CANARY[risk] ?? CANARY.high), ...(eng.canary?.[risk] ?? {}) };
  return { steps: c.steps, wait_s: c.wait_s };
}

/** Risk class of the deploy (`riskOf` over the files between the rollback target and `sha`); an unreadable diff is high. */
export function deployRisk(ctx, sha, target) {
  if (ctx.config.deployRisk) return { risk: ctx.config.deployRisk, rule: "config" };
  try {
    const rows = String(ctx.io.git(["diff", "--numstat", `${target}..${sha}`])).split("\n").filter(Boolean).map((l) => l.split("\t"));
    const policy = ctx.config.policy ?? {};
    return riskOf(policy, deriveFacts(policy, rows.map((r) => r[2] ?? ""), { diffLines: rows.reduce((n, r) => n + (Number(r[0]) || 0) + (Number(r[1]) || 0), 0) }));
  } catch { return { risk: "high", rule: "unreadable diff" }; }
}

const normServices = (m) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, typeof v === "string" ? { digest: v, config: null } : { digest: v?.digest ?? null, config: v?.config ?? null }]));

/**
 * Which services must be deployed. A service is unchanged only when the desired and the running side both report the same
 * image digest AND the same config hash; anything missing counts as changed (never skipped on a guess).
 * @returns {{changed: {service, why}[], unchanged: string[]}}
 */
export function diffServices(desired, live) {
  const d = normServices(desired), l = normServices(live), changed = [], unchanged = [];
  for (const s of Object.keys(d).sort()) {
    const x = d[s], y = l[s];
    const why = !x.digest ? "no desired digest reported" : !x.config ? "no config hash reported" : !y ? "not running" : y.digest !== x.digest ? "image digest changed" : y.config !== x.config ? "config changed" : null;
    if (why) changed.push({ service: s, why }); else unchanged.push(s);
  }
  return { changed, unchanged };
}

/** Hash of the git blobs at `sha` matching `globs` (`["**"]`: the tree id); unreadable history names the sha, so it never matches. */
function treeHash(io, sha, globs, cache) {
  try {
    if (globs.length === 1 && globs[0] === "**") return String(io.git(["rev-parse", `${sha}^{tree}`])).trim();
    cache.ls ??= String(io.git(["ls-tree", "-r", "-z", sha])).split("\0").filter(Boolean).map((l) => { const t = l.indexOf("\t"); return [l.slice(t + 1), l.slice(0, t).split(" ")[2]]; });
    const res = globs.map((g) => unitGlobToRegExp(String(g)));
    return hash(cache.ls.filter(([p]) => res.some((re) => re.test(p))).map(([p, oid]) => `${oid} ${p}`).join("\n"));
  } catch { return `unreadable:${sha}`; }
}

/** The hashed parts of a stage's inputs; the checkpoint key is their hash. */
export function stageParts({ stage, tree, services, needs, base }) {
  return { def: hash({ kind: stage.kind, run: stage.run ?? null, workflow: stage.workflow ?? null, check: stage.check ?? null, outputs_command: stage.outputs_command ?? null }), paths: tree, services: services == null ? "-" : hash(services), needs: hash(needs), base: hash(base) };
}
export const partsKey = (parts) => hash(parts);
/** What a later stage hashes for a stage it needs: its outputs, or, when it declares none, its key (so a changed input is never invisible downstream). */
const token = (outputs, key) => (Object.keys(outputs ?? {}).length ? outputs : { ran: key ?? null });
/** Keep the lease heartbeat fresh during a long deploy (the conductor takes over a stale lease, #5564). @returns {Promise<string|null>} why to stop */
async function beat(ctx) {
  const f = ctx.fence;
  if (!f?.lctx || !f.lease) return null;
  try { return (await heartbeat(f.lctx, f.lease)).fenced ? "fenced: another host took over the release lease" : null; } catch { return null; }
}

/** Run or skip a stage from its checkpoint. @returns {{run: boolean, why: string}} */
export function decide(cp, parts) {
  if (!cp) return { run: true, why: "no checkpoint" };
  if (cp.status !== "done") return { run: true, why: `${cp.status} last time${cp.reason ? `: ${cp.reason}` : ""}` };
  const diff = Object.keys(parts).filter((k) => cp.parts?.[k] !== parts[k]);
  if (diff.length) return { run: true, why: `inputs changed: ${diff.map((k) => PART_NAMES[k]).join(", ")}` };
  return { run: false, why: `done at ${short(cp.sha)}, inputs unchanged` };
}

/**
 * Checkpoint store. The release state (`state.deploy.stages`) always holds them; a managed release also keeps them in
 * `_active.deploy_stages` on the ledger, so the next release starts from what the last attempt finished.
 */
export function stageStore(ctx) {
  const local = () => (ctx.state.deploy.stages ??= {});
  const lctx = ctx.fence?.lctx ?? ctx.lctx ?? null;
  const shared = async (fn) => { const r = await updateActive(lctx, [STAGES_KEY], (a) => ({ patch: { [STAGES_KEY]: fn({ ...(a[STAGES_KEY] ?? {}) }) } })); if (!r.ok) throw new Error("the checkpoint write to the ledger lost the race"); };
  return {
    async load() { return lctx ? Object.assign(local(), (await readActive(lctx))[STAGES_KEY] ?? {}) : local(); },
    async put(id, cp) { local()[id] = cp; ctx.save(); if (lctx && !ctx.dry) await shared((m) => ({ ...m, [id]: cp })); },
    /** Keep the record (and its attempt count, so a workflow stage is dispatched afresh) but make the stage run again. */
    async mark(ids, status) { const hit = ids.filter((id) => local()[id]); for (const id of hit) local()[id] = { ...local()[id], status }; ctx.save(); if (lctx && !ctx.dry && hit.length) await shared((m) => ({ ...m, ...Object.fromEntries(hit.map((id) => [id, local()[id]])) })); },
    async drop(ids) { for (const id of ids) delete local()[id]; ctx.save(); if (lctx && !ctx.dry) await shared((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !ids.includes(k)))); },
  };
}

/** After a unit or full rollback the environment no longer matches any checkpoint: forget them all. */
export async function clearStages(ctx) {
  const store = ctx.stageStore ?? stageStore(ctx);
  await store.drop(Object.keys(await store.load()));
  if (ctx.state.deploy?.engine) { delete ctx.state.deploy.engine.shift; delete ctx.state.deploy.engine.dispatch; }
  ctx.save();
}

const rehearseJson = async (io, cmd, env) => { const r = await io.rehearse(withEnv(cmd, env), { timeout: 120_000 }); return r?.ok ? parseJson(String(r.output).trim().split("\n").at(-1)) : null; };

/**
 * Everything the stage loop needs that is observed, not acted on: colours, service diff, risk, checkpoints.
 * `ctx.promote` (the build-once/promote interface: `serviceDigests(sha)`, `liveDigests()`, `canPromote({service, digest, sha})`)
 * wins over the `services.*_command` pair. @returns {Promise<object | {blocked: true, reason}>}
 */
async function prepare(ctx, eng, sha, target) {
  const { io, state } = ctx, st = state.deploy ?? {}, promote = ctx.promote ?? ctx.config.promote ?? null;
  const base = { FORGE_SHA: sha, FORGE_TARGET_SHA: target?.sha ?? "", FORGE_RELEASE: state.id ?? "" };
  let colour = st.engine?.colour ?? null;
  if (!colour && eng.colour.active_command) {
    const r = await io.rehearse(withEnv(eng.colour.active_command, base), { timeout: 120_000 });
    const old = r?.ok ? String(r.output).trim().split(/\s+/).at(-1) : "";
    if (!eng.colour.names.includes(old)) return blocked(`colour.active_command did not name the serving colour (${eng.colour.names.join("|")}); nothing was deployed`);
    colour = { old, new: eng.colour.names.find((n) => n !== old) };
  }
  colour ??= { old: "", new: "" };
  const sv = { mode: eng.services.mode, changed: [], unchanged: [], active: null, desired: null };
  if (sv.mode !== "off") {
    const desired = promote?.serviceDigests ? await promote.serviceDigests(sha) : eng.services.desired_command ? await rehearseJson(io, eng.services.desired_command, base) : null;
    const live = promote?.liveDigests ? await promote.liveDigests() : eng.services.live_command ? await rehearseJson(io, eng.services.live_command, base) : null;
    if (!desired) return blocked("services: the desired digests are unreadable (services.desired_command or the promote interface); nothing was deployed");
    const diff = diffServices(desired, live ?? {}), all = Object.keys(desired).sort();
    Object.assign(sv, diff, { desired: normServices(desired), active: sv.mode === "enforce" ? diff.changed.map((c) => c.service) : all });
    if (promote?.canPromote) for (const s of sv.active) {
      const ok = await promote.canPromote({ service: s, digest: sv.desired[s].digest, sha });
      if (!ok?.ok) return blocked(`service ${s} cannot be promoted: ${ok?.why ?? "no promotion evidence"}; nothing was deployed`);
    }
  }
  const risk = deployRisk(ctx, sha, target?.sha);
  const store = ctx.stageStore ?? stageStore(ctx);
  let cps;
  try { cps = await store.load(); } catch (e) { return blocked(`cannot read the stage checkpoints (I5): ${String(e?.message ?? e).split("\n")[0]}`); }
  const kinds = eng.stages.map((s) => s.kind), shiftAt = kinds.indexOf("shift");
  const trafficAt = shiftAt >= 0 ? shiftAt : kinds.indexOf("deploy") >= 0 ? kinds.indexOf("deploy") : kinds.length;
  const env = { ...base, FORGE_COLOUR: colour.new, FORGE_OLD_COLOUR: colour.old, FORGE_RISK: risk.risk, FORGE_SERVICES: (sv.active ?? []).join(","), FORGE_SERVICES_SKIPPED: sv.mode === "enforce" ? sv.unchanged.join(",") : "" };
  return { eng, colour, sv, risk, store, cps, trafficAt, retireAt: kinds.indexOf("retire"), env, cache: {}, outputs: {}, base: { target: target?.sha ?? null, colour: colour.new } };
}

const partsFor = (ctx, x, stage, i, sha) => stageParts({
  stage, tree: treeHash(ctx.io, sha, stage.inputs, x.cache), base: x.base,
  services: stage.services && x.sv.active ? Object.fromEntries(x.sv.active.map((s) => [s, x.sv.desired[s]])) : null,
  needs: Object.fromEntries((stage.needs ?? x.eng.stages.slice(0, i).map((s) => s.id)).map((id) => [id, x.outputs[id] ?? {}])),
});

/**
 * Which stages would run for `sha` and why, without acting (`release deploy --plan`). Checks are not probed and outputs of
 * stages that will run are not known yet, so a skipped stage after one that runs is "skipped unless its outputs change".
 */
export async function planStages(ctx, sha, d = ctx.config.deploy ?? {}) {
  const bad = validateEngine(ctx.config.deployEngine);
  if (bad.length) return blocked(`deploy.engine is invalid: ${bad.join("; ")}`);
  const eng = normalise(ctx.config.deployEngine);
  ctx.state.deploy ??= {};
  const target = ctx.state.deploy.target ?? await readTarget(ctx.io, d.live_release_command ?? eng.live_release_command);
  const x = await prepare({ ...ctx, dry: true }, eng, sha, target);
  if (x.blocked) return x;
  const stages = [], rerun = [];
  eng.stages.forEach((stage, i) => {
    const cp = x.cps[stage.id], parts = partsFor(ctx, x, stage, i, sha);
    let dec = decide(cp, parts);
    if (stage.services && x.sv.mode === "enforce" && !x.sv.active.length) dec = { run: false, why: "no changed services" };
    else if (!dec.run) dec.why += `${stage.check ? "; its check is probed at run time" : ""}${rerun.length ? `; re-runs if the outputs of ${rerun.join(", ")} change` : ""}`;
    if (dec.run) rerun.push(stage.id);
    x.outputs[stage.id] = token(cp?.outputs, dec.run ? partsKey(parts) : cp?.key); // a stage that will run has no outputs yet: assume declared outputs stay as they were
    stages.push({ stage: stage.id, kind: stage.kind, run: dec.run, why: dec.why, contract: KINDS[stage.kind] });
  });
  return { sha, target: target?.sha ?? null, colour: x.colour, risk: x.risk, canary: canaryPlan(eng, x.risk.risk), services: { mode: x.sv.mode, changed: x.sv.changed, unchanged: x.sv.unchanged }, stages };
}

export function renderPlan(p) {
  const lines = [`deploy plan for ${short(p.sha)} (live ${short(p.target) || "unknown"}; risk ${p.risk.risk}, rule ${p.risk.rule}; canary ${p.canary.steps.join(" -> ")}%${p.canary.wait_s ? `, ${p.canary.wait_s}s between steps` : ""}${p.colour.new ? `; new colour ${p.colour.new}` : ""})`];
  for (const s of p.stages) lines.push(`  ${s.run ? "run " : "skip"}  ${s.stage} (${s.kind}): ${s.why}`);
  if (p.services.mode !== "off") lines.push(`  services (${p.services.mode}): ${p.services.changed.length} changed${p.services.changed.length ? ` (${p.services.changed.map((c) => `${c.service}: ${c.why}`).join("; ")})` : ""}, ${p.services.unchanged.length} unchanged${p.services.mode === "shadow" ? " (deployed anyway; the skip is only recorded)" : " (skipped)"}`);
  return lines.join("\n");
}

/** One execution of a stage's command or workflow. @returns {{ok: true, output?} | {fail: string} | {refused: string}} */
async function execStage(ctx, x, stage, env, tag, attempt) {
  const { io, state } = ctx, timeout = (stage.timeout_s ?? x.eng.stage_timeout_s) * 1000;
  const e = { ...env, FORGE_STAGE: stage.id };
  if (stage.workflow) {
    const b = { ...BOUNDS, ...(ctx.config.deployBounds ?? {}) };
    const rec = ((state.deploy.engine.dispatch ??= {})[`${tag}:${attempt}`] ??= {});
    const inputs = Object.fromEntries(Object.entries({ stage: stage.id, sha: e.FORGE_SHA, release: e.FORGE_RELEASE, colour: e.FORGE_COLOUR, old_colour: e.FORGE_OLD_COLOUR, services: e.FORGE_SERVICES, traffic_pct: e.FORGE_TRAFFIC_PCT }).filter(([, v]) => v !== undefined && v !== ""));
    const r = await dispatchOnce(ctx, rec, { workflow: stage.workflow, inputs, tag: `stage:${tag}:${attempt}`, what: `${stage.id} stage dispatch` }, { pollMs: b.pollMs, startPolls: 6, donePolls: Math.max(1, Math.ceil(timeout / b.pollMs)) });
    return r.err ? (/^dispatch refused/.test(r.err) ? { refused: r.err } : { fail: r.err }) : { ok: true, output: "" };
  }
  const act = () => io.rehearse(withEnv(stage.run, e), { timeout });
  const f = READ_ONLY.includes(stage.kind) ? { value: await act() } : await fenced(ctx.fence, { action: "stage", key: `${ctx.fence?.lease?.release ?? state.id ?? "-"}:${ctx.fence?.lease?.epoch ?? 0}:stage:${tag}:${attempt}` }, act);
  if (f.refused) return { refused: f.refused };
  return f.value?.ok ? { ok: true, output: f.value.output } : { fail: `${f.value?.timedOut ? "timed out; " : ""}${tail(f.value?.output) || "command failed"}` };
}

/** Canary: each step sets the share, waits (below 100) and checks health. Progress is kept, so a resume never restarts the wait. */
async function runShift(ctx, x, stage, key, attempt) {
  const { io, state } = ctx, eg = state.deploy.engine, plan = canaryPlan(x.eng, x.risk.risk), now = () => io.now?.() ?? Date.now();
  if (eg.shift?.key !== key) eg.shift = { key, step: 0, since: null };
  const sh = eg.shift;
  while (sh.step < plan.steps.length) {
    const pct = plan.steps[sh.step], env = { ...x.env, FORGE_TRAFFIC_PCT: String(pct) };
    if (sh.since == null) {
      eg.traffic_at ??= new Date(now()).toISOString();
      const r = await execStage(ctx, x, stage, env, `${stage.id}:${key.slice(0, 12)}:${pct}`, attempt);
      if (!r.ok) return r;
      sh.since = now(); ctx.save();
    }
    for (let wait = pct < 100 ? sh.since + plan.wait_s * 1000 - now() : 0; wait > 0; wait -= 60_000) { // sliced, so the lease stays fresh through a long wait
      await io.sleep(Math.min(wait, 60_000));
      const lost = await beat(ctx);
      if (lost) return { refused: lost };
    }
    if (x.eng.canary.health_command) {
      const h = await io.rehearse(withEnv(x.eng.canary.health_command, { ...env, FORGE_STAGE: stage.id }), { timeout: 120_000 });
      if (!h?.ok) return { fail: `canary health failed at ${pct}%: ${tail(h?.output) || "health command failed"}` };
    }
    sh.step += 1; sh.since = null; ctx.save();
  }
  return { ok: true, output: "" };
}

/** verify: the live record (I28), the stage's own command, then the verification layers (#5562). */
async function runVerify(ctx, x, stage, key, attempt, sha, d) {
  const { io, state } = ctx, st = state.deploy;
  st.phase = "LIVE_CHECK"; ctx.save();
  const live = await readTarget(io, d.live_release_command);
  if (!liveMatches(live, sha, st.expected)) return { fail: `LIVE_CHECK failed: live is ${live?.sha ? short(live.sha) : "unreadable"}, not ${short(sha)} (I28)` };
  if (stage.run || stage.workflow) { const r = await execStage(ctx, x, stage, x.env, `${stage.id}:${key.slice(0, 12)}`, attempt); if (!r.ok) return r; }
  st.phase = "VERIFYING"; ctx.save();
  if (!verifyConfigured(ctx.config.verify)) return { ok: true, output: "" };
  const v = await verifyStep({ ...ctx, rollbackTrigger: undefined }, sha); // the engine shifts back itself; the ladder is triggered only if that fails
  if (!v.blocked) return { ok: true, output: "", verify: v };
  return v.rollback ? { fail: String(v.reason).replace(/; rollback trigger emitted.*$/, "") } : { wait: v.reason, hold: v.hold };
}

async function bounded(ctx, x, cmd, extra = {}) {
  const now = () => ctx.io.now?.() ?? Date.now(), t0 = now();
  const act = () => ctx.io.rehearse(withEnv(cmd, { ...x.env, ...extra }), { timeout: x.eng.rollback.budget_s * 1000 });
  let f;
  try { f = await fenced(ctx.fence, { action: "stage-rollback", key: `${ctx.fence?.lease?.release ?? ctx.state.id ?? "-"}:${ctx.fence?.lease?.epoch ?? 0}:stage-rollback:${t0}` }, act); } catch (e) { f = { refused: String(e?.message ?? e).split("\n")[0] }; }
  return { ok: !f.refused && !!f.value?.ok, ms: now() - t0, why: f.refused ?? (f.value?.timedOut ? `did not finish within ${x.eng.rollback.budget_s}s` : tail(f.value?.output, 200) || "failed") };
}

/** What a failed stage leaves behind, by where traffic is. */
async function onFailure(ctx, x, i, stage, fail) {
  const { state } = ctx, eg = state.deploy.engine, ids = (from, to) => x.eng.stages.slice(from, to).map((s) => s.id);
  const reason = `stage ${stage.id} (${stage.kind}) failed: ${fail}`, resume = `fix it, then \`forgedock release deploy --resume ${state.id ?? "<id>"}\``;
  if (i < x.trafficAt) { // nothing serves the new code: the old colour never stopped serving
    let rb = { kind: "none", ok: true, ms: 0 };
    if (x.eng.rollback.abort_command) {
      const r = await bounded(ctx, x, x.eng.rollback.abort_command, { FORGE_STAGE: stage.id });
      rb = { kind: "abort", ok: r.ok, ms: r.ms, ...(r.ok ? {} : { why: r.why }) };
      const firstDeploy = x.eng.stages.findIndex((s) => s.kind === "deploy");
      if (firstDeploy >= 0) await x.store.mark(ids(firstDeploy), "aborted"); // the idle colour is gone (or half gone): deploy again next time
    }
    eg.last = { stage: stage.id, pre_traffic: true, rollback: rb }; ctx.save();
    return blocked(`${reason}; no traffic moved${x.colour.old ? `, ${x.colour.old} keeps serving` : ""} (no freeze, no hold); ${resume}`, { preTraffic: true, stage: stage.id, engine: eg.last });
  }
  if (x.retireAt >= 0 && i >= x.retireAt) { // the old colour is stopped (or half stopped): roll forward
    eg.last = { stage: stage.id, pre_traffic: false, rollback: { kind: "none", ok: false, why: "old colour retired" } }; ctx.save();
    return blocked(`${reason}; the old colour is retired, so there is no shift-back (owner ask: roll forward, or run the rollback ladder; label needs-agent when no host is attached)`, { stage: stage.id, hold: { kind: "deploy-engine", label: "needs-agent" }, engine: eg.last });
  }
  const sb = x.eng.rollback.shift_back_command ? await bounded(ctx, x, x.eng.rollback.shift_back_command, { FORGE_TRAFFIC_PCT: "0", FORGE_STAGE: stage.id }) : { ok: false, ms: 0, why: "rollback.shift_back_command is not set" };
  await x.store.mark(ids(x.trafficAt), "rolled-back"); // traffic is back on the old colour (or its state is unknown): shift and everything after it start over
  delete eg.shift; delete state.verify;
  eg.last = { stage: stage.id, pre_traffic: false, rollback: { kind: "shift-back", ok: sb.ok, ms: sb.ms, ...(sb.ok ? {} : { why: sb.why }) } }; ctx.save();
  if (sb.ok) return blocked(`${reason}; traffic shifted back${x.colour.old ? ` to ${x.colour.old}` : ""} in ${sb.ms} ms; ${resume}`, { rolledBack: true, stage: stage.id, engine: eg.last });
  ctx.rollbackTrigger?.({ reason, sha: state.deploy.merge });
  return blocked(`${reason}; shift-back failed (${sb.why}); rollback trigger emitted to the ladder (#5563)`, { stage: stage.id, rollback: { reason }, engine: eg.last });
}

/**
 * Run the stage machine for `sha` (called by `deployStep` once the rollback target is recorded, I9).
 * @returns {Promise<{live: true, merge, run: null, reruns: 0, engine}|{blocked: true, reason, preTraffic?, rolledBack?, hold?, rollback?}>}
 */
export async function runStages(ctx, sha, d) {
  const { io, repo, state } = ctx, st = state.deploy, now = () => io.now?.() ?? Date.now();
  const bad = validateEngine(ctx.config.deployEngine);
  if (bad.length) return blocked(`deploy.engine is invalid: ${bad.join("; ")}; nothing was deployed`);
  const eng = normalise(ctx.config.deployEngine);
  if (await freezeValue(io, repo, d.freeze_variable)) return blocked(`${d.freeze_variable} is set; the engine never deploys while a freeze is set (I26)`);
  const eg = (st.engine ??= { started_at: new Date(now()).toISOString() });
  if (st.merge !== sha) { // a fix commit (--sha): verified from scratch, against its own expected digests
    if (d.expected_digests_command) {
      const r = await io.rehearse(withEnv(d.expected_digests_command, { FORGE_SHA: sha }), { timeout: 120_000 });
      st.expected = r?.ok ? parseJson(r.output) : null;
      if (!st.expected) return blocked("deploy.expected_digests_command returned no digests for the new sha; nothing was deployed");
    }
    delete state.verify; st.merge = sha;
  }
  st.phase = "DEPLOYING"; ctx.save();
  const x = await prepare(ctx, eng, sha, st.target);
  if (x.blocked) return x;
  eg.colour = x.colour; eg.risk = x.risk;
  if (x.sv.mode !== "off") st.services = { mode: x.sv.mode, changed: x.sv.changed, [x.sv.mode === "enforce" ? "skipped" : "would_skip"]: x.sv.unchanged };
  ctx.save();

  const log = [];
  let drift = null, verify = null;
  for (const [i, stage] of eng.stages.entries()) {
    const parts = partsFor(ctx, x, stage, i, sha), key = partsKey(parts), cp = x.cps[stage.id];
    let dec = drift ? { run: true, why: `the environment drifted at ${drift}` } : decide(cp, parts);
    if (!dec.run && stage.check) { // observe before trusting a checkpoint: the effect must still hold
      const c = await io.rehearse(withEnv(stage.check, { ...x.env, FORGE_STAGE: stage.id }), { timeout: 120_000 });
      if (!c?.ok) { drift = stage.id; dec = { run: true, why: "its check failed: the recorded effect no longer holds" }; }
    }
    if (dec.run && stage.services && x.sv.mode === "enforce" && !x.sv.active.length) dec = { run: false, why: "no changed services" };
    if (!dec.run) { x.outputs[stage.id] = token(cp?.outputs, cp?.key); log.push({ stage: stage.id, run: false, why: dec.why }); io.print?.(`deploy ${stage.id}: skipped (${dec.why})`); continue; }
    const attempt = (cp && cp.status !== "done" && cp.key === key ? cp.attempt ?? 1 : 0) + 1, t0 = now();
    const lost = await beat(ctx);
    if (lost) return blocked(`stage ${stage.id}: ${lost}`);
    st.stage = stage.id; st.attempt = attempt; ctx.save();
    io.print?.(`deploy ${stage.id}: running (${dec.why})`);
    let r;
    try {
      r = stage.kind === "shift" ? await runShift(ctx, x, stage, key, attempt)
        : stage.kind === "verify" ? await runVerify(ctx, x, stage, key, attempt, sha, d)
        : await execStage(ctx, x, stage, x.env, `${stage.id}:${key.slice(0, 12)}`, attempt);
    } catch (e) { r = { fail: String(e?.message ?? e).split("\n")[0] }; }
    const rec = { key, parts, sha, release: state.id ?? null, at: new Date(now()).toISOString(), ms: now() - t0, attempt };
    if (r.refused) return blocked(`stage ${stage.id}: ${r.refused}`);
    if (r.wait) return blocked(`stage ${stage.id}: ${r.wait}`, r.hold ? { hold: r.hold } : {});
    if (!r.ok) {
      await x.store.put(stage.id, { ...rec, status: "failed", reason: tail(r.fail, 200) });
      return onFailure(ctx, x, i, stage, r.fail);
    }
    let outputs = {};
    if (stage.outputs_command) outputs = (await rehearseJson(io, stage.outputs_command, { ...x.env, FORGE_STAGE: stage.id })) ?? {};
    else if (stage.run && stage.kind !== "shift") outputs = parseJson(String(r.output ?? "").trim().split("\n").at(-1)) ?? {};
    x.outputs[stage.id] = token(outputs, key);
    if (r.verify) verify = r.verify;
    await x.store.put(stage.id, { ...rec, status: "done", outputs });
    log.push({ stage: stage.id, run: true, why: dec.why, ms: rec.ms });
  }

  if (x.sv.mode === "shadow" && x.sv.unchanged.length) { // would the skip have been right? the full redeploy must leave those services as they were
    const promote = ctx.promote ?? ctx.config.promote;
    const live = promote?.liveDigests ? await promote.liveDigests() : eng.services.live_command ? await rehearseJson(io, eng.services.live_command, x.env) : null;
    const dis = live ? diffServices(Object.fromEntries(x.sv.unchanged.map((s) => [s, x.sv.desired[s]])), live).changed : null;
    st.services.agreement = dis ? { agree: x.sv.unchanged.length - dis.length, disagree: dis } : { unreadable: true };
  }
  delete eg.last; delete st.stage;
  st.phase = "LIVE"; ctx.save();
  const ran = log.filter((l) => l.run).map((l) => l.stage);
  io.print?.(`release: live at ${short(sha)} (deploy engine: ran ${ran.join(", ") || "nothing"}; skipped ${log.length - ran.length})`);
  return { live: true, merge: sha, run: null, reruns: 0, engine: { stages: log }, ...(verify ? { verify } : {}) };
}

const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/**
 * `forgedock release deploy --plan [<id>] [--sha S] [--json]` (read-only) and `forgedock release deploy --resume <id> [--sha S]`.
 * `--sha` names a default-branch commit that contains the release's merge (a fix that landed after it), deployed under the
 * same release record. @returns {Promise<number | {resume: string, sha: string|null}>} an exit code, or the resume to run.
 */
export async function deployFromCli(argv, { io, load, engine, config = {}, def, repo, lctx }) {
  const say = (l) => io.print(l);
  const vals = ["--sha", "--repo", "--resume", "--lane"], id = flagOf(argv, "--resume") ?? argv.find((a, i) => !a.startsWith("--") && !vals.includes(argv[i - 1])) ?? null;
  const plan = argv.includes("--plan"), resume = argv.includes("--resume");
  if (plan === resume) { say("release deploy: pass exactly one of --plan or --resume <id>"); return 1; }
  if (!engine) { say("release deploy: forge.yaml deploy.engine.enabled is not on; nothing to plan or resume (use `forgedock release --resume <id>`)"); return 1; }
  const state = id ? await load(id) : null;
  if (id && !state) { say(`release deploy: no release ${id}`); return 1; }
  const merged = state?.steps?.["post-merge"]?.result?.merge ?? state?.deploy?.merge ?? null;
  let sha = flagOf(argv, "--sha");
  if (sha) {
    try {
      sha = String(io.git(["rev-parse", "--verify", `${sha}^{commit}`])).trim();
      io.git(["merge-base", "--is-ancestor", sha, `origin/${def}`]);
      if (merged) io.git(["merge-base", "--is-ancestor", merged, sha]);
    } catch { say(`release deploy: --sha must be a commit on origin/${def}${merged ? ` that contains the release merge ${short(merged)}` : ""}`); return 1; }
  }
  if (resume) {
    if (!id) { say("release deploy: --resume needs a release id"); return 1; }
    if (!merged) { say(`release deploy: release ${id} is not merged yet; use \`forgedock release --resume ${id}\``); return 1; }
    return { resume: id, sha: sha ?? null };
  }
  try { sha ??= state?.deploy?.merge ?? merged ?? String(io.git(["rev-parse", `origin/${def}`])).trim(); } catch { say(`release deploy: cannot resolve origin/${def}`); return 1; }
  const p = await planStages({ io, repo, def, lctx, state: structuredClone(state ?? {}), save() {}, config: { ...config, deployEngine: engine } }, sha);
  if (p.blocked) { say(`release deploy: ${p.reason}`); return 1; }
  say(argv.includes("--json") ? JSON.stringify(p) : renderPlan(p));
  return 0;
}
