// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5949: dispatcher-seeded repo mirrors. The agent receives a git bundle in checksummed chunks (resumable by offset) and applies
 * it to the repo's bare mirror in the cache volume (`<cache>/git/<slug>.git`, the path entrypoint.sh and `env ensure` read):
 * copy of the mirror (or a fresh bare repo) -> `git fetch <bundle>` -> `fsck --connectivity-only` -> rename into place, under a
 * per-slug flock. Any failure removes the tmp copy and leaves the live mirror untouched. The git steps run in a helper container
 * of the lane image that mounts the volume (`runner`); tests inject a runner that runs the same script on a local directory.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Per-chunk cap on the decoded payload; base64 of it stays under the 1 MB JSON body limit of the router and agent. */
export const SEED_CHUNK_MAX = 512 * 1024;
/** Abandoned uploads: a `.part` untouched this long is swept; one upload and all uploads together are capped (#5970). */
export const SEED_PART_TTL_MS = 60 * 60000;
export const SEED_UPLOAD_MAX = 2 * 1024 ** 3;
export const SEED_TOTAL_MAX = 4 * 1024 ** 3;
export const mirrorName = (slug) => String(slug).replace(/\//g, "_");
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)?$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });

/** Lists the mirror's ref tips (`sha ref` lines), or prints ABSENT. Env: CACHE, NAME. */
export const TIPS_SCRIPT = 'm="$CACHE/git/$NAME.git"; if [ -d "$m" ]; then git -C "$m" for-each-ref --format="%(objectname) %(refname)" refs/heads refs/tags; else echo ABSENT; fi';
/** Applies $BUNDLE to the mirror atomically. Env: CACHE, NAME, BUNDLE. Exit non-zero leaves the live mirror as it was. */
export const APPLY_SCRIPT = `set -eu
m="$CACHE/git/$NAME.git"; t="$m.tmp"; old="$m.old"
mkdir -p "$CACHE/git"
exec 9>"$CACHE/git/$NAME.lock"
if command -v flock >/dev/null 2>&1; then flock 9; fi
cleanup() { rm -rf "$t"; }
trap cleanup EXIT
rm -rf "$t" "$old"
if [ -d "$m" ]; then cp -al "$m" "$t"; else git init --bare --quiet "$t"; fi
git -C "$t" bundle verify "$BUNDLE" >/dev/null
if git -C "$t" bundle list-heads "$BUNDLE" | grep -q ' refs/remotes/origin/'; then heads='+refs/remotes/origin/*:refs/heads/*'; else heads='+refs/heads/*:refs/heads/*'; fi
git -C "$t" fetch --quiet --no-tags "$BUNDLE" "$heads" '+refs/tags/*:refs/tags/*'
git -C "$t" fsck --connectivity-only --no-dangling >/dev/null
date +%s > "$t/cs-seeded"
if [ -d "$m" ]; then mv "$m" "$old"; fi
mv "$t" "$m"
rm -rf "$old"
trap - EXIT`;

/** Default runner: the script in a helper container of the lane image with the cache volume at /cache and the seed dir at /seed. */
export function dockerRunner({ volume, image, seedDir }) {
  return (script, env) => new Promise((resolve, reject) => {
    const e = { ...env, CACHE: "/cache", ...(env.BUNDLE ? { BUNDLE: `/seed/${env.BUNDLE}` } : {}) };
    const args = ["run", "--rm", "--network", "none", "-v", `${volume}:/cache`, "-v", `${seedDir}:/seed:ro`, ...Object.entries(e).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--entrypoint", "bash", image, "-c", script];
    execFile("docker", args, { timeout: 10 * 60000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout))));
  });
}

/** Local runner (tests, and agents whose cache is a host directory): the same script on `root` as the cache dir. */
export function localRunner({ root, seedDir }) {
  return (script, env) => new Promise((resolve, reject) => {
    const e = { ...process.env, ...env, CACHE: root, ...(env.BUNDLE ? { BUNDLE: join(seedDir, env.BUNDLE) } : {}) };
    execFile("bash", ["-c", script], { env: e, timeout: 10 * 60000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout))));
  });
}

/** `runnerFor({slug, cache_key})` -> runner. Returns the agent's mirror seed handlers. */
export function makeMirrorSeed({ seedDir, runnerFor, partTtlMs = SEED_PART_TTL_MS, uploadMax = SEED_UPLOAD_MAX, totalMax = SEED_TOTAL_MAX }) {
  mkdirSync(seedDir, { recursive: true });
  const part = (up) => join(seedDir, `${up}.part`);
  const size = (up) => { try { return statSync(part(up)).size; } catch { return 0; } };
  /** Removes `.part` files idle past the TTL; returns the bytes the remaining ones hold. */
  const sweep = () => {
    let total = 0;
    for (const n of readdirSync(seedDir)) {
      if (!n.endsWith(".part")) continue;
      try {
        const st = statSync(join(seedDir, n));
        if (Date.now() - st.mtimeMs > partTtlMs) rmSync(join(seedDir, n), { force: true }); else total += st.size;
      } catch { /* removed concurrently */ }
    }
    return total;
  };
  sweep();
  const check = (b) => {
    if (typeof b?.slug !== "string" || !SLUG_RE.test(b.slug)) throw fail(400, "slug required");
    if (typeof b.upload !== "string" || !SHA_RE.test(b.upload)) throw fail(400, "upload must be the bundle sha256");
  };
  return {
    /** `GET /mirrors`: {mirrors: {slug: {ref: sha} | "absent"}, upload_offset?}. */
    async tips({ slug, cache_key = null, upload = null }) {
      if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw fail(400, "slug required");
      const out = String(await runnerFor({ slug, cache_key })(TIPS_SCRIPT, { NAME: mirrorName(slug) })).trim();
      const mirror = out === "ABSENT" ? "absent" : Object.fromEntries(out.split("\n").filter(Boolean).map((l) => { const i = l.indexOf(" "); return [l.slice(i + 1), l.slice(0, i)]; }));
      return { mirrors: { [slug]: mirror }, ...(upload && SHA_RE.test(upload) ? { upload_offset: size(upload) } : {}) };
    },
    /** One chunk: {slug, cache_key, upload, offset, data_b64, sha256}. A wrong offset is a 409 carrying the offset to resume from. */
    chunk(b) {
      check(b);
      const buf = Buffer.from(String(b.data_b64 ?? ""), "base64");
      if (!buf.length || buf.length > SEED_CHUNK_MAX) throw fail(413, `chunk must be 1..${SEED_CHUNK_MAX} bytes`);
      if (sha256(buf) !== b.sha256) throw fail(422, "chunk checksum mismatch");
      const have = size(b.upload);
      if (b.offset !== have) throw fail(409, "offset mismatch", { offset: have });
      if (have + buf.length > uploadMax) throw fail(413, `upload exceeds ${uploadMax} bytes`);
      if (sweep() + buf.length > totalMax) throw fail(413, `seed dir exceeds ${totalMax} bytes`);
      appendFileSync(part(b.upload), buf);
      return { offset: have + buf.length };
    },
    /** Verifies the whole bundle against {size, sha256 = upload} and applies it. A corrupt upload is dropped; the mirror is never touched on failure. */
    async finish(b) {
      check(b);
      const f = b.finish ?? {};
      const have = size(b.upload);
      if (!Number.isInteger(f.size) || have !== f.size) throw fail(409, "incomplete upload", { offset: have });
      if (!existsSync(part(b.upload)) || sha256(readFileSync(part(b.upload))) !== b.upload) { rmSync(part(b.upload), { force: true }); throw fail(422, "bundle checksum mismatch"); }
      try { await runnerFor(b)(APPLY_SCRIPT, { NAME: mirrorName(b.slug), BUNDLE: `${b.upload}.part` }); }
      catch (e) { rmSync(part(b.upload), { force: true }); throw fail(422, `bundle apply failed: ${String(e.stderr || e.message).slice(-300)}`); }
      rmSync(part(b.upload), { force: true });
      return { ok: true, ...(await this.tips({ slug: b.slug, cache_key: b.cache_key })) };
    },
  };
}
