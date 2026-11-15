// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Build once, promote (#5711, Forge CI W5): CI evidence bound to a commit, a tree and the image digests, so the deploy side
 * can skip re-running what already passed. Off unless forge.yaml `deploy.promote.enabled` is true; `shadow` (default true)
 * records what WOULD be skipped while the full pre-gate still runs.
 *
 * - Attestation: `{commit, tree, images, checks, config_hash}`, written only when every required check concluded `success`
 *   on the exact commit. It is the output of a `forge/promote-evidence` check run on that commit (the register
 *   `forge/release-gate` already uses): GitHub binds it to the sha, and it is accepted only from `evidence_app`.
 * - `canPromote(evidence, target) -> {ok, reasons}` is pure and fails closed: the same tree, every required check passed,
 *   the same digests and the same config hash, else the full pre-gate runs (never weaker).
 * - `planImages` is pure planning (no docker): an unchanged service reuses its previous digest, the others get buildx
 *   args with a registry layer cache and the configured cache mounts.
 * Every effect goes through `io.api(method, path, body?)`, `io.gh(args)` and `io.git(args)`. Rationale: devdocs/decisions/5711-release-promote.md.
 */
import { createHash } from "node:crypto";
import { load, JSON_SCHEMA } from "../vendor/js-yaml/js-yaml.mjs";
import { matchesAny } from "./release-unitmap.mjs";
import { evidenceSkips, catalogueAt, parseCatalogue, parseGatesConfig } from "./release-gates.mjs";

export const EVIDENCE_CHECK = "forge/promote-evidence";
export const DECISION_CHECK = "forge/promote-decision";
export const ATTEST_SCHEMA = "forgedock.release.attestation/v1";
export const DECISION_SCHEMA = "forgedock.release.promote/v1";
export const PLAN_SCHEMA = "forgedock.release.images/v1";
export const DEFAULT_APP = "github-actions";
/** Shadow exit criterion (NORTHSTAR 4): this many observed would-skip decisions with zero disagreements. */
export const SHADOW_EXIT = { observed: 10, disagree: 0 };
export const PROMOTE_FLAGS = ["--check", "--gate", "--attest", "--observed", "--report", "--images"];
export const PROMOTE_KEYS = ["enabled", "shadow", "required_checks", "evidence_app", "cache_ref", "cache_mode", "builder", "rebuild_all", "services"];
const SERVICE_KEYS = ["image", "context", "dockerfile", "paths", "cache_paths", "cache_ref"];
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/; // an image or cache ref: no whitespace or comma (a comma would split the buildx option list)

const isMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : typeof v === "string" && v.trim() ? [v.trim()] : []);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isDigest = (d) => typeof d === "string" && DIGEST_RE.test(d);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** JSON with sorted keys: the same value always hashes the same. */
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isMap(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const first = (e) => String(e?.message ?? e).split("\n")[0];

/**
 * forge.yaml `deploy.promote` -> the normalized config. Absent, unreadable or `enabled` not true: `{mode: "off"}`.
 * `required_checks` falls back to `gate.required_checks`, then the release policy's `ci.required_checks` list; `services`
 * falls back to the policy `units` that name an image. `findings` lists what is wrong; any finding keeps promote from skipping.
 * @param {string} raw forge.yaml text
 * @param {{policy?: object}} [opts] the parsed `.forge/release.yaml`, when the repo has one
 */
export function parsePromoteConfig(raw, { policy = null } = {}) {
  const off = { enabled: false, shadow: true, mode: "off", requiredChecks: [], evidenceApp: DEFAULT_APP, cacheRef: "", cacheMode: "max", builder: "", rebuildAll: [], services: {}, findings: [] };
  let y;
  try { y = load(String(raw ?? ""), { schema: JSON_SCHEMA }); } catch (e) { return { ...off, findings: [`forge.yaml: ${first(e)}`] }; }
  const p = y?.deploy?.promote;
  if (!isMap(p) || p.enabled !== true) return off;
  const findings = [];
  for (const k of Object.keys(p)) if (!PROMOTE_KEYS.includes(k)) findings.push(`deploy.promote.${k}: unknown key`);
  if (p.shadow !== undefined && typeof p.shadow !== "boolean") findings.push("deploy.promote.shadow: expected true or false");
  const cacheMode = p.cache_mode === undefined ? "max" : String(p.cache_mode);
  if (!["min", "max"].includes(cacheMode)) findings.push("deploy.promote.cache_mode: expected min or max");
  const refOk = (at, v) => { if (v && !REF_RE.test(v)) findings.push(`${at}: ${JSON.stringify(v)} is not a registry reference`); return v; };
  const services = {};
  const src = isMap(p.services) ? p.services : Object.fromEntries(Object.entries(policy?.units ?? {}).filter(([, u]) => u?.image).map(([id, u]) => [id, { image: u.image, dockerfile: u.dockerfile ?? undefined, paths: u.paths }]));
  if (p.services !== undefined && !isMap(p.services)) findings.push("deploy.promote.services: expected a mapping");
  for (const [name, s] of Object.entries(src)) {
    const at = `deploy.promote.services.${name}`;
    if (!NAME_RE.test(name)) { findings.push(`${at}: invalid service name`); continue; }
    if (!isMap(s)) { findings.push(`${at}: expected a mapping`); continue; }
    for (const k of Object.keys(s)) if (!SERVICE_KEYS.includes(k)) findings.push(`${at}.${k}: unknown key`);
    if (!str(s.image)) findings.push(`${at}.image: required`);
    const context = str(s.context) || ".";
    services[name] = { image: refOk(`${at}.image`, str(s.image)), context, dockerfile: str(s.dockerfile) || (context === "." ? "Dockerfile" : `${context.replace(/\/+$/, "")}/Dockerfile`), paths: strList(s.paths), cachePaths: strList(s.cache_paths), cacheRef: refOk(`${at}.cache_ref`, str(s.cache_ref)) };
  }
  const requiredChecks = strList(p.required_checks).length ? strList(p.required_checks) : strList(y?.gate?.required_checks).length ? strList(y.gate.required_checks) : strList(policy?.ci?.required_checks);
  if (!requiredChecks.length) findings.push("deploy.promote.required_checks: no required checks (set it, or gate.required_checks)");
  const shadow = p.shadow !== false;
  return {
    enabled: true, shadow, mode: shadow ? "shadow" : "enforce", requiredChecks, evidenceApp: str(p.evidence_app) || DEFAULT_APP,
    cacheRef: refOk("deploy.promote.cache_ref", str(p.cache_ref)), cacheMode: ["min", "max"].includes(cacheMode) ? cacheMode : "max", builder: str(p.builder), rebuildAll: strList(p.rebuild_all), services, findings,
  };
}

/** Hash of what the evidence was taken under: the required checks and the service build inputs. A deploy side configured differently never matches. */
export const configHash = (cfg) => sha256(canonical({ v: 1, required: [...(cfg?.requiredChecks ?? [])].sort(), rebuild_all: [...(cfg?.rebuildAll ?? [])].sort(), services: cfg?.services ?? {} }));

const runId = (url) => { const m = /\/actions\/runs\/(\d+)/.exec(String(url ?? "")); return m ? Number(m[1]) : null; };

/**
 * Every required check concluded `success` on exactly `sha` (missing, unfinished, neutral, skipped and other-sha runs do not count).
 * @param {{name, conclusion, head?, sha?, id?, run_id?, details_url?}[]} checks
 * @returns {{ok: boolean, reasons: string[], checks: {name, conclusion, id, run_id}[]}}
 */
export function checkEvidence(checks, required, sha) {
  if (!Array.isArray(checks)) return { ok: false, reasons: ["unreadable input: checks"], checks: [] };
  if (!Array.isArray(required) || !required.length) return { ok: false, reasons: ["unreadable input: no required checks"], checks: [] };
  const reasons = [], out = [];
  for (const name of required) {
    const runs = checks.filter((c) => c?.name === name && (c.head ?? c.sha) === sha);
    if (!runs.length) { reasons.push(`${name}: missing on ${sha}`); continue; }
    const bad = runs.find((c) => c.conclusion !== "success");
    if (bad) { reasons.push(`${name}: ${bad.conclusion ?? "unfinished"}, not success`); continue; }
    const last = runs.reduce((a, b) => (Number(b.id ?? 0) >= Number(a.id ?? 0) ? b : a));
    out.push({ name, conclusion: "success", id: last.id ?? null, run_id: last.run_id ?? runId(last.details_url) });
  }
  return { ok: !reasons.length, reasons, checks: out };
}

/** `{service: digest}` with only well-formed digests; anything else is a finding. */
function cleanImages(images) {
  const out = {}, bad = [];
  for (const [k, v] of Object.entries(isMap(images) ? images : {})) (isDigest(v) ? (out[k] = v) : bad.push(k));
  return { out, bad };
}

/**
 * The attestation of `commit`, or `{refused}` when a required check did not pass, a digest is malformed or a configured
 * service has no digest. Nothing is written here.
 * @returns {{attestation: object} | {refused: string[]}}
 */
export function buildAttestation({ commit, tree, checks, images, cfg, now = Date.now() }) {
  const reasons = [...(cfg?.findings ?? [])];
  if (!SHA_RE.test(String(commit ?? ""))) reasons.push("no commit sha");
  if (!SHA_RE.test(String(tree ?? ""))) reasons.push("no tree sha");
  const ev = checkEvidence(checks, cfg?.requiredChecks, commit);
  reasons.push(...ev.reasons);
  const { out, bad } = cleanImages(images);
  bad.forEach((s) => reasons.push(`image ${s}: not a sha256 digest`));
  for (const s of Object.keys(cfg?.services ?? {})) if (!out[s] && !bad.includes(s)) reasons.push(`image ${s}: no digest`);
  if (reasons.length) return { refused: reasons };
  return { attestation: { schema: ATTEST_SCHEMA, commit, tree, images: out, checks: ev.checks, config_hash: configHash(cfg), at: new Date(now).toISOString() } };
}

/**
 * The deploy-side decision, pure and fail-closed.
 * `evidence`: an attestation (null when none). `target`: `{commit, tree, digests?: {service: digest}, required: string[],
 * configHash, checks?}`: what is about to be deployed. `checks` are the check runs read NOW on the attested commit; when
 * given they must still pass (a forged or stale attestation cannot stand in for them).
 * @returns {{ok: boolean, reasons: string[], match?: "commit"|"tree"}}
 */
export function canPromote(evidence, target) {
  const no = (...reasons) => ({ ok: false, reasons });
  if (!isMap(evidence) || evidence.schema !== ATTEST_SCHEMA) return no("no attestation for this commit");
  if (!isMap(target) || !SHA_RE.test(String(target.commit ?? "")) || !SHA_RE.test(String(target.tree ?? ""))) return no("unreadable target: commit and tree are required");
  if (!SHA_RE.test(String(evidence.commit ?? "")) || !SHA_RE.test(String(evidence.tree ?? ""))) return no("unreadable attestation: commit and tree are required");
  const reasons = [];
  if (evidence.tree !== target.tree) reasons.push(`tree ${target.tree.slice(0, 12)} is not the attested tree ${evidence.tree.slice(0, 12)}`);
  const required = Array.isArray(target.required) ? target.required : [];
  if (!required.length) reasons.push("no required checks configured");
  const attested = Array.isArray(evidence.checks) ? evidence.checks : [];
  for (const name of required) {
    const c = attested.find((x) => x?.name === name);
    if (!c) reasons.push(`${name}: not in the attestation`);
    else if (c.conclusion !== "success") reasons.push(`${name}: attested as ${c.conclusion ?? "unfinished"}`);
  }
  if (target.checks !== undefined && required.length) reasons.push(...checkEvidence(target.checks, required, evidence.commit).reasons.map((r) => `now ${r}`));
  if (!target.configHash || evidence.config_hash !== target.configHash) reasons.push("config hash differs from the attested one");
  const want = isMap(target.digests) ? target.digests : {}, have = isMap(evidence.images) ? evidence.images : {};
  if (Object.keys(have).length && !Object.keys(want).length) reasons.push("target digests unknown");
  for (const [svc, d] of Object.entries(want)) {
    if (!isDigest(d)) reasons.push(`image ${svc}: target digest is not a sha256 digest`);
    else if (have[svc] !== d) reasons.push(`image ${svc}: ${d.slice(0, 19)} is not the attested ${have[svc] ? have[svc].slice(0, 19) : "(none)"}`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, reasons: [], match: evidence.commit === target.commit ? "commit" : "tree" };
}

/**
 * The decision document: `skip_pre_gate` is true only in enforce mode with `canPromote` ok and no config finding; shadow
 * reports `would_skip` and never skips. `skips` explains each piece of work the evidence covers; `gates` are the catalogue
 * gates with an `evidence_check` (a safety gate always runs).
 */
export function decide(cfg, evidence, target, { catalogue = null, safety } = {}) {
  const base = { schema: DECISION_SCHEMA, mode: cfg?.mode ?? "off", commit: target?.commit ?? null };
  if (!cfg?.enabled) return { ...base, mode: "off", would_skip: false, skip_pre_gate: false, reasons: ["deploy.promote is off"], skips: [], gates: [] };
  const v = canPromote(evidence, target);
  const reasons = [...cfg.findings, ...v.reasons];
  const ok = !reasons.length;
  const skips = ok ? [
    ...evidence.checks.filter((c) => target.required.includes(c.name)).map((c) => ({ what: `check:${c.name}`, why: `success on ${evidence.commit.slice(0, 12)}${c.run_id ? ` (run ${c.run_id})` : ""}` })),
    ...Object.entries(target.digests ?? {}).map(([s, d]) => ({ what: `image:${s}`, why: `${d.slice(0, 19)} is the digest CI built and tested` })),
  ] : [];
  return {
    ...base, would_skip: ok, skip_pre_gate: ok && cfg.mode === "enforce", reasons, skips,
    gates: catalogue ? evidenceSkips(catalogue, evidence, { ok, safety }) : [],
    ...(ok ? { evidence_commit: evidence.commit, match: v.match } : {}),
  };
}

/** Human lines of a decision (`release promote --check`). */
export function formatDecision(d) {
  if (d.mode === "off") return ["release promote: off (forge.yaml deploy.promote.enabled is not true); the full pre-gate runs"];
  const head = d.would_skip
    ? `release promote: ${d.mode === "enforce" ? "the pre-gate is skipped" : "shadow: the pre-gate WOULD be skipped (it still runs)"} for ${String(d.commit).slice(0, 12)} (${d.match === "commit" ? "the attested commit" : `same tree as attested ${String(d.evidence_commit).slice(0, 12)}`})`
    : `release promote: the full pre-gate runs for ${String(d.commit).slice(0, 12)} (${d.mode})`;
  return [head, ...d.reasons.map((r) => `  no: ${r}`), ...d.skips.map((s) => `  skip ${s.what}: ${s.why}`), ...d.gates.map((g) => `  ${g.skip ? "skip" : "keep"} gate:${g.gate}: ${g.why}`)];
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub register: check runs on the commit

const lines = (s) => String(s ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** `{commit, tree, parents}` of `sha` (Git Data API: works in a shallow checkout). */
export async function readCommit({ io, repo, sha }) {
  const c = await io.api("GET", `repos/${repo}/git/commits/${sha}`);
  return { commit: c.sha, tree: c.tree?.sha, parents: (c.parents ?? []).map((p) => p.sha) };
}

/** Every check run on `sha` (paginated): `{name, conclusion, head, id, run_id, app}`. */
export async function readChecks({ io, repo, sha }) {
  return lines(await io.gh(["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs[] | {name, conclusion, head: .head_sha, id, details_url, app: .app.slug}"]))
    .map(({ details_url: u, ...c }) => ({ ...c, run_id: runId(u) }));
}

/** The JSON document of the newest `name` check run on `sha` posted by `app`; null when there is none or it is unreadable. */
async function readDoc({ io, repo, sha, name, app }) {
  let runs;
  try { runs = (await io.api("GET", `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`))?.check_runs ?? []; } catch { return null; }
  const mine = runs.filter((r) => r?.name === name && r.head_sha === sha && r.app?.slug === app).sort((a, b) => Number(b.id) - Number(a.id));
  if (!mine.length) return null;
  let text = mine[0].output?.text;
  if (!text) { try { text = (await io.api("GET", `repos/${repo}/check-runs/${mine[0].id}`))?.output?.text; } catch { return null; } }
  try { return JSON.parse(String(text)); } catch { return null; }
}

const postDoc = ({ io, repo, sha, name, title, summary, doc }) =>
  io.api("POST", `repos/${repo}/check-runs`, { name, head_sha: sha, status: "completed", conclusion: "neutral", output: { title, summary, text: JSON.stringify(doc) } });

/** Write the attestation as the `forge/promote-evidence` check run of its commit (needs an app token with `checks: write`). */
export const writeEvidence = ({ io, repo }, attestation) =>
  postDoc({ io, repo, sha: attestation.commit, name: EVIDENCE_CHECK, title: "CI evidence", summary: `Required checks passed on \`${attestation.commit.slice(0, 12)}\` (tree \`${attestation.tree.slice(0, 12)}\`); ${Object.keys(attestation.images).length} image digest(s).`, doc: attestation });

/**
 * The attestation that covers `target` ({commit, parents}): the target itself, one of its parents (a merge commit of the
 * attested head) or the head of a pull request merged as it (squash). Accepted only from `app`, and only when it names the
 * commit its check run is on, so a document copied onto another commit is ignored.
 */
export async function readEvidence({ io, repo, target, app = DEFAULT_APP }) {
  const cands = [target.commit, ...(target.parents ?? [])];
  try { for (const p of (await io.api("GET", `repos/${repo}/commits/${target.commit}/pulls`)) ?? []) if (p?.head?.sha) cands.push(p.head.sha); } catch { /* no associated pull request */ }
  for (const sha of [...new Set(cands)].slice(0, 8)) {
    const doc = await readDoc({ io, repo, sha, name: EVIDENCE_CHECK, app });
    if (doc?.schema === ATTEST_SCHEMA && doc.commit === sha) return doc;
  }
  return null;
}

/**
 * The deploy-side call (W6 `release-deploy.mjs` calls this, or `canPromote` with its own facts): read the target, the
 * evidence and the checks as they are now, decide. Mode off: no read, no write. Any unreadable fact is a reason, never a throw.
 * @param {{io, repo, cfg, sha, digests?: object, catalogue?: object, safety?: string[]}} p
 */
export async function promoteDecision({ io, repo, cfg, sha, digests, catalogue = null, safety }) {
  if (!cfg?.enabled) return decide(cfg, null, { commit: sha });
  let target, evidence = null, checks;
  try { target = await readCommit({ io, repo, sha }); } catch (e) { return { ...decide(cfg, null, { commit: sha }), reasons: [`cannot read commit ${sha}: ${first(e)}`] }; }
  try { evidence = await readEvidence({ io, repo, target, app: cfg.evidenceApp }); } catch { evidence = null; }
  if (evidence) { try { checks = await readChecks({ io, repo, sha: evidence.commit }); } catch { checks = null; } } // null: unreadable, so `canPromote` refuses
  return decide(cfg, evidence, { ...target, digests, required: cfg.requiredChecks, configHash: configHash(cfg), ...(evidence ? { checks } : {}) }, { catalogue, safety });
}

/** Record a decision as the `forge/promote-decision` check run of the target commit (the audit trail in both modes). */
export async function recordDecision({ io, repo }, d, { observed = null, minutes = null, now = Date.now() } = {}) {
  const doc = { schema: DECISION_SCHEMA, mode: d.mode, commit: d.commit, would_skip: !!d.would_skip, skipped: !!d.skip_pre_gate, reasons: d.reasons ?? [], evidence_commit: d.evidence_commit ?? null, observed, agree: agreeOf(d.would_skip, observed), minutes, at: new Date(now).toISOString() };
  await postDoc({ io, repo, sha: d.commit, name: DECISION_CHECK, title: `promote ${d.mode}`, summary: `${d.would_skip ? "would skip" : "would not skip"} the pre-gate${observed ? `; the pre-gate ${observed === "pass" ? "passed" : "failed"}` : ""}`, doc });
  return doc;
}

/** Agreement of one record: a would-skip is right when the pre-gate passed and wrong when it failed; no claim otherwise. */
export const agreeOf = (wouldSkip, observed) => (wouldSkip && (observed === "pass" || observed === "fail") ? observed === "pass" : null);

/**
 * Shadow agreement over decision records. `disagree` is the number that matters: promote would have skipped a pre-gate that failed.
 * @returns {{decisions, would_skip, observed, agree, disagree, minutes_saved, exit_met}}
 */
export function agreement(records) {
  const rs = (records ?? []).filter((r) => r?.schema === DECISION_SCHEMA);
  const claimed = rs.filter((r) => r.would_skip && (r.observed === "pass" || r.observed === "fail"));
  const agree = claimed.filter((r) => r.observed === "pass").length, disagree = claimed.length - agree;
  return {
    decisions: rs.length, would_skip: rs.filter((r) => r.would_skip).length, observed: claimed.length, agree, disagree,
    minutes_saved: Math.round(claimed.filter((r) => r.observed === "pass").reduce((n, r) => n + (Number(r.minutes) > 0 ? Number(r.minutes) : 0), 0) * 10) / 10,
    exit_met: claimed.length >= SHADOW_EXIT.observed && disagree <= SHADOW_EXIT.disagree,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Image build plan (pure)

/** The globs that decide whether a service's image changed: its `paths`, its build context and its Dockerfile. */
export function serviceGlobs(s) {
  const ctx = String(s.context ?? ".").replace(/^\.\//, "").replace(/\/+$/, "");
  return [...(s.paths ?? []), ...(ctx && ctx !== "." ? [`${ctx}/**`] : (s.paths ?? []).length ? [] : ["**"]), s.dockerfile].filter(Boolean);
}

/**
 * Cache mounts of a service: one per `cache_paths` entry, with the id its Dockerfile declares (`RUN --mount=type=cache,target=..`;
 * the id defaults to the target). `declared: false` means the Dockerfile has no such mount, so the path is not cached at all.
 */
export function cacheMounts(dockerfileText, cachePaths) {
  const found = new Map();
  for (const m of String(dockerfileText ?? "").replace(/\\\r?\n/g, " ").matchAll(/--mount=([^\s]+)/g)) {
    const kv = Object.fromEntries(m[1].split(",").map((p) => { const i = p.indexOf("="); return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)]; }));
    const target = kv.target ?? kv.dst ?? kv.destination;
    if (kv.type === "cache" && target) found.set(target.replace(/\/+$/, ""), kv.id || target);
  }
  return (cachePaths ?? []).map((p) => { const t = String(p).replace(/\/+$/, ""); return { target: t, id: found.get(t) ?? t, declared: found.has(t) }; });
}

const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

/** `docker` argv of one service build: registry layer cache (`--cache-from`/`--cache-to type=registry`), digest to a metadata file, push. */
export function buildxArgs(name, s, { sha, cfg }) {
  const ref = s.cacheRef || (cfg.cacheRef ? `${cfg.cacheRef}:${name}` : "");
  return [
    "buildx", "build", ...(cfg.builder ? ["--builder", cfg.builder] : []), "--file", s.dockerfile, "--tag", `${s.image}:${sha}`,
    ...(ref ? ["--cache-from", `type=registry,ref=${ref}`, "--cache-to", `type=registry,ref=${ref},mode=${cfg.cacheMode}`] : []),
    "--metadata-file", `.forge/build/${name}.json`, "--push", s.context,
  ];
}

/** The image digest from a buildx `--metadata-file` (`containerimage.digest`), or null. */
export function digestFromMetadata(text) {
  try { const d = JSON.parse(String(text))?.["containerimage.digest"]; return isDigest(d) ? d : null; } catch { return null; }
}

/**
 * Which images to build. A service is REUSED (previous digest, no build) only when the changed paths are known, a previous
 * digest exists, no `rebuild_all` path changed and none of its globs matches a changed path; every other case builds.
 * @param {{cfg: object, changed: string[]|null, previous?: {[service: string]: string}, sha: string, dockerfiles?: {[service: string]: string}}} p
 * @returns {{schema, sha, images: object[], build: string[], reuse: string[]}}
 */
export function planImages({ cfg, changed, previous = {}, sha, dockerfiles = {} }) {
  const files = Array.isArray(changed) ? changed.map((f) => String(f).replace(/^\.\//, "")) : null;
  const all = files?.find((f) => matchesAny(cfg.rebuildAll, f));
  const images = Object.entries(cfg.services ?? {}).map(([name, s]) => {
    const hits = files ? files.filter((f) => matchesAny(serviceGlobs(s), f)) : [];
    const reason = !files ? "changed paths unknown" : !isDigest(previous?.[name]) ? "no previous digest" : all ? `${all} rebuilds every image` : hits.length ? `changed: ${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1})` : ""}` : null;
    const mounts = cacheMounts(dockerfiles[name], s.cachePaths);
    if (!reason) return { service: name, image: s.image, build: false, reason: "no changed path in its build inputs", digest: previous[name], cache_mounts: mounts };
    const args = buildxArgs(name, s, { sha, cfg });
    return { service: name, image: s.image, build: true, reason, tag: `${s.image}:${sha}`, args, command: ["docker", ...args].map(shq).join(" "), cache_mounts: mounts };
  });
  return { schema: PLAN_SCHEMA, sha, images, build: images.filter((i) => i.build).map((i) => i.service), reuse: images.filter((i) => !i.build).map((i) => i.service) };
}

export function formatPlan(plan) {
  if (!plan.images.length) return ["release promote: no services (deploy.promote.services, or units with an image in .forge/release.yaml)"];
  return plan.images.flatMap((i) => [
    i.build ? `build ${i.service}: ${i.reason}` : `reuse ${i.service}: ${i.digest} (${i.reason})`,
    ...(i.build ? [`  ${i.command}`] : []),
    ...i.cache_mounts.map((m) => (m.declared ? `  cache mount ${m.id} -> ${m.target}` : `  warning: ${m.target} is in cache_paths but the Dockerfile has no RUN --mount=type=cache,target=${m.target}`)),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI

const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const jsonArg = (v, readFile) => { if (!v) return undefined; const t = v.trim().startsWith("{") ? v : readFile(v); return JSON.parse(t); };

/**
 * `forgedock release promote --check | --gate | --attest | --observed pass|fail | --report | --images`.
 * `ctx`: {io, raw: forge.yaml text, policy, readFile, defaultBranch, env, appendFile}. @returns the exit code.
 * `--check` writes nothing. Mode off: one line, no read, no write, exit 0.
 */
export async function promoteFromCli(argv, ctx) {
  const { io, policy = null, readFile, defaultBranch = "main", env = {} } = ctx;
  const cfg = parsePromoteConfig(ctx.raw, { policy });
  const asJson = argv.includes("--json");
  const out = (doc, text) => (asJson ? [JSON.stringify(doc)] : text).forEach((l) => io.print(l));
  if (!cfg.enabled) { cfg.findings.forEach((f) => io.print(`release promote: ${f}`)); out(decide(cfg, null, {}), formatDecision({ mode: "off" })); return 0; }
  const sha = flagOf(argv, "--sha") ?? String(io.git(["rev-parse", "HEAD"])).trim();
  const repo = flagOf(argv, "--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;

  if (argv.includes("--images")) {
    const base = flagOf(argv, "--base"), list = flagOf(argv, "--changed");
    let changed = list ? list.split(",").filter(Boolean) : null, previous;
    if (!changed && base) { try { changed = String(io.git(["diff", "--name-only", base, sha])).split("\n").filter(Boolean); } catch { changed = null; } }
    try { previous = jsonArg(flagOf(argv, "--previous"), readFile); } catch (e) { io.print(`release promote: --previous: ${first(e)}`); return 1; }
    if (!previous && base) { // the digests attested for the base commit are the ones an unchanged service keeps
      try { const b = await readCommit({ io, repo, sha: String(io.git(["rev-parse", base])).trim() }); previous = (await readEvidence({ io, repo, target: b, app: cfg.evidenceApp }))?.images; } catch { previous = undefined; }
    }
    const dockerfiles = {};
    for (const [n, s] of Object.entries(cfg.services)) { try { dockerfiles[n] = String(io.git(["show", `${sha}:${s.dockerfile}`])); } catch { /* unreadable: mounts report as undeclared */ } }
    const plan = planImages({ cfg, changed, previous: previous ?? {}, sha, dockerfiles });
    cfg.findings.forEach((f) => io.print(`release promote: ${f}`));
    out(plan, formatPlan(plan));
    return cfg.findings.length ? 1 : 0;
  }

  if (argv.includes("--report")) {
    const n = Math.min(100, Math.max(1, Number(flagOf(argv, "--last")) || 30));
    const commits = (await io.api("GET", `repos/${repo}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=${n}`)) ?? [];
    const records = [];
    for (const c of commits) { const d = await readDoc({ io, repo, sha: c.sha, name: DECISION_CHECK, app: cfg.evidenceApp }); if (d) records.push(d); }
    const a = agreement(records);
    out({ schema: DECISION_SCHEMA, report: a, exit: SHADOW_EXIT }, [
      `release promote: ${a.decisions} decision(s) on the last ${commits.length} ${defaultBranch} commit(s); ${a.would_skip} would skip, ${a.observed} with an observed pre-gate: ${a.agree} agree, ${a.disagree} disagree; ${a.minutes_saved} pre-gate minute(s) it would have saved`,
      a.exit_met ? `release promote: exit criterion met (>= ${SHADOW_EXIT.observed} observed, ${SHADOW_EXIT.disagree} disagreements): the owner can set deploy.promote.shadow: false` : `release promote: exit criterion not met (needs >= ${SHADOW_EXIT.observed} observed would-skip decisions and ${SHADOW_EXIT.disagree} disagreements)`,
    ]);
    return a.disagree ? 1 : 0;
  }

  if (argv.includes("--attest")) {
    let images, commit, checks;
    try { images = jsonArg(flagOf(argv, "--digests"), readFile) ?? {}; } catch (e) { io.print(`release promote: --digests: ${first(e)}`); return 1; }
    try { commit = await readCommit({ io, repo, sha }); checks = await readChecks({ io, repo, sha }); } catch (e) { io.print(`release promote: ${first(e)}`); return 1; }
    const r = buildAttestation({ commit: commit.commit, tree: commit.tree, checks, images, cfg, now: io.now?.() });
    if (r.refused) { r.refused.forEach((x) => io.print(`release promote: not attested: ${x}`)); return 1; }
    if (!argv.includes("--dry-run")) await writeEvidence({ io, repo }, r.attestation);
    out(r.attestation, [`release promote: ${argv.includes("--dry-run") ? "would attest" : "attested"} ${sha.slice(0, 12)} (tree ${commit.tree.slice(0, 12)}, ${r.attestation.checks.length} check(s), ${Object.keys(r.attestation.images).length} image(s))`]);
    return 0;
  }

  if (argv.includes("--observed")) {
    const observed = flagOf(argv, "--observed");
    if (observed !== "pass" && observed !== "fail") { io.print("release promote: --observed must be pass or fail"); return 1; }
    const prev = await readDoc({ io, repo, sha, name: DECISION_CHECK, app: cfg.evidenceApp });
    if (!prev) { io.print(`release promote: no decision recorded for ${sha.slice(0, 12)}; run release promote --gate first`); return 1; }
    const doc = await recordDecision({ io, repo }, { ...prev, skip_pre_gate: prev.skipped }, { observed, minutes: Number(flagOf(argv, "--minutes")) || null, now: io.now?.() });
    out(doc, [`release promote: pre-gate ${observed} at ${sha.slice(0, 12)}; promote ${doc.would_skip ? "would have skipped it" : "would not have skipped it"}${doc.agree === null ? "" : doc.agree ? " (agree)" : " (DISAGREE: the evidence is not enough to skip)"}`]);
    return 0;
  }

  // --check (no write) and --gate (the deploy-side call: records the decision)
  let digests;
  try {
    digests = jsonArg(flagOf(argv, "--digests"), readFile);
    if (!digests && policy?.deploy?.expected_digests_command) { const r = await io.rehearse(policy.deploy.expected_digests_command, { timeout: 120_000 }); digests = r?.ok ? JSON.parse(r.output) : undefined; }
  } catch (e) { io.print(`release promote: digests: ${first(e)}`); digests = undefined; }
  const cat = catalogueAt(io, sha);
  const d = await promoteDecision({ io, repo, cfg, sha, digests, catalogue: cat === null ? null : parseCatalogue(cat).catalogue ?? null, safety: parseGatesConfig(policy).safety });
  if (argv.includes("--gate")) {
    try { await recordDecision({ io, repo }, d, { now: io.now?.() }); }
    catch (e) { if (d.skip_pre_gate) { d.skip_pre_gate = false; d.reasons.push(`the decision could not be recorded: ${first(e)}`); } else io.print(`release promote: warning: the decision could not be recorded: ${first(e)}`); }
    if (env.GITHUB_OUTPUT && ctx.appendFile) ctx.appendFile(env.GITHUB_OUTPUT, `skip_pre_gate=${d.skip_pre_gate}\nwould_skip=${d.would_skip}\n`);
  }
  out(d, formatDecision(d));
  return 0;
}
