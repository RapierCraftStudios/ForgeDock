// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6091: engine-version aware placement (prefer the orchestrator's engine, execution.min_lane_engine gate), status skew, left-behind report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "./router.mjs";
import { statusTable } from "./cli.mjs";
import { cmpVersion, agentsLeftBehind, upgradeAgentsAfterUpdate } from "./version.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const spec = (id, extra = {}) => ({ id, issue: 1, batch: "b", repo: { slug: "o/x", url: "https://github.com/o/x.git" }, command: ["x"], ...extra });
const TARGET = JSON.parse((await import("node:fs")).readFileSync("package.json", "utf8")).version; // the router's own target: this repo's package.json version (asserted below)

// `old` has more free cpus, so capacity order alone would pick it.
function fixture({ oldFree = true, newFree = true } = {}) {
  const posts = [];
  const caps = { old: { version: "1.66.0", cpus_free: 8, mem_free_gb: 16 }, new: { version: TARGET, cpus_free: newFree ? 2 : 0, mem_free_gb: newFree ? 16 : 0 } };
  if (!oldFree) caps.old = { version: "1.66.0", cpus_free: 0, mem_free_gb: 0 };
  const fetchFn = async (url, init) => {
    const u = new URL(url), h = u.hostname;
    if (u.pathname === "/capacity") return json(caps[h]);
    posts.push(`${h}${u.pathname}`);
    return json({ id: JSON.parse(init.body).spec.id, state: "running" }, u.pathname === "/warm/claim" ? 200 : 201);
  };
  const router = createRouter({ state_dir: tmpDir("cs-eng-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repo_root: process.cwd() }, { fetchFn, now: () => 5_000_000, log: quiet });
  router.store.data.agents.old = { url: "http://old:7711", token: "t" };
  router.store.data.agents.new = { url: "http://new:7711", token: "t" };
  return { router, posts };
}
const target = async () => (await import("./version.mjs")).versionOf(process.cwd()).version;
test("fixture target is the router's target", async () => assert.equal(await target(), TARGET));

test("launch prefers the agent on the orchestrator engine over one with more free cpus", async () => {
  const { router } = fixture();
  const r = await router.launch(spec("l1"));
  assert.equal(r.status, 201);
  assert.equal(r.body.agent, "new");
});

test("only the old agent free and min_lane_engine unset: the lane runs there and says its engine", async () => {
  const { router } = fixture({ newFree: false });
  const r = await router.launch(spec("l2"));
  assert.equal(r.status, 201);
  assert.equal(r.body.agent, "old");
  assert.equal(r.body.engine_version, "1.66.0");
});

test("min_lane_engine above the only free agent defers with pool.engine_old", async () => {
  const { router, posts } = fixture({ newFree: false });
  const r = await router.launch(spec("l3", { min_lane_engine: "1.67" }));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.engine_old");
  assert.ok(r.retryAfter > 0);
  assert.deepEqual(posts, []);
});

test("claim follows the same order and gate", async () => {
  const { router, posts } = fixture();
  const c = await router.claim(spec("c1", { min_lane_engine: "1.67" }));
  assert.equal(c.body.agent, "new");
  assert.deepEqual(posts, ["new/warm/claim"]);
});

test("status carries each agent's engine and flags skew; statusTable shows it", async () => {
  const { router } = fixture();
  const s = await router.status();
  const t = await target();
  const old = s.agents.find((a) => a.name === "old");
  assert.equal(old.engine_version, "1.66.0");
  assert.equal(old.engine_skew, cmpVersion("1.66.0", t) < 0);
  const table = statusTable([{ name: "a", ok: true, engine_version: "1.66.0", engine_skew: true }, { name: "b", ok: true, engine_version: TARGET, engine_skew: false }]);
  assert.match(table, /ENGINE/);
  assert.match(table, /1\.66\.0 SKEW/);
  assert.doesNotMatch(table.split("\n")[2], /SKEW/);
  assert.doesNotMatch(statusTable([{ name: "a", ok: true }]), /ENGINE/, "no version info: table as before");
});

test("cmpVersion is numeric, agents without a version never lag", () => {
  assert.ok(cmpVersion("1.10.0", "1.9.9") > 0);
  assert.equal(cmpVersion("1.67", "1.67.0"), 0);
  assert.equal(cmpVersion(undefined, "1.67.0"), null);
  assert.deepEqual(agentsLeftBehind([{ name: "a", ok: true, engine_version: "1.66.0" }, { name: "b", ok: true }, { name: "c", ok: true, engine_version: "1.67.0" }], "1.67.0"), [{ name: "a", version: "1.66.0" }]);
});

test("upgradeAgentsAfterUpdate names agents left behind and keeps its string result", async () => {
  const warned = [], dir = tmpDir("cs-eng-cfg-"), cfgPath = `${dir}/router.json`;
  (await import("node:fs")).writeFileSync(cfgPath, "{}");
  const r = await upgradeAgentsAfterUpdate({ configPath: cfgPath, runPoolCli: async () => {}, ensureRouterFresh: async () => ({ ok: true }), warn: (m) => warned.push(m),
    leftBehind: async () => ({ target: "1.67.0", rows: [{ name: "old", version: "1.66.0" }] }) });
  assert.equal(r, "upgraded");
  assert.match(warned[0], /left behind.*old 1\.66\.0/);
});

// #6265: a host whose lane_tools image is building or failed is skipped while another host is ready
function imgFixture(behaviour) {
  const posts = [];
  const caps = { a: { version: TARGET, cpus_free: 8, mem_free_gb: 16 }, b: { version: TARGET, cpus_free: 2, mem_free_gb: 16 } };
  let t = 5_000_000;
  const fetchFn = async (url, init) => {
    const u = new URL(url), h = u.hostname;
    if (u.pathname === "/capacity") return json(caps[h]);
    posts.push(h);
    return behaviour[h]?.(init) ?? json({ id: JSON.parse(init.body).spec.id, state: "running" }, 201);
  };
  const router = createRouter({ state_dir: tmpDir("cs-img-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repo_root: process.cwd() }, { fetchFn, now: () => t, log: quiet });
  router.store.data.agents.a = { url: "http://a:7711", token: "t" };
  router.store.data.agents.b = { url: "http://b:7711", token: "t" };
  return { router, posts, tick: (ms) => { t += ms; } };
}
const building = () => new Response(JSON.stringify({ error: "lane image x building", code: "lane_tools.building" }), { status: 503, headers: { "content-type": "application/json", "retry-after": "300" } });
const failed = () => json({ error: "build failed", code: "lane_tools.build_failed" }, 422);

test("a building host is skipped on later launches while another host is ready", async () => {
  const { router, posts } = imgFixture({ a: building });
  const r1 = await router.launch(spec("i1", { lane_tools: ["python"] }));
  assert.equal(r1.status, 201); assert.equal(r1.body.agent, "b"); // a tried first (more free), 503, then b
  posts.length = 0;
  const r2 = await router.launch(spec("i2", { lane_tools: ["python"] }));
  assert.equal(r2.body.agent, "b");
  assert.deepEqual(posts, ["b"], "the building host is not POSTed to again");
});

test("a failed-image host is skipped and its 422 does not end placement", async () => {
  const { router, posts } = imgFixture({ a: failed });
  const r = await router.launch(spec("i3", { lane_tools: ["python"] }));
  assert.equal(r.status, 201); assert.equal(r.body.agent, "b");
  posts.length = 0;
  await router.launch(spec("i4", { lane_tools: ["python"] }));
  assert.deepEqual(posts, ["b"]);
});

test("every host building: a short retry, not the agent's 300 s deferral", async () => {
  const { router } = imgFixture({ a: building, b: building });
  const r = await router.launch(spec("i5", { lane_tools: ["python"] }));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "lane_tools.building");
  assert.equal(r.retryAfter, 30);
});

test("the mark expires, so a finished build is placed on again; other tool sets are unaffected", async () => {
  const { router, posts, tick } = imgFixture({ a: building });
  await router.launch(spec("i6", { lane_tools: ["python"] }));
  posts.length = 0;
  await router.launch(spec("i7", { lane_tools: ["xvfb"] }));
  assert.equal(posts[0], "a", "a different tool set is not marked");
  posts.length = 0; tick(61_000);
  await router.launch(spec("i8", { lane_tools: ["python"] }));
  assert.equal(posts[0], "a", "re-probed after the mark expired");
});

test("all hosts failed the image: the 422 build_failed is returned", async () => {
  const { router } = imgFixture({ a: failed, b: failed });
  const r = await router.launch(spec("i9", { lane_tools: ["python"] }));
  assert.equal(r.status, 422); assert.equal(r.body.code, "lane_tools.build_failed");
});
