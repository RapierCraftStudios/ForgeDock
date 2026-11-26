// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5949: dispatcher side of repo seeding. Builds an incremental `git bundle` from the dispatching host's own clone (everything the
 * agent's mirror lacks; `--all`-equivalent when the mirror is absent) and uploads it through the pool router in checksummed,
 * resumable chunks (`transport.mirrors` / `transport.seed`). Any failure throws; the caller falls back to the GitHub path.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Decoded bytes per chunk (the agent and router cap it at 512 KB). */
export const CHUNK = 384 * 1024;
const MAX_CHUNK_RETRIES = 3;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const git = async (cwd, args, opts = {}) => (await run("git", args, { cwd, encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 1 << 30 })).stdout;

/** The refs to ship: origin's branches (the agent maps them to refs/heads/*; local branches only when there are none) and tags; never the origin/HEAD symref. */
async function wantRefs(repoDir) {
  const list = async (...pats) => (await git(repoDir, ["for-each-ref", "--format=%(refname)", ...pats])).split("\n").filter(Boolean);
  const origin = (await list("refs/remotes/origin")).filter((r) => r !== "refs/remotes/origin/HEAD");
  return [...(origin.length ? origin : await list("refs/heads")), ...(await list("refs/tags"))];
}

/**
 * The bundle bytes for `repoDir` given the agent's `tips` ({ref: sha} or "absent"), or null when the agent already has everything.
 * Tips the dispatcher's repo does not contain are skipped as exclusions (the bundle is then larger, never invalid).
 */
export async function buildBundle(repoDir, tips) {
  const refs = await wantRefs(repoDir);
  if (!refs.length) throw new Error("local repo has no refs to bundle");
  const excl = [];
  if (tips && typeof tips === "object") {
    for (const sha of new Set(Object.values(tips))) {
      try { await git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]); excl.push(`^${sha}`); } catch { /* unknown here: not excluded */ }
    }
  }
  try { return await git(repoDir, ["bundle", "create", "-", ...refs, ...excl], { binary: true }); }
  catch (e) { if (/empty bundle/i.test(String(e.stderr))) return null; throw e; }
}

/** Size of the whole repo's packed objects in bytes (what a full transfer would move). */
async function repoBytes(repoDir) {
  try { const o = await git(repoDir, ["count-objects", "-v"]); const n = (k) => Number(new RegExp(`^${k}: (\\d+)`, "m").exec(o)?.[1] ?? 0); return (n("size") + n("size-pack")) * 1024; } catch { return 0; }
}

/**
 * Seed the agent mirror of `slug` for sandbox `id`. Returns {sent, bytes, chunks, full, ms, upToDate}. Throws on any failure;
 * an older router/agent without the endpoints (404/405 from `transport.mirrors`) throws `{unsupported: true}`.
 */
export async function seedMirror({ transport, id, slug, cacheKey = null, repoDir, now = () => Date.now() }) {
  if (typeof transport.mirrors !== "function" || typeof transport.seed !== "function") throw Object.assign(new Error("transport has no mirror seeding"), { unsupported: true });
  const t0 = now();
  if (!(await wantRefs(repoDir).catch(() => [])).length) throw new Error("local repo has no refs to bundle"); // nothing to seed from: no round trip
  const q = await transport.mirrors(id, { slug, cache_key: cacheKey });
  const tips = q?.mirrors?.[slug];
  if (tips === undefined) throw Object.assign(new Error("agent answered /mirrors without this repo"), { unsupported: true });
  const full = tips === "absent";
  const bundle = await buildBundle(repoDir, full ? null : tips);
  if (!bundle) return { sent: false, bytes: 0, chunks: 0, full, ms: now() - t0, upToDate: true };
  const upload = sha256(bundle), base = { slug, cache_key: cacheKey, upload };
  let offset = (await transport.mirrors(id, { slug, cache_key: cacheKey, upload }))?.upload_offset ?? 0, chunks = 0, sent = 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > bundle.length) offset = 0;
  while (offset < bundle.length) {
    const buf = bundle.subarray(offset, offset + CHUNK);
    const body = { ...base, offset, data_b64: buf.toString("base64"), sha256: sha256(buf) };
    let res = null;
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES && res === null; attempt++) {
      try { res = await transport.seed(id, body); }
      catch (e) {
        if (e.status === 409 && Number.isInteger(e.offset)) { res = { offset: e.offset, resumed: true }; break; } // the agent has a different length: resume from its offset
        if (e.status && e.status < 500 && e.status !== 429) throw e;
        if (attempt === MAX_CHUNK_RETRIES - 1) throw e;
      }
    }
    if (!res.resumed) { sent += buf.length; chunks++; }
    offset = res.offset;
  }
  await transport.seed(id, { ...base, finish: { size: bundle.length, sha256: upload } });
  const ms = now() - t0, whole = await repoBytes(repoDir);
  const saved_ms = sent > 0 && ms > 0 && whole > sent ? Math.round(((whole - sent) / sent) * ms) : null; // estimate: the whole repo at this upload's own rate
  return { sent: true, bytes: sent, bundle_bytes: bundle.length, chunks, full, ms, saved_ms, upToDate: false };
}
