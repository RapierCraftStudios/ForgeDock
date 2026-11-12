// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Release ledger on GitHub (#5550, epic #5549 Phase 0): the durable, cross-host record of a release. One orphan branch
 * `forge-ledger/<release-id>` per release (`state.json`, single writer = the lease holder) plus one control branch
 * `forge-ledger/_active` (`active.json`: lease, epoch, intake pause, holds, counters; `controls.jsonl`: append-only audit).
 * Writes are Git Data API commits whose ref update is NOT forced: a non-fast-forward (HTTP 422) is a lost race, which is
 * the compare-and-swap. `_active` is multi-writer, so `updateActive` is a key-scoped read-modify-write with up to 5 retries.
 * The heartbeat is an edit of the `FORGE:LEASE` comment on the tracking issue, never a commit. Every value is redacted
 * before it is written (I21); a head commit is trusted only from an allowlisted, GitHub-verified driver actor (I12).
 * Every effect goes through `io.api(method, path, body?)` (parsed JSON; throws with `.status`), so it is unit-testable.
 * Off unless forge.yaml `release.managed` is on; nothing here runs otherwise.
 */
import { SECRET_PAIR_RE, SECRET_SHAPE_RE } from "./conformance.mjs";

export const LEDGER_PREFIX = "forge-ledger/";
export const ACTIVE = "_active";
export const ACTIVE_RETRIES = 5;
export const LEASE_MARKER = "FORGE:LEASE";
const ID_RE = /^r\d{8}-\d{6}-\d+$/;
const SECRET_KEY_RE = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i;
const REDACTED = "[redacted]";

export const ledgerBranch = (id) => {
  if (id !== ACTIVE && !ID_RE.test(String(id ?? ""))) throw new Error(`invalid release id ${JSON.stringify(id)}`);
  return `${LEDGER_PREFIX}${id}`;
};

/** `value` with every secret-shaped string (and the value of every secret-named key) replaced; never mutates. */
export function redactDeep(value) {
  if (typeof value === "string") return value.replace(SECRET_PAIR_RE, `$1${REDACTED}`).replace(SECRET_SHAPE_RE, REDACTED);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY_RE.test(k) && typeof v === "string" ? REDACTED : redactDeep(v)]));
  return value;
}

const isLost = (e) => e?.status === 422 || /HTTP 422|not a fast.forward|already exists/i.test(String(e?.message ?? e));
const isMissing = (e) => e?.status === 404 || /HTTP 404|Not Found/i.test(String(e?.message ?? e));
const refPath = (b) => `heads/${b}`;

const headOf = async ({ io, repo }, branch) => {
  try { return (await io.api("GET", `repos/${repo}/git/ref/${refPath(branch)}`))?.object?.sha ?? null; } catch (e) { if (isMissing(e)) return null; throw e; }
};
const readFile = async ({ io, repo }, branch, path) => {
  try { const r = await io.api("GET", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`); return Buffer.from(r.content ?? "", "base64").toString("utf8"); } catch (e) { if (isMissing(e)) return null; throw e; }
};

/** The driver credential writes the ledger; a lane credential never does (I12). */
const assertDriver = (ctx) => { if (ctx.credential !== "driver") throw Object.assign(new Error("ledger writes need the driver credential"), { refused: "not-driver" }); };

/**
 * One commit of `files` ({path: text}, redacted) on `branch` on top of `parent` (null = orphan, creates the branch).
 * @returns {{ok: true, sha: string} | {lost: true}} lost when the ref moved (or exists): the caller re-reads and decides.
 */
export async function commitFiles(ctx, branch, files, message, parent) {
  assertDriver(ctx);
  const { io, repo } = ctx;
  const base = parent ? (await io.api("GET", `repos/${repo}/git/commits/${parent}`)).tree.sha : undefined;
  const tree = await io.api("POST", `repos/${repo}/git/trees`, { ...(base ? { base_tree: base } : {}), tree: Object.entries(files).map(([path, text]) => ({ path, mode: "100644", type: "blob", content: String(redactDeep(text)) })) });
  const commit = await io.api("POST", `repos/${repo}/git/commits`, { message: String(redactDeep(message)), tree: tree.sha, parents: parent ? [parent] : [] });
  try {
    if (parent) await io.api("PATCH", `repos/${repo}/git/refs/${refPath(branch)}`, { sha: commit.sha, force: false });
    else await io.api("POST", `repos/${repo}/git/refs`, { ref: `refs/${refPath(branch)}`, sha: commit.sha });
  } catch (e) { if (isLost(e)) return { lost: true }; throw e; }
  return { ok: true, sha: commit.sha };
}

const json = (o) => JSON.stringify(redactDeep(o), null, 2) + "\n";

/** Create `forge-ledger/<id>` with the first state; `{lost}` when the release already has a ledger. */
export const createLedger = (ctx, id, state) => commitFiles(ctx, ledgerBranch(id), { "state.json": json(state) }, `ledger: create ${id}`, null);

/** Write the next state of release `id` on top of `head` (the sha the caller read); `{lost}` means another writer moved it. */
export const writeRelease = (ctx, id, state, head) => commitFiles(ctx, ledgerBranch(id), { "state.json": json(state) }, `ledger: ${id} ${state.status ?? "update"}`, head);

/** True when `info` (GET repos/R/commits/<sha>) was authored by an allowlisted driver actor and is GitHub-verified. */
export function acceptWrite(info, policy = {}) {
  const id = info?.author?.id;
  if (!info?.commit?.verification?.verified) return { ok: false, reason: "unverified commit" };
  if (id == null || !(policy.allowlist ?? []).includes(id)) return { ok: false, reason: `actor ${info?.author?.login ?? id} is not allowlisted` };
  if (!(policy.driverIds ?? []).includes(id)) return { ok: false, reason: `actor ${info?.author?.login ?? id} is not the driver credential` };
  return { ok: true };
}

/** `{state, head}` of release `id`, `null` when it has no ledger, `{rejected}` when the head commit fails `acceptWrite`. */
export async function readLedger(ctx, id, policy) {
  const branch = ledgerBranch(id), head = await headOf(ctx, branch);
  if (!head) return null;
  if (policy) {
    const verdict = acceptWrite(await ctx.io.api("GET", `repos/${ctx.repo}/commits/${head}`), policy);
    if (!verdict.ok) return { rejected: verdict.reason, head };
  }
  const text = await readFile(ctx, branch, "state.json");
  try { return { state: JSON.parse(text), head }; } catch { return { rejected: "state.json unreadable", head }; }
}

/**
 * Key-scoped read-modify-write of `_active`: `fn(active)` returns `{patch}` (only keys in `owned` are applied, others are
 * ignored), optionally `control` (one line appended to controls.jsonl) or `{refuse}`. A lost race re-reads and re-applies,
 * up to ACTIVE_RETRIES attempts.
 * @returns {{ok: true, active, sha} | {refused: string} | {lost: true, attempts: number}}
 */
export async function updateActive(ctx, owned, fn) {
  for (let attempt = 1; attempt <= ACTIVE_RETRIES; attempt++) {
    const head = await headOf(ctx, ACTIVE);
    const cur = head ? JSON.parse((await readFile(ctx, ACTIVE, "active.json")) ?? "{}") : {};
    const out = await fn(cur);
    if (out?.refuse) return { refused: out.refuse };
    const next = { ...cur };
    for (const [k, v] of Object.entries(out?.patch ?? {})) if (owned.includes(k)) next[k] = v;
    const files = { "active.json": json(next) };
    if (out?.control) files["controls.jsonl"] = `${(head ? (await readFile(ctx, ACTIVE, "controls.jsonl")) ?? "" : "")}${JSON.stringify(redactDeep(out.control))}\n`;
    const r = await commitFiles(ctx, ACTIVE, files, `ledger: _active ${Object.keys(out?.patch ?? {}).join(",") || "control"}`, head);
    if (r.ok) return { ok: true, active: next, sha: r.sha };
  }
  return { lost: true, attempts: ACTIVE_RETRIES };
}

const leaseBody = (l) => `<!-- ${LEASE_MARKER} -->\nholder: ${l.holder}\nepoch: ${l.epoch}\nrelease: ${l.release}\n`;

/**
 * Take the lease for release `release` as `holder`: refused while another holder's `FORGE:LEASE` comment (on `issue`) was
 * edited within `ttlS`; each takeover bumps the epoch. The CAS lives in `updateActive`, so of two racing drivers one wins.
 * @returns {{ok: true, lease} | {refused: string} | {lost: true}}
 */
export async function acquireLease(ctx, { holder, release, issue, ttlS = 120, now = Date.now() }) {
  const r = await updateActive(ctx, ["lease", "epoch"], async (active) => {
    const l = active.lease;
    if (l && l.holder !== holder && l.commentId) {
      let c = null; try { c = await ctx.io.api("GET", `repos/${ctx.repo}/issues/comments/${l.commentId}`); } catch (e) { if (!isMissing(e)) throw e; }
      if (c && now - Date.parse(c.updated_at) < (l.ttlS ?? ttlS) * 1000) return { refuse: `lease held by ${l.holder} (epoch ${l.epoch})` };
    }
    const epoch = (active.epoch ?? 0) + 1;
    return { patch: { epoch, lease: { holder, release, issue, ttlS, epoch, commentId: l?.holder === holder ? l.commentId : undefined } }, control: { at: new Date(now).toISOString(), verb: "lease", holder, release, epoch } };
  });
  if (!r.ok) return r;
  let lease = r.active.lease;
  if (!lease.commentId) { // the heartbeat comment is made once per takeover, then only edited
    const c = await ctx.io.api("POST", `repos/${ctx.repo}/issues/${issue}/comments`, { body: leaseBody(lease) });
    const set = await updateActive(ctx, ["lease"], (a) => (a.lease?.holder === holder && a.lease.epoch === lease.epoch ? { patch: { lease: { ...a.lease, commentId: c.id } } } : { refuse: "lease lost" }));
    if (!set.ok) return set;
    lease = set.active.lease;
  }
  return { ok: true, lease };
}

/** Heartbeat: edit the FORGE:LEASE comment (no commit). `{fenced}` when the lease is no longer this holder's epoch. */
export async function heartbeat(ctx, lease) {
  const active = JSON.parse((await readFile(ctx, ACTIVE, "active.json")) ?? "{}");
  if (active.lease?.holder !== lease.holder || active.lease?.epoch !== lease.epoch) return { fenced: true };
  await ctx.io.api("PATCH", `repos/${ctx.repo}/issues/comments/${active.lease.commentId}`, { body: leaseBody(lease) });
  return { ok: true };
}
