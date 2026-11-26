/**
 * #5949: dispatcher-seeded sandbox mirrors. Real local git repos, a real agent and router over loopback HTTP, no network:
 * the "GitHub" remote is an unreachable URL. Run with: node --test bin/tests/pool-mirror-seed.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { createAgent } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { localRunner, makeMirrorSeed } from "../pool/mirror-seed.mjs";
import { httpTransport, remoteProvider } from "../lean/sandbox-remote.mjs";
import { seedMirror, buildBundle } from "../lean/mirror-bundle.mjs";
import { parseExecution } from "../lean/execution.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const SLUG = "o/r";

/** A dispatcher clone shaped like a real one: branches arrive as refs/remotes/origin/*. */
function dispatcherRepo() {
  const dir = tmpDir("seed-disp-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "big.bin"), randomBytes(1_000_000));
  git(dir, "add", "."); git(dir, "commit", "-qm", "one");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const commit = (msg) => { writeFileSync(join(dir, "f.txt"), msg); git(dir, "add", "."); git(dir, "commit", "-qm", msg); git(dir, "update-ref", "refs/remotes/origin/main", "HEAD"); };
  return { dir, commit };
}

function fixture() {
  const cache = tmpDir("seed-cache-"), state = tmpDir("seed-agent-");
  const docker = { async createVolume() {}, async volumeLabels() { return {}; }, async run() {}, async list() { return []; } };
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 1 }, router_url: "http://x", state_dir: state, allow_cpus: 4, allow_mem_gb: 8, token: "t", image: "lane:1" },
    { docker, log: quiet, live: () => ({ ok: true }), vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }), mirrorRunner: ({ seedDir }) => localRunner({ root: cache, seedDir }) });
  return { agent, cache, state };
}
const listen = (handler) => new Promise((res) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });

async function stack() {
  const f = fixture();
  const agentSrv = await listen(f.agent.handle);
  const router = createRouter({ state_dir: tmpDir("seed-router-"), lane: { cpus: 1, mem_gb: 1 }, enroll_token: "e", forgedock_token: "fd" }, { log: quiet });
  router.store.data.agents.a1 = { url: `http://127.0.0.1:${agentSrv.address().port}`, token: "t" };
  const routerSrv = await listen(router.handle);
  const transport = httpTransport({ endpoint: `http://127.0.0.1:${routerSrv.address().port}`, token: "fd" });
  return { ...f, router, transport, close: () => { agentSrv.close(); routerSrv.close(); } };
}
const mirrorDir = (cache) => join(cache, "git", "o_r.git");

test("seed with GitHub unreachable: the mirror is built from the dispatcher and a lane clones --shared from it (R11)", async () => {
  const d = dispatcherRepo(), s = await stack();
  try {
    const st = await seedMirror({ transport: s.transport, id: "sb-1", slug: SLUG, repoDir: d.dir });
    assert.equal(st.full, true);
    assert.ok(existsSync(join(mirrorDir(s.cache), "cs-seeded")));
    assert.equal(git(mirrorDir(s.cache), "rev-parse", "refs/heads/main"), git(d.dir, "rev-parse", "HEAD"));
    assert.throws(() => git(mirrorDir(s.cache), "show-ref", "--verify", "--quiet", "refs/heads/HEAD")); // the origin/HEAD symref is not shipped as a branch
    // what entrypoint.sh does for a seeded mirror: clone --shared from it, then point origin at GitHub (unreachable here)
    const work = join(tmpDir("seed-work-"), "repo");
    git(".", "clone", "-q", "--shared", "--branch", "main", mirrorDir(s.cache), work);
    git(work, "remote", "set-url", "origin", "https://127.0.0.1:1/o/r.git");
    assert.equal(git(work, "rev-parse", "HEAD"), git(d.dir, "rev-parse", "HEAD"));
  } finally { s.close(); }
});

test("a second launch sends only an incremental bundle, a few KB (R12)", async () => {
  const d = dispatcherRepo(), s = await stack();
  try {
    const first = await seedMirror({ transport: s.transport, id: "sb-1", slug: SLUG, repoDir: d.dir });
    d.commit("two");
    const second = await seedMirror({ transport: s.transport, id: "sb-2", slug: SLUG, repoDir: d.dir });
    assert.equal(second.full, false);
    assert.ok(first.bytes > 100000, `full bundle ${first.bytes}`);
    assert.ok(second.bytes > 0 && second.bytes < 5000, `incremental bundle ${second.bytes}`);
    assert.equal(git(mirrorDir(s.cache), "rev-parse", "refs/heads/main"), git(d.dir, "rev-parse", "HEAD"));
    const third = await seedMirror({ transport: s.transport, id: "sb-3", slug: SLUG, repoDir: d.dir });
    assert.equal(third.upToDate, true);
    assert.equal(third.bytes, 0);
  } finally { s.close(); }
});

test("a truncated or corrupt bundle leaves the existing mirror untouched (R13)", async () => {
  const d = dispatcherRepo(), f = fixture();
  const seed = makeMirrorSeed({ seedDir: join(f.state, "seed2"), runnerFor: () => localRunner({ root: f.cache, seedDir: join(f.state, "seed2") }) });
  const { createHash } = await import("node:crypto");
  const send = async (bytes, claimed = bytes) => {
    const upload = createHash("sha256").update(claimed).digest("hex"), base = { slug: SLUG, upload };
    for (let o = 0; o < bytes.length; o += 100000) { const c = bytes.subarray(o, o + 100000); seed.chunk({ ...base, offset: o, data_b64: c.toString("base64"), sha256: createHash("sha256").update(c).digest("hex") }); }
    return { base, size: bytes.length };
  };
  const good = await buildBundle(d.dir, null);
  const ok = await send(good);
  await seed.finish({ ...ok.base, finish: { size: ok.size } });
  const before = git(mirrorDir(f.cache), "rev-parse", "refs/heads/main");
  d.commit("two");
  const next = await buildBundle(d.dir, { "refs/heads/main": before });
  // 1) a flipped byte fails the whole-bundle checksum and the upload is dropped
  const bad = Buffer.from(next); bad[bad.length - 5] ^= 0xff;
  const q = await send(bad, next);
  await assert.rejects(seed.finish({ ...q.base, finish: { size: next.length } }), (e) => e.status === 422);
  // 2) interrupted: only half arrived, finish refuses and reports where to resume; a wrong chunk offset is a 409 carrying it too
  const half = next.subarray(0, Math.floor(next.length / 2));
  const p = await send(half, next);
  await assert.rejects(seed.finish({ ...p.base, finish: { size: next.length } }), (e) => e.status === 409 && e.extra.offset === half.length);
  assert.throws(() => seed.chunk({ ...p.base, offset: 5, data_b64: "AAAA", sha256: createHash("sha256").update(Buffer.from("AAAA", "base64")).digest("hex") }), (e) => e.status === 409 && e.extra.offset === half.length);
  // 3) right checksum but not a bundle: the apply fails, no tmp is left, the mirror is as it was
  const junk = Buffer.from("not a bundle at all");
  const j = await send(junk);
  await assert.rejects(seed.finish({ ...j.base, finish: { size: junk.length } }), (e) => e.status === 422);
  assert.equal(git(mirrorDir(f.cache), "rev-parse", "refs/heads/main"), before);
  assert.deepEqual(readdirSync(join(f.cache, "git")).filter((n) => n.endsWith(".tmp") || n.endsWith(".old")), []);
  git(mirrorDir(f.cache), "fsck", "--connectivity-only");
});

test("an interrupted upload resumes from the agent's offset (R3)", async () => {
  const d = dispatcherRepo(), s = await stack();
  try {
    let dropped = false;
    const flaky = { ...s.transport, async seed(id, body) { if (!dropped && body.offset > 0) { dropped = true; throw Object.assign(new Error("reset"), { status: 502 }); } return s.transport.seed(id, body); } };
    const st = await seedMirror({ transport: flaky, id: "sb-1", slug: SLUG, repoDir: d.dir });
    assert.equal(dropped, true);
    assert.ok(st.chunks > 1);
    assert.equal(git(mirrorDir(s.cache), "rev-parse", "refs/heads/main"), git(d.dir, "rev-parse", "HEAD"));
  } finally { s.close(); }
});

test("the router refuses an oversized chunk and GET /mirrors answers per slug", async () => {
  const s = await stack();
  try {
    const q = await s.transport.mirrors("sb-9", { slug: SLUG });
    assert.deepEqual(q.mirrors, { [SLUG]: "absent" });
    await assert.rejects(s.transport.seed("sb-9", { slug: SLUG, upload: "a".repeat(64), offset: 0, data_b64: "A".repeat(800 * 1024), sha256: "x" }), (e) => e.status === 413);
  } finally { s.close(); }
});

test("repo_source: parse, github skips seeding, dispatcher fails hard, auto falls back, an older router is a fallback (R9, R6)", async () => {
  assert.equal(parseExecution({}).repoSource, undefined); // unset means auto
  assert.equal(parseExecution({ repo_source: "Dispatcher" }).repoSource, "dispatcher");
  assert.equal(parseExecution({ repo_source: "github" }).repoSource, "github");
  assert.equal(parseExecution({ repo_source: "bogus" }).repoSource, undefined);
  const d = dispatcherRepo();
  const mk = (repoSource, tr) => {
    const launched = [];
    const transport = { async launch(spec) { launched.push(spec.id); }, async status() { return "running"; }, ...tr };
    const logs = tmpDir("seed-log-");
    const batch = { id: "b", logFile: () => join(logs, "x.log") };
    return { launched, p: remoteProvider({ batch, repo: SLUG, settings: { repoSource, repoDir: d.dir }, transport, env: {}, credentials: () => "" }) };
  };
  const broken = { async mirrors() { throw Object.assign(new Error("boom"), { status: 502 }); }, async seed() { throw new Error("no"); } };
  const old = { async mirrors() { throw Object.assign(new Error("HTTP 404"), { status: 404, unsupported: true }); }, async seed() {} };
  let asked = 0;
  const gh = mk("github", { async mirrors() { asked++; return {}; }, async seed() { asked++; } });
  await gh.p.start({ issue: 1 }); assert.equal(asked, 0); assert.equal(gh.launched.length, 1);
  const strict = mk("dispatcher", broken);
  await assert.rejects(strict.p.start({ issue: 1 }), (e) => e.code === "pool.seed_failed"); assert.equal(strict.launched.length, 0);
  const auto = mk("auto", broken);
  const h = await auto.p.start({ issue: 1 }); assert.equal(auto.launched.length, 1); assert.equal(h.seed.fallback, true);
  const older = mk("auto", old);
  assert.equal((await older.p.start({ issue: 1 })).seed.fallback, true); assert.equal(older.launched.length, 1);
});

test("abandoned .part uploads are swept and uploads are size-capped (#5970)", () => {
  const dir = tmpDir("seed-cap-");
  const old = "a".repeat(64), fresh = "b".repeat(64), up = "c".repeat(64);
  writeFileSync(join(dir, `${old}.part`), "x"); writeFileSync(join(dir, `${fresh}.part`), "x");
  utimesSync(join(dir, `${old}.part`), new Date(0), new Date(0));
  const seed = makeMirrorSeed({ seedDir: dir, runnerFor: () => async () => "", uploadMax: 10, totalMax: 12 });
  assert.deepEqual(readdirSync(dir), [`${fresh}.part`]); // stale swept at creation, fresh kept
  const chunk = (upload, offset, n) => { const buf = Buffer.alloc(n, 1); return seed.chunk({ slug: SLUG, upload, offset, data_b64: buf.toString("base64"), sha256: createHash("sha256").update(buf).digest("hex") }); };
  assert.throws(() => chunk(up, 0, 11), { status: 413 }); // per-upload cap
  assert.equal(chunk(up, 0, 10).offset, 10);
  assert.throws(() => chunk("d".repeat(64), 0, 2), { status: 413 }); // total cap (1 + 10 + 2 > 12)
  assert.ok(!existsSync(join(dir, `${"d".repeat(64)}.part`)));
});

test("concurrent uploaders of the same bundle each get their own part file and both finish (2026-11-26 seed 409/422 bursts)", async () => {
  const dir = tmpDir("seed-conc-");
  const seed = makeMirrorSeed({ seedDir: dir, runnerFor: () => async () => "" });
  const bundle = Buffer.from("identical bundle bytes built by two lanes in the same second");
  const upload = createHash("sha256").update(bundle).digest("hex");
  const half = bundle.length >> 1, parts = [bundle.subarray(0, half), bundle.subarray(half)];
  const chunk = (uploader, offset, buf) => seed.chunk({ slug: SLUG, upload, uploader, offset, data_b64: buf.toString("base64"), sha256: createHash("sha256").update(buf).digest("hex") });
  assert.equal(chunk("fdrsbx-a", 0, parts[0]).offset, half);
  assert.equal(chunk("fdrsbx-b", 0, parts[0]).offset, half, "the second lane's first chunk is not an offset mismatch");
  assert.equal(chunk("fdrsbx-a", half, parts[1]).offset, bundle.length);
  assert.equal(chunk("fdrsbx-b", half, parts[1]).offset, bundle.length);
  assert.equal((await seed.finish({ slug: SLUG, upload, uploader: "fdrsbx-a", finish: { size: bundle.length } })).ok, true);
  assert.equal((await seed.finish({ slug: SLUG, upload, uploader: "fdrsbx-b", finish: { size: bundle.length } })).ok, true, "finishing one lane does not delete the other lane's upload");
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".part")), []);
  assert.equal((await seed.tips({ slug: SLUG, upload, uploader: "fdrsbx-c" })).upload_offset, 0);
});
