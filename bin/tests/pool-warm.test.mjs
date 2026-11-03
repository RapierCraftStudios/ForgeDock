// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Warm sandbox pool (#4912): agent claim/replenish, router claim, the warm-refresh script and the entrypoint claim loader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { tmpDir } from "./_tmp.mjs";

const IMG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pool", "image");
const quiet = { info() {}, warn() {}, error() {} };

function fakeDocker() {
  const containers = new Map();
  return { containers, runs: [],
    async run(args) { const name = args[args.indexOf("--name") + 1]; this.runs.push(args); containers.set(name, { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }); return "cid"; },
    async inspect(name) { return containers.get(name) ?? null; },
    async remove(name) { containers.delete(name); },
    async listLabelled() { return [...containers.keys()]; },
    async wipe() {}, async listVolumes() { return []; }, async removeVolume() {} };
}
const spec = (id, extra = {}) => ({ id, issue: 7, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, env: { GH_TOKEN: "lane-secret" }, command: ["forgedock", "run-issue", "7"], result_file: "/result/7.json", ...extra });
function fixture() {
  let t = 1_000_000;
  const docker = fakeDocker();
  const dir = tmpDir("cs-warm-");
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: dir, allow_cpus: 8, allow_mem_gb: 16, lease_ttl_s: 600, token: "t" }, { docker, now: () => t, log: quiet, live: () => ({ ok: true }) });
  const markReady = () => { for (const r of Object.values(agent.store.data.sandboxes)) if (r.warm) { mkdirSync(join(r.dir, "out"), { recursive: true }); writeFileSync(join(r.dir, "out", "warm-ready"), ""); } };
  return { agent, docker, dir, markReady, advance: (ms) => { t += ms; } };
}
const SIZE = { cpus: 2, mem_gb: 3 };

test("no warm sandbox ready: claim is 404 (the lane then starts cold)", async () => {
  const { agent } = fixture();
  assert.equal((await agent.warm.claim({ spec: spec("lane-1", { warm: 1 }), ...SIZE })).status, 404);
});

test("warm 0 or absent: a launch starts no warm sandbox and mounts no claim dir", async () => {
  const { agent, docker } = fixture();
  await agent.launch({ spec: spec("lane-1"), ...SIZE });
  await agent.launch({ spec: spec("lane-2", { warm: 0 }), ...SIZE });
  await agent.warm.replenish();
  assert.deepEqual(agent.warm.list(), []);
  assert.ok(docker.runs.every((a) => !a.some((x) => String(x).endsWith(":/claim"))));
});

test("spec.warm N: the agent keeps N warm sandboxes; a ready one is claimed, its lane written 0600, and the pool refills", async () => {
  const { agent, docker, markReady } = fixture();
  await agent.launch({ spec: spec("lane-1", { warm: 2 }), ...SIZE });
  await agent.warm.replenish();
  const warmIds = agent.warm.list().map((w) => w.id);
  assert.equal(warmIds.length, 2);
  assert.equal(agent.warm.list().some((w) => w.ready), false, "still preparing");
  assert.equal((await agent.warm.claim({ spec: spec("lane-2", { warm: 2 }), ...SIZE })).status, 404, "none ready yet");
  markReady();
  const c = await agent.warm.claim({ spec: spec("lane-2", { warm: 2 }), ...SIZE });
  assert.equal(c.status, 200);
  assert.ok(warmIds.includes(c.body.id), "the warm sandbox keeps its id");
  const rec = agent.store.data.sandboxes[c.body.id];
  const file = join(rec.dir, "claim", "claim.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { env: { GH_TOKEN: "lane-secret" }, command: ["forgedock", "run-issue", "7"], ref: "staging" });
  assert.ok(!docker.runs.some((a) => a.join(" ").includes("lane-secret")), "lane env never reaches docker argv");
  // The lane id answers for the claimed sandbox; a repeat claim is idempotent.
  assert.equal((await agent.warm.claim({ spec: spec("lane-2", { warm: 2 }), ...SIZE })).status, 200);
  assert.equal((await agent.launch({ spec: spec("lane-2"), ...SIZE })).status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.warm.list().length, 2, "replenished to N");
  assert.equal((await agent.destroy("lane-2", "test")), true);
  assert.equal(agent.store.data.sandboxes[c.body.id], undefined);
});

test("a warm sandbox of another size or repo is not claimed", async () => {
  const { agent, markReady } = fixture();
  await agent.launch({ spec: spec("lane-1", { warm: 1 }), ...SIZE });
  await agent.warm.replenish();
  markReady();
  assert.equal((await agent.warm.claim({ spec: spec("l2", { warm: 1 }), cpus: 4, mem_gb: 3 })).status, 404);
  assert.equal((await agent.warm.claim({ spec: spec("l3", { warm: 1, repo: { slug: "o/other", url: "u", ref: "x" } }), ...SIZE })).status, 404);
});

test("router POST /sandboxes/claim: the agent holding a warm sandbox answers, else 404", async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    seen.push(`${init.method} ${u.hostname}${u.pathname}`);
    const body = u.pathname === "/capacity" ? { cpus_free: 4, mem_free_gb: 8 } : { id: JSON.parse(init.body ?? "{}").spec?.id, state: "running" };
    const status = u.pathname === "/warm/claim" && u.hostname === "cold" ? 404 : 200;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const mk = (names) => {
    const router = createRouter({ state_dir: tmpDir("cs-router-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repos: {} }, { fetchFn, now: () => 1 });
    for (const n of names) router.store.data.agents[n] = { url: `http://${n}:7711`, token: "t" };
    return router;
  };
  const r = await mk(["cold", "warmhost"]).claim(spec("lane-9", { warm: 1 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.agent, "warmhost");
  assert.equal((await mk(["cold"]).claim(spec("lane-9", { warm: 1 }))).status, 404);
  assert.ok(seen.includes("POST warmhost/warm/claim"));
});

test("warm-refresh.sh: incremental fetch to the lane's base ref, installed files kept", () => {
  const root = tmpDir("warm-refresh-");
  const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const origin = join(root, "origin"), work = join(root, "work");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "1");
  writeFileSync(join(origin, ".gitignore"), "node_modules\n");
  git(origin, "add", "."); git(origin, "commit", "-qm", "one");
  git(origin, "branch", "staging");
  git(root, "clone", "-q", origin, work);
  mkdirSync(join(work, "node_modules")); writeFileSync(join(work, "node_modules", "dep"), "installed");
  writeFileSync(join(work, "a.txt"), "dirty");
  git(origin, "checkout", "-q", "staging"); writeFileSync(join(origin, "a.txt"), "2"); git(origin, "commit", "-qam", "two");
  const sha = git(origin, "rev-parse", "HEAD");
  const r = spawnSync("bash", [join(IMG, "warm-refresh.sh"), "staging"], { cwd: work, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(work, "rev-parse", "HEAD"), sha);
  assert.equal(readFileSync(join(work, "a.txt"), "utf8"), "2");
  assert.ok(existsSync(join(work, "node_modules", "dep")), "dependencies stay installed");
});

test("entrypoint claim loader: lane env, argv and ref load verbatim, quotes included", () => {
  const sh = readFileSync(join(IMG, "entrypoint.sh"), "utf8");
  const m = /eval "\$\(node -e '([\s\S]*?)'\n?\s*\)"/.exec(sh);
  assert.ok(m, "claim loader present");
  const dir = tmpDir("claim-");
  const claim = join(dir, "claim.json");
  writeFileSync(claim, JSON.stringify({ env: { GH_TOKEN: "it's a 'secret'", "bad-key": "x" }, command: ["forgedock", "run-issue", "7", "--note", "a b'c"], ref: "staging" }));
  const script = m[1].replace("/claim/claim.json", claim);
  const out = spawnSync("bash", ["-c", `eval "$(node -e '${script.replace(/'/g, `'\\''`)}')"; printf '%s|%s|%s|%s' "$GH_TOKEN" "$CS_CLAIM_REF" "$#" "$5"`], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "it's a 'secret'|staging|5|a b'c");
});

test("#4935 relay from a warm-claimed sandbox is queued under the lane id, an unclaimed one under its own id", async (t) => {
  const seen = [];
  const stub = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ rid: "r1" })); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  let now = 1_000_000;
  const docker = fakeDocker();
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 0 }, router_url: `http://127.0.0.1:${stub.address().port}`, state_dir: tmpDir("cs-warm-relay-"), allow_cpus: 8, allow_mem_gb: 16, lease_ttl_s: 600, token: "t" }, { docker, now: () => now, log: quiet, live: () => ({ ok: true }) });
  const srv = createServer(agent.handle);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => { srv.close(); stub.close(); });
  const post = (id, rid, token) => fetch(`http://127.0.0.1:${srv.address().port}/sandboxes/${id}/relay${rid ? `/${rid}` : ""}`, { method: rid ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: rid ? undefined : JSON.stringify({ argv: ["obs-psql"] }) });

  await agent.launch({ spec: spec("lane-1", { warm: 1 }), ...SIZE });
  await agent.warm.replenish();
  for (const r of Object.values(agent.store.data.sandboxes)) if (r.warm) { mkdirSync(join(r.dir, "out"), { recursive: true }); writeFileSync(join(r.dir, "out", "warm-ready"), ""); }
  const c = await agent.warm.claim({ spec: spec("lane-2", { warm: 1 }), ...SIZE });
  assert.equal(c.status, 200);
  const warmId = c.body.id, warmRec = agent.store.data.sandboxes[warmId];
  assert.notEqual(warmId, "lane-2");
  assert.equal((await post(warmId, null, warmRec.credToken)).status, 200);
  assert.equal((await post(warmId, "r1", warmRec.credToken)).status, 200);
  assert.deepEqual(seen, ["POST /agent/relay/lane-2", "GET /agent/relay/lane-2/r1"]);
  // An unclaimed (cold) sandbox keeps relaying under its own id.
  const cold = agent.store.data.sandboxes["lane-1"];
  seen.length = 0;
  assert.equal((await post("lane-1", null, cold.credToken)).status, 200);
  assert.deepEqual(seen, ["POST /agent/relay/lane-1"]);
});

test("#4936: a claim keeps the burst limit, so replenished warm sandboxes launch with it", async () => {
  const { agent, docker } = fixture();
  const limit = { lane_cpus: 4, lane_mem_gb: 6, lane_swap_gb: 0 };
  await agent.warm.claim({ spec: spec("lane-1", { warm: 1 }), ...SIZE, limit });
  assert.deepEqual(Object.values(agent.store.data.warm)[0].limit, limit, "the stored pool entry keeps the limit");
  await agent.warm.replenish();
  const runs = docker.runs.filter((a) => a.some((x) => String(x).startsWith("cs-warm-") || String(x).includes("warm-")));
  assert.ok(runs.length >= 1, "a warm sandbox was launched");
  for (const a of runs) assert.equal(a[a.indexOf("--cpus") + 1], "4", "launched with the burst lane_cpus, not the reservation");
});
