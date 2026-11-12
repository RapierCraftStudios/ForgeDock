// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { createLedger, writeRelease, readLedger, updateActive, acquireLease, heartbeat, acceptWrite, redactDeep, ACTIVE, ACTIVE_RETRIES } from "./release-ledger.mjs";
import { runRelease } from "./release.mjs";

const REPO = "o/r", ID = "r20261112-101500-42", DISK = [{ mount: "/", type: "ext4" }];
const err = (status, m) => Object.assign(new Error(m ?? `HTTP ${status}`), { status });

/** In-memory GitHub: refs, commits (tree = file map), comments. `meta` tunes the author the next commits get. */
function fakeGh(meta = {}) {
  const refs = new Map(), commits = new Map(), trees = new Map(), comments = new Map();
  const g = { refs, commits, trees, comments, calls: [], meta: { id: 1, verified: true, ...meta }, now: 1_000_000, hooks: {} };
  let n = 0;
  g.api = async (method, path, body) => {
    g.calls.push(`${method} ${path}`);
    await g.hooks.before?.(method, path);
    let m;
    if ((m = /git\/ref\/heads\/(.+)$/.exec(path))) { if (!refs.has(m[1])) throw err(404); return { object: { sha: refs.get(m[1]) } }; }
    if ((m = /git\/commits\/(\w+)$/.exec(path))) return { tree: { sha: commits.get(m[1]).tree } };
    if (method === "POST" && /git\/trees$/.test(path)) { const files = { ...(trees.get(body.base_tree) ?? {}) }; for (const e of body.tree) files[e.path] = e.content; const sha = `t${++n}`; trees.set(sha, files); return { sha }; }
    if (method === "POST" && /git\/commits$/.test(path)) { const sha = `c${++n}`; commits.set(sha, { tree: body.tree, parents: body.parents, author: g.meta.id, verified: g.meta.verified }); return { sha }; }
    if (method === "POST" && /git\/refs$/.test(path)) { const b = body.ref.replace("refs/heads/", ""); if (refs.has(b)) throw err(422, "Reference already exists"); refs.set(b, body.sha); return {}; }
    if (method === "PATCH" && (m = /git\/refs\/heads\/(.+)$/.exec(path))) { if (commits.get(body.sha).parents[0] !== refs.get(m[1]) || body.force) throw err(422, "Update is not a fast forward"); refs.set(m[1], body.sha); return {}; }
    if ((m = /contents\/([^?]+)\?ref=(.+)$/.exec(path))) { const f = trees.get(commits.get(refs.get(decodeURIComponent(m[2]))).tree)[m[1]]; if (f === undefined) throw err(404); return { content: Buffer.from(f).toString("base64") }; }
    if ((m = /\/commits\/(\w+)$/.exec(path))) { const c = commits.get(m[1]); return { author: { id: c.author, login: `u${c.author}` }, commit: { verification: { verified: c.verified } } }; }
    if (method === "POST" && /issues\/\d+\/comments$/.test(path)) { const id = ++n; comments.set(id, { body: body.body, updated_at: new Date(g.now).toISOString() }); return { id }; }
    if (method === "PATCH" && (m = /issues\/comments\/(\d+)$/.exec(path))) { comments.set(Number(m[1]), { body: body.body, updated_at: new Date(g.now).toISOString() }); return {}; }
    if ((m = /issues\/comments\/(\d+)$/.exec(path))) { if (!comments.has(Number(m[1]))) throw err(404); return comments.get(Number(m[1])); }
    throw new Error(`unrouted ${method} ${path}`);
  };
  return g;
}
const ctxOf = (g, credential = "driver") => ({ io: { api: g.api }, repo: REPO, credential });
const POLICY = { allowlist: [1], driverIds: [1] };

describe("release ledger (#5550)", () => {
  it("createLedger makes an orphan branch; a second create loses; the head is read back", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const a = await createLedger(c, ID, { v: 1, id: ID, steps: {} });
    assert.ok(a.ok);
    assert.deepEqual(g.commits.get(a.sha).parents, []);
    assert.ok((await createLedger(c, ID, { v: 1 })).lost);
    assert.deepEqual((await readLedger(c, ID, POLICY)).state, { v: 1, id: ID, steps: {} });
    assert.equal(await readLedger(c, "r20261112-101500-43"), null);
  });

  it("writeRelease is compare-and-swap: a stale head loses", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const a = await createLedger(c, ID, { n: 1 });
    assert.ok((await writeRelease(c, ID, { n: 2 }, a.sha)).ok);
    assert.ok((await writeRelease(c, ID, { n: 3 }, a.sha)).lost);
    assert.equal((await readLedger(c, ID)).state.n, 2);
  });

  it("I6: two drivers race for the lease, exactly one wins", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const out = await Promise.all(["hostA", "hostB"].map((holder) => acquireLease(c, { holder, release: ID, issue: 9, now: g.now })));
    assert.equal(out.filter((r) => r.ok).length, 1);
    const loser = out.find((r) => !r.ok);
    assert.match(loser.refused, /lease held by/);
    const win = out.find((r) => r.ok).lease;
    assert.equal(win.epoch, 1);
    assert.ok(win.commentId);
  });

  it("a lease whose heartbeat comment is older than the ttl is taken over with a higher epoch", async () => {
    const g = fakeGh(), c = ctxOf(g);
    assert.ok((await acquireLease(c, { holder: "A", release: ID, issue: 9, ttlS: 60, now: g.now })).ok);
    assert.match((await acquireLease(c, { holder: "B", release: ID, issue: 9, now: g.now + 30_000 })).refused, /held by A/);
    const t = await acquireLease(c, { holder: "B", release: ID, issue: 9, now: g.now + 61_000 });
    assert.equal(t.lease.epoch, 2);
    assert.equal(t.lease.holder, "B");
  });

  it("heartbeat edits the FORGE:LEASE comment and makes no commit; a superseded holder is fenced", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const { lease } = await acquireLease(c, { holder: "A", release: ID, issue: 9, ttlS: 60, now: g.now });
    const commitsBefore = g.commits.size;
    g.now += 10_000;
    assert.ok((await heartbeat(c, lease)).ok);
    assert.equal(g.commits.size, commitsBefore);
    assert.match(g.comments.get(lease.commentId).body, /FORGE:LEASE/);
    assert.equal(g.comments.get(lease.commentId).updated_at, new Date(g.now).toISOString());
    await acquireLease(c, { holder: "B", release: ID, issue: 9, now: g.now + 61_000 });
    assert.ok((await heartbeat(c, lease)).fenced);
  });

  it("updateActive is key-scoped, appends controls.jsonl, and retries a lost race up to 5 times", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const r = await updateActive(c, ["pause"], () => ({ patch: { pause: true, epoch: 99 }, control: { verb: "pause" } }));
    assert.deepEqual(r.active, { pause: true }); // epoch is not an owned key
    await updateActive(c, ["pause"], () => ({ patch: { pause: false }, control: { verb: "resume" } }));
    assert.equal(g.trees.get(g.commits.get(g.refs.get(ACTIVE)).tree)["controls.jsonl"].trim().split("\n").length, 2);
    // one lost race then success
    let lose = 1;
    g.hooks.before = async (m, p) => { if (lose > 0 && m === "PATCH" && p.includes("git/refs")) { lose--; g.refs.set(ACTIVE, (await (async () => { const s = await commitHead(g); return s; })())); } };
    const ok = await updateActive(c, ["holds"], () => ({ patch: { holds: ["x"] } }));
    assert.ok(ok.ok);
    // always losing: stops at the bound
    let attempts = 0;
    g.hooks.before = async (m, p) => { if (m === "PATCH" && p.includes("git/refs")) { attempts++; g.refs.set(ACTIVE, await commitHead(g)); } };
    const bad = await updateActive(c, ["holds"], () => ({ patch: { holds: ["y"] } }));
    assert.deepEqual(bad, { lost: true, attempts: ACTIVE_RETRIES });
    assert.equal(attempts, ACTIVE_RETRIES);
  });

  it("forged writes are rejected: lane credential, unverified commit, non-allowlisted actor", async () => {
    const g = fakeGh();
    await assert.rejects(() => createLedger(ctxOf(g, "lane"), ID, {}), /driver credential/);
    assert.equal(g.refs.size, 0);
    const c = ctxOf(g);
    g.meta.verified = false; await createLedger(c, ID, { a: 1 });
    assert.match((await readLedger(c, ID, POLICY)).rejected, /unverified/);
    const g2 = fakeGh({ id: 7 }); await createLedger(ctxOf(g2), ID, { a: 1 });
    assert.match((await readLedger(ctxOf(g2), ID, POLICY)).rejected, /not allowlisted/);
    const g3 = fakeGh({ id: 2 }); await createLedger(ctxOf(g3), ID, { a: 1 });
    assert.match((await readLedger(ctxOf(g3), ID, { allowlist: [1, 2], driverIds: [1] })).rejected, /not the driver credential/);
    assert.ok(acceptWrite({ author: { id: 1 }, commit: { verification: { verified: true } } }, POLICY).ok);
  });

  it("I21: seeded secret-shaped strings never reach a commit", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const tok = "ghp_" + "a".repeat(30);
    await createLedger(c, ID, { note: `pushed with ${tok}`, env: { API_KEY: "hunter2hunter2" }, line: "GITHUB_TOKEN=abc123def456" });
    await updateActive(c, ["pause"], () => ({ patch: { pause: tok }, control: { why: `Bearer ${"z".repeat(20)}` } }));
    assert.ok(g.trees.size >= 2);
    for (const files of g.trees.values()) assert.doesNotMatch(JSON.stringify(files), /ghp_a|hunter2|abc123def456|zzzzzzzzzz/);
    assert.deepEqual(redactDeep({ TOKEN: "x" }), { TOKEN: "[redacted]" });
  });

  it("kill -9 resume: a second host continues the release from the ledger, not its own disk", async () => {
    const g = fakeGh(), seen = [];
    const mkIo = () => ({ print() {}, now: () => 1_700_000_000_000, runningLanes: async () => [], batches: async () => [], setParallel: async () => {}, gh: async () => { throw new Error("no gh"); }, api: g.api });
    const step = (name, die) => async () => { if (die) throw new Error("kill -9"); seen.push(name); return {}; };
    const all = (dieAt) => ({ preflight: step("preflight"), "host-preflight": async () => ({ skipped: true }), "release-pr": step("release-pr", dieAt === "release-pr"), review: step("review"), fixes: step("fixes"), "mark-ready": async () => ({ skipped: true }), rehearsal: async () => ({ skipped: true }), promotion: step("promotion"), "post-merge": step("post-merge") });
    const run = (io, dieAt, root) => runRelease({ io, repo: REPO, root, mounts: DISK, id: ID, opts: {}, config: { managed: true }, branches: {}, steps: all(dieAt) });
    await assert.rejects(() => run(mkIo(), "release-pr", tmpDir("ledgerA-")), /kill -9/);
    assert.deepEqual(seen, ["preflight"]);
    const out = await run(mkIo(), null, tmpDir("ledgerB-")); // host B: empty disk
    assert.equal(out.status, "done");
    assert.deepEqual(seen, ["preflight", "release-pr", "review", "fixes", "promotion", "post-merge"]);
  });
});

async function commitHead(g) { // a foreign writer commits on top of the current head: the next ref update loses
  const sha = `foreign${g.commits.size}`;
  g.commits.set(sha, { tree: g.commits.get(g.refs.get(ACTIVE)).tree, parents: [g.refs.get(ACTIVE)], author: 1, verified: true });
  return sha;
}
