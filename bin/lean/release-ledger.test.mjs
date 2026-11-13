// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { INIT_PROFILE } from "./release-config.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { createReleaseLedger, writeRelease, readLedger, updateActive, acquireLease, heartbeat, acceptWrite, redactDeep, ACTIVE, ACTIVE_RETRIES } from "./release-ledger.mjs";
import { runRelease, withStubs, RELEASE_STEPS } from "./release.mjs";

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
  it("createReleaseLedger makes an orphan branch; a second create loses; the head is read back", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const a = await createReleaseLedger(c, ID, { v: 1, id: ID, steps: {} });
    assert.ok(a.ok);
    assert.deepEqual(g.commits.get(a.sha).parents, []);
    assert.ok((await createReleaseLedger(c, ID, { v: 1 })).lost);
    assert.deepEqual((await readLedger(c, ID, POLICY)).state, { v: 1, id: ID, steps: {} });
    assert.equal(await readLedger(c, "r20261112-101500-43"), null);
  });

  it("writeRelease is compare-and-swap: a stale head loses", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const a = await createReleaseLedger(c, ID, { n: 1 });
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
    assert.equal(win.expires, g.now + 120_000); // #5553: {holder, epoch, expires}
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
    await assert.rejects(() => createReleaseLedger(ctxOf(g, "lane"), ID, {}), /driver credential/);
    assert.equal(g.refs.size, 0);
    const c = ctxOf(g);
    g.meta.verified = false; await createReleaseLedger(c, ID, { a: 1 });
    assert.match((await readLedger(c, ID, POLICY)).rejected, /unverified/);
    const g2 = fakeGh({ id: 7 }); await createReleaseLedger(ctxOf(g2), ID, { a: 1 });
    assert.match((await readLedger(ctxOf(g2), ID, POLICY)).rejected, /not allowlisted/);
    const g3 = fakeGh({ id: 2 }); await createReleaseLedger(ctxOf(g3), ID, { a: 1 });
    assert.match((await readLedger(ctxOf(g3), ID, { allowlist: [1, 2], driverIds: [1] })).rejected, /not the driver credential/);
    assert.ok(acceptWrite({ author: { id: 1 }, commit: { verification: { verified: true } } }, POLICY).ok);
  });

  it("I21: seeded secret-shaped strings never reach a commit", async () => {
    const g = fakeGh(), c = ctxOf(g);
    const tok = "ghp_" + "a".repeat(30);
    await createReleaseLedger(c, ID, { note: `pushed with ${tok}`, env: { API_KEY: "hunter2hunter2" }, line: "GITHUB_TOKEN=abc123def456" });
    await updateActive(c, ["pause"], () => ({ patch: { pause: tok }, control: { why: `Bearer ${"z".repeat(20)}` } }));
    assert.ok(g.trees.size >= 2);
    for (const files of g.trees.values()) assert.doesNotMatch(JSON.stringify(files), /ghp_a|hunter2|abc123def456|zzzzzzzzzz/);
    assert.deepEqual(redactDeep({ TOKEN: "x" }), { TOKEN: "[redacted]" });
  });

  it("kill -9 resume: a second host continues the release from the ledger, not its own disk", async () => {
    const g = fakeGh(), seen = [];
    const mkIo = () => ({ print() {}, now: () => 1_700_000_000_000, runningLanes: async () => [], batches: async () => [], setParallel: async () => {}, gh: async () => { throw new Error("no gh"); }, api: g.api });
    const step = (name, die) => async () => { if (die) throw new Error("kill -9"); seen.push(name); return {}; };
    const all = (dieAt) => ({ preflight: step("preflight"), "host-preflight": async () => ({ skipped: true }), deploy: async () => ({ skipped: true }), "release-pr": async () => { if (dieAt === "release-pr") throw new Error("kill -9"); seen.push("release-pr"); return { pr: 7 }; }, review: step("review"), fixes: step("fixes"), "mark-ready": async () => ({ skipped: true }), rehearsal: async () => ({ skipped: true }), promotion: step("promotion"), "post-merge": step("post-merge") });
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

describe("release fencing through the job (#5553)", () => {
  const HEAD = "a".repeat(40);
  const mkIo = (g, holder, calls) => ({ holder, print() {}, now: () => 1_700_000_000_000, sleep: async () => {}, runningLanes: async () => [], batches: async () => [], setParallel: async () => {}, api: g.api,
    git: () => INIT_PROFILE, mergeGuard: async () => ({ ok: true }), // the merge guard has its own tests (release-gate.test.mjs, release.test.mjs)
    gh: async (a) => {
      const j = a.join(" ");
      if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ state: calls.some((c) => c[1] === "merge") ? "MERGED" : "OPEN", mergeCommit: calls.some((c) => c[1] === "merge") ? { oid: "m".repeat(40) } : null, headRefOid: HEAD, comments: [{ body: "FORGE:GATE_PASS" }] });
      if (a[0] === "api") return JSON.stringify([{ name: "forge/deploy-gate", conclusion: "success" }]);
      if (a[0] === "pr" && a[1] === "merge") { calls.push(a); return ""; }
      throw new Error(`unexpected gh ${j}`);
    } });
  const skip = async () => ({ skipped: true }), ok = async () => ({});
  const steps = (over = {}) => withStubs({ preflight: ok, "host-preflight": skip, "release-pr": async () => ({ pr: 7 }), review: ok, fixes: ok, "mark-ready": skip, rehearsal: skip, "post-merge": ok, ...over });
  const go = (io, st, root) => runRelease({ io, repo: REPO, root, mounts: DISK, id: ID, opts: { merge: true }, config: { managed: true }, branches: { staging: "staging", default: "main" }, steps: st ?? steps() });

  it("the job takes the lease after release-pr and the merge carries the Forge-Epoch trailer and a write-ahead intent", async () => {
    const g = fakeGh(), calls = [];
    const out = await go(mkIo(g, "hostA", calls), null, tmpDir("fa-"));
    assert.equal(out.status, "done");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(-2), ["--body", `Forge-Release: ${ID}\nForge-Epoch: 1`]);
    const st = (await readLedger(ctxOf(g), ID)).state;
    assert.deepEqual(st.intents.map((i) => [i.action, i.epoch, i.done]), [["merge", 1, true]]);
  });

  it("I7 zombie: a host paused after takeover wakes and is refused; no merge is issued", async () => {
    const g = fakeGh(), calls = [];
    let takeover = false;
    const zombie = steps({ review: async () => { // host A "pauses" here; host B takes the lease over while it sleeps
      g.now += 600_000; takeover = (await acquireLease(ctxOf(g), { holder: "hostB", release: ID, issue: 7, now: g.now })).ok; return {}; } });
    const out = await go(mkIo(g, "hostA", calls), zombie, tmpDir("fz-"));
    assert.ok(takeover);
    assert.equal(out.status, "refused");
    assert.match(out.reason, /fenced/);
    assert.equal(calls.length, 0);
  });

  it("I5: when _active cannot be read, the merge is not issued", async () => {
    const g = fakeGh(), calls = [];
    const io = mkIo(g, "hostA", calls);
    let armed = false;
    const base = g.api;
    io.api = async (m, path, b) => { if (armed && /contents\/active\.json/.test(path)) throw new Error("network partition"); return base(m, path, b); };
    const out = await go(io, steps({ review: async () => { armed = true; return {}; } }), tmpDir("fp-"));
    assert.equal(out.status, "refused");
    assert.match(out.reason, /cannot read _active/);
    assert.equal(calls.length, 0);
  });

  it("kill -9 at the step boundary after the merge: the resumed run does not merge again", async () => {
    const g = fakeGh(), calls = [];
    const die = steps({ "post-merge": async () => { throw new Error("kill -9"); } });
    await assert.rejects(() => go(mkIo(g, "hostA", calls), die, tmpDir("fk1-")), /kill -9/);
    assert.equal(calls.length, 1);
    const out = await go(mkIo(g, "hostA", calls), null, tmpDir("fk2-")); // same host or another: the PR is observed MERGED
    assert.equal(out.status, "done");
    assert.equal(calls.length, 1);
  });
  it("kill -9 at every step boundary: the resumed run repeats no completed step and merges exactly once", async () => {
    for (const dieAt of RELEASE_STEPS) {
      const g = fakeGh(), calls = [], ran = [];
      const track = (name, fn) => async (...a) => { if (name === dieAt && !ran.includes(`die:${name}`)) { ran.push(`die:${name}`); throw new Error("kill -9"); } ran.push(name); return fn(...a); };
      const base = { preflight: ok, "host-preflight": skip, "release-pr": async () => ({ pr: 7 }), review: ok, fixes: ok, "mark-ready": skip, rehearsal: skip, "post-merge": ok, deploy: skip };
      const wrapped = withStubs(Object.fromEntries(Object.entries(withStubs(base)).map(([k, fn]) => [k, track(k, fn)])));
      await assert.rejects(() => go(mkIo(g, "hostA", calls), wrapped, tmpDir("fe1-")), /kill -9/, dieAt);
      const out = await go(mkIo(g, "hostB", calls), wrapped, tmpDir("fe2-")); // another host, empty disk
      assert.equal(out.status, "done", dieAt);
      assert.equal(calls.length, 1, `${dieAt}: one merge`);
      const done = ran.filter((r) => !r.startsWith("die:") && !["host-preflight", "mark-ready", "rehearsal", "deploy"].includes(r)); // unconfigured steps leave no trace and may re-run
      assert.equal(new Set(done).size, done.length, `${dieAt}: no step ran twice (${done})`);
    }
  });
});
