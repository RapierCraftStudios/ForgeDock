// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6041: per-repo agent affinity (repos.<slug>.agents / exclude_agents) shared by launch, claim, seedAgent and the capacity views.
import { test } from "node:test";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { createRouter } from "./router.mjs";
import { httpTransport } from "../lean/sandbox-remote.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const spec = (id, slug = "o/x") => ({ id, issue: 1, batch: "b", repo: { slug, url: `https://github.com/${slug}.git` }, command: ["x"] });

function fixture(repos, hosts = ["a", "b", "c"]) {
  const posts = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/capacity") return json({ cpus_free: 8 - hosts.indexOf(u.hostname), mem_free_gb: 16 });
    posts.push(`${u.hostname}${u.pathname}`);
    const p = JSON.parse(init.body);
    return json({ id: p.spec.id, state: "running" }, u.pathname === "/warm/claim" ? 200 : 201);
  };
  const router = createRouter({ state_dir: tmpDir("cs-aff-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repos }, { fetchFn, now: () => 5_000_000, log: quiet });
  for (const n of hosts) router.store.data.agents[n] = { url: `http://${n}:7711`, token: "t" };
  return { router, posts };
}
const placed = async (router, id, slug) => (await router.launch(spec(id, slug))).body.agent;

test("allowlist: every launch for the repo goes to an allowed agent", async () => {
  const { router } = fixture({ "o/x": { agents: ["b"] } });
  for (let i = 0; i < 3; i++) assert.equal(await placed(router, `l${i}`, "o/x"), "b");
  assert.equal(await placed(router, "other", "o/y"), "a"); // another repo is unrestricted
});

test("allowlist with no live allowed agent defers, never lands elsewhere", async () => {
  const { router, posts } = fixture({ "o/x": { agents: ["zz"] } });
  const r = await router.launch(spec("d1"));
  assert.equal(r.status, 503);
  assert.deepEqual(posts, []);
});

test("exclude list and both combine", async () => {
  assert.equal(await placed(fixture({ "o/x": { exclude_agents: ["a"] } }).router, "e1", "o/x"), "b");
  const { router } = fixture({ "o/x": { agents: ["a", "b"], exclude_agents: ["a"] } });
  assert.equal(await placed(router, "e2", "o/x"), "b");
});

test("unset, empty or non-array config keeps today's placement (best host first)", async () => {
  for (const repos of [{}, { "o/x": {} }, { "o/x": { agents: [] } }, { "o/x": { agents: "b" } }]) {
    assert.equal(await placed(fixture(repos).router, "u1", "o/x"), "a");
  }
});

test("claim honours the allowlist", async () => {
  const { router, posts } = fixture({ "o/x": { agents: ["c"] } });
  const r = await router.claim(spec("c1"));
  assert.equal(r.body.agent, "c");
  assert.deepEqual(posts, ["c/warm/claim"]);
});

test("seed pick honours the allowlist", async () => {
  const { router, posts } = fixture({ "o/x": { agents: ["b"] } });
  const call = (method, path, body) => new Promise((resolve) => {
    const r = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(r, { method, url: path, headers: { authorization: "Bearer fd", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } });
    const chunks = []; const res = { writeHead() { return res; }, setHeader() {}, write(c) { chunks.push(c); }, end(c) { if (c) chunks.push(c); resolve(Buffer.concat(chunks.map(Buffer.from)).toString()); } };
    router.handle(r, res);
  });
  await call("POST", "/sandboxes/s1/seed", { slug: "o/x", data_b64: "AA" });
  assert.deepEqual(posts, ["b/mirrors/seed"]);
});

test("status(repo) counts only the allowed agents; no repo counts all", async () => {
  const { router } = fixture({ "o/x": { agents: ["b", "c"], exclude_agents: ["c"] } });
  assert.equal((await router.status()).total, 3);
  const s = await router.status("o/x");
  assert.equal(s.total, 1); assert.equal(s.online, 1); assert.equal(s.agents[0].name, "b");
  assert.equal((await router.status("o/y")).total, 3);
});

test("transport.capacity appends ?repo= to /status and /agents only when a repo is given", async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return json({ agents: [{ ok: true, name: "a" }] }); };
  const t = httpTransport({ endpoint: "http://pool", fetchFn });
  await t.capacity();
  assert.deepEqual(urls, ["http://pool/status", "http://pool/agents"]);
  urls.length = 0;
  await t.capacity({ repo: "o/x y" });
  assert.deepEqual(urls, ["http://pool/status?repo=o%2Fx%20y", "http://pool/agents?repo=o%2Fx%20y"]);
});
