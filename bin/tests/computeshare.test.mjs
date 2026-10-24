// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createAgent, safeName } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { tmpDir } from "./_tmp.mjs";

function fakeDocker() {
  const containers = new Map();
  return {
    containers,
    runs: [],
    async run(args) { const name = args[args.indexOf("--name") + 1]; this.runs.push(args); containers.set(name, { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }); return "cid"; },
    async inspect(name) { return containers.get(name) ?? null; },
    async remove(name) { containers.delete(name); },
    async listLabelled() { return [...containers.keys()]; },
    async wipe() {},
    volumes: new Set(),
    async listVolumes(prefix) { return [...this.volumes].filter((v) => v.startsWith(prefix)); },
    async removeVolume(v) { this.volumes.delete(v); },
  };
}

const quiet = { info() {}, warn() {}, error() {} };
const spec = (id, extra = {}) => ({ id, issue: 1, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, env: { GH_TOKEN: "secret-value" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json", ...extra });

function agentFixture(opts = {}) {
  let t = 1_000_000;
  const docker = fakeDocker();
  const dir = tmpDir("cs-agent-");
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: dir, allow_cpus: 4, allow_mem_gb: 8, lease_ttl_s: 600, token: "agent-token", ...opts }, { docker, now: () => t, log: quiet, live: opts.live ?? (() => ({ ok: true })) });
  return { agent, docker, dir, advance: (ms) => { t += ms; } };
}

test("agent launch is idempotent and secrets never reach docker argv", async () => {
  const { agent, docker } = agentFixture();
  const a = await agent.launch({ spec: spec("fdrsbx-b1-1"), cpus: 2, mem_gb: 3 });
  const b = await agent.launch({ spec: spec("fdrsbx-b1-1"), cpus: 2, mem_gb: 3 });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(docker.runs.length, 1);
  assert.ok(!docker.runs[0].join(" ").includes("secret-value"));
  assert.ok(docker.runs[0].includes("--cpus") && docker.runs[0].includes("3072m"));
});

test("agent refuses past its reservation with 503", async () => {
  const { agent } = agentFixture();
  assert.equal((await agent.launch({ spec: spec("x1"), cpus: 2, mem_gb: 3 })).status, 201);
  assert.equal((await agent.launch({ spec: spec("x2"), cpus: 2, mem_gb: 3 })).status, 201);
  const third = await agent.launch({ spec: spec("x3"), cpus: 2, mem_gb: 3 });
  assert.equal(third.status, 503);
  assert.equal(third.retryAfter, 60);
});

test("reaper destroys sandboxes whose lease expired and removes orphan containers", async () => {
  const { agent, docker, advance } = agentFixture();
  await agent.launch({ spec: spec("old"), cpus: 1, mem_gb: 1 });
  docker.containers.set("cs-orphan", { running: true });
  advance(601_000);
  await agent.reap();
  assert.equal(docker.containers.size, 0);
  assert.deepEqual(Object.keys(agent.store.data.sandboxes), []);
});

test("exited container frees its reservation", async () => {
  const { agent, docker } = agentFixture();
  await agent.launch({ spec: spec("e1"), cpus: 4, mem_gb: 8 });
  assert.equal(agent.capacity().cpus_free, 0);
  docker.containers.set(safeName("e1"), { running: false, exitCode: 0, finishedAt: new Date().toISOString() });
  await agent.refresh(agent.store.data.sandboxes.e1);
  assert.equal(agent.capacity().cpus_free, 4);
});

function routerFixture(agentsCaps) {
  let t = 5_000_000;
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const name = u.hostname;
    calls.push(`${init.method} ${name}${u.pathname}`);
    const cap = agentsCaps[name];
    let status = 200, body = {};
    if (u.pathname === "/capacity") body = cap;
    else if (u.pathname === "/sandboxes" && init.method === "POST") { const p = JSON.parse(init.body); body = { id: p.spec.id, state: "running", env_has_yaml: Boolean(p.spec.env?.CS_FORGE_YAML_B64) }; status = 201; }
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const dir = tmpDir("cs-router-");
  mkdirSync(join(dir, "cfg"));
  writeFileSync(join(dir, "cfg", "forge.yaml"), "project: {}\n");
  const router = createRouter({ state_dir: dir, lane: { cpus: 2, mem_gb: 3 }, enroll_token: "enroll", forgedock_token: "fd", abandon_after_s: 1800, repos: { "o/r": { forge_yaml: join(dir, "cfg", "forge.yaml") } } }, { fetchFn, now: () => t, log: quiet });
  for (const name of Object.keys(agentsCaps)) router.store.data.agents[name] = { url: `http://${name}:7711`, token: "t" };
  return { router, calls, advance: (ms) => { t += ms; } };
}

test("router places on the host with the most free CPU and injects forge.yaml", async () => {
  const { router } = routerFixture({ small: { cpus_free: 2, mem_free_gb: 4 }, big: { cpus_free: 8, mem_free_gb: 16 } });
  const r = await router.launch(spec("p1"));
  assert.equal(r.status, 201);
  assert.equal(r.body.agent, "big");
  assert.equal(r.body.env_has_yaml, true);
  assert.equal(router.store.data.sandboxes.p1.agent, "big");
});

test("router answers 503 with retry-after when no host fits", async () => {
  const { router } = routerFixture({ tiny: { cpus_free: 1, mem_free_gb: 2 } });
  const r = await router.launch(spec("p2"));
  assert.equal(r.status, 503);
  assert.ok(r.retryAfter > 0);
});

test("router renews leases while polled and destroys abandoned sandboxes", async () => {
  const { router, calls, advance } = routerFixture({ big: { cpus_free: 8, mem_free_gb: 16 } });
  await router.launch(spec("p3"));
  await router.tick();
  assert.ok(calls.includes("POST big/sandboxes/p3/lease"));
  advance(1_801_000);
  await router.tick();
  assert.ok(calls.includes("DELETE big/sandboxes/p3"));
  assert.equal(router.store.data.sandboxes.p3, undefined);
});

test("enrollment needs the enroll token and issues a per-agent token", () => {
  const { router } = routerFixture({});
  assert.equal(router.enroll({ token: "wrong", name: "legion", url: "http://100.1.1.1:7711" }).status, 401);
  const ok = router.enroll({ token: "enroll", name: "Legion", url: "http://100.1.1.1:7711" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, "legion");
  assert.match(ok.body.agent_token, /^[0-9a-f]{64}$/);
});

test("one-time install code works for bootstrap until expiry and enrolls exactly once", () => {
  const { router, advance } = routerFixture({});
  const { code } = router.issueCode();
  assert.equal(router.enroll({ token: code, name: "legion", url: "http://100.1.1.2:7711" }).status, 200);
  assert.equal(router.enroll({ token: code, name: "again", url: "http://100.1.1.3:7711" }).status, 401);
  const late = router.issueCode().code;
  advance(1_801_000);
  assert.equal(router.enroll({ token: late, name: "late", url: "http://100.1.1.4:7711" }).status, 401);
});

test("sandbox gets a per-sandbox credential relay, never the router or agent token", async () => {
  const { agent, docker } = agentFixture();
  await agent.launch({ spec: spec("c1"), cpus: 1, mem_gb: 1 });
  const args = docker.runs[0];
  assert.ok(args.includes("host.docker.internal:host-gateway"));
  const rec = agent.store.data.sandboxes.c1;
  assert.match(rec.credToken, /^[0-9a-f]{48}$/);
  assert.notEqual(rec.credToken, "agent-token");
});

test("docker sandbox: private daemon sidecar, lane in its netns, shared /work, split reservation, full teardown", async () => {
  const { agent, docker } = agentFixture();
  await agent.launch({ spec: spec("d1", { docker: true }), cpus: 3, mem_gb: 5 });
  const [dind, lane] = docker.runs;
  assert.ok(dind.includes("--privileged") && dind.includes("--host=tcp://127.0.0.1:2375") && dind.includes("--tls=false"));
  assert.ok(!dind.join(" ").includes("0.0.0.0"));
  assert.ok(dind.includes("cs-work-d1:/work") && lane.includes("cs-work-d1:/work"));
  assert.deepEqual(lane.slice(lane.indexOf("--network"), lane.indexOf("--network") + 2), ["--network", "container:cs-d1-dind"]);
  assert.equal(lane[lane.indexOf("--cpus") + 1], "2");
  assert.equal(dind[dind.indexOf("--cpus") + 1], "1");
  assert.ok(!lane.join(" ").includes("/var/run/docker.sock") && !dind.join(" ").includes("/var/run/docker.sock"));
  docker.volumes.add("cs-work-d1");
  await agent.destroy("d1", "test");
  assert.equal(docker.containers.size, 0);
  assert.equal(docker.volumes.size, 0);
});

test("router reserves lane + daemon capacity for docker-enabled repos", async () => {
  const sent = [];
  const caps = { small: { cpus_free: 2, mem_free_gb: 4 }, big: { cpus_free: 3, mem_free_gb: 5 } };
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/capacity") return new Response(JSON.stringify(caps[u.hostname]), { status: 200 });
    sent.push({ host: u.hostname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ state: "running" }), { status: 201 });
  };
  const router = createRouter({ state_dir: tmpDir("cs-rd-"), lane: { cpus: 2, mem_gb: 3 }, repos: { "o/r": { docker: true } }, enroll_token: "e", forgedock_token: "f" }, { fetchFn, log: quiet });
  for (const n of Object.keys(caps)) router.store.data.agents[n] = { url: `http://${n}:7711`, token: "t" };
  const r = await router.launch(spec("dk1"));
  assert.equal(r.body.agent, "big");
  assert.equal(sent[0].body.cpus, 3);
  assert.equal(sent[0].body.mem_gb, 5);
  assert.equal(sent[0].body.spec.docker, true);
});

test("bootstrap script passes lane sizing to the installer only when given", async () => {
  const { router } = routerFixture({});
  const { code } = router.issueCode();
  const run = async (q) => { let body = ""; const res = { writeHead() {}, end(b) { body = b; } };
    await router.handle({ method: "GET", url: `/bootstrap/install.ps1?token=${code}${q}`, headers: {}, socket: {} }, res); return body; };
  assert.match(await run("&cpus=14&mem=22"), /-BundlePath \(Join-Path \$tmp 'bundle\.tar\.gz'\) -AllowCpus 14 -AllowMemGb 22/);
  const plain = await run("");
  assert.ok(!plain.includes("-AllowCpus") && !plain.includes("${sizing}"));
});

// The resize path rewrites the Windows-side .wslconfig on a WSL kernel; this test covers the plain-Linux branch.
const onWsl = (() => { try { return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")); } catch { return false; } })();

test("resize updates the lane allowance (non-WSL host) and refuses while sandboxes run", { skip: onWsl && "WSL kernel: resize edits .wslconfig" }, async () => {
  const { agent } = agentFixture();
  await agent.launch({ spec: spec("busy"), cpus: 1, mem_gb: 1 });
  const h = (body) => new Promise((resolve) => {
    const req = { method: "POST", url: "/admin/resize", headers: { authorization: "Bearer agent-token" }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    agent.handle(req, { writeHead(s) { this.s = s; }, end(b) { resolve({ status: this.s, body: JSON.parse(b) }); } });
  });
  assert.equal((await h({ cpus: 8, mem_gb: 12 })).status, 409);
  const drain = await h({ cpus: 6, mem_gb: 10, drain: true });
  assert.equal(drain.status, 202);
  assert.equal(agent.capacity().paused, true);
  assert.equal((await agent.launch({ spec: spec("new"), cpus: 1, mem_gb: 1 })).status, 503);
  await agent.destroy("busy", "test");
  await agent.reap();
  assert.equal(agent.capacity().cpus_total, 6);
  assert.equal(agent.capacity().paused, false);
  const ok = await h({ cpus: 8, mem_gb: 12 });
  assert.equal(ok.status, 202);
  assert.equal(agent.capacity().cpus_total, 8);
  assert.equal(agent.capacity().mem_total_gb, 12);
  assert.equal((await h({ cpus: 8, mem_gb: 12, vm_mem_gb: 10 })).status, 400);
});

test("usage sampling tracks peak and average against the reservation", async () => {
  const { agent, docker } = agentFixture();
  await agent.launch({ spec: spec("u1", { docker: true }), cpus: 3, mem_gb: 5 });
  let n = 0;
  docker.stats = async () => { n++; return { "cs-u1": { cpu: n === 1 ? 0.5 : 1.5, mem_gb: 1 }, "cs-u1-dind": { cpu: 0.1, mem_gb: 0.5 } }; };
  await agent.reap(); await agent.reap();
  const u = agent.capacity().usage["1"];
  assert.equal(u.cpu_peak, 1.6); assert.equal(u.cpu_avg, 1.1); assert.equal(u.mem_peak_gb, 1.5);
  assert.deepEqual(u.reserved, { cpus: 3, mem_gb: 5 });
});

test("finished sandboxes keep their usage in the history", async () => {
  const { agent, docker, dir } = agentFixture();
  await agent.launch({ spec: spec("h1"), cpus: 2, mem_gb: 3 });
  docker.stats = async () => ({ "cs-h1": { cpu: 1.2, mem_gb: 2.4 } });
  await agent.reap();
  await agent.destroy("h1", "test");
  const rows = (await import("node:fs")).readFileSync(join(dir, "usage-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cpu_peak, 1.2);
  assert.equal(rows[0].mem_peak_gb, 2.4);
});

test("burst model: small reservation for placement, larger hard cap per container", async () => {
  const { agent, docker } = agentFixture();
  const limit = { lane_cpus: 3, lane_mem_gb: 4, dind_cpus: 1, dind_mem_gb: 2 };
  for (let i = 0; i < 4; i++) assert.equal((await agent.launch({ spec: spec(`b${i}`), cpus: 1, mem_gb: 2, limit })).status, 201);
  assert.equal(agent.capacity().cpus_free, 0); // 4 lanes of 1 CPU reservation fill allow_cpus 4
  const lane = docker.runs[0];
  assert.equal(lane[lane.indexOf("--cpus") + 1], "3");
  assert.equal(lane[lane.indexOf("--memory") + 1], "4096m");
  await agent.launch({ spec: spec("bd", { docker: true }), cpus: 0, mem_gb: 0, limit });
  const [dind, dlane] = docker.runs.slice(-2);
  assert.equal(dind[dind.indexOf("--memory") + 1], "2048m");
  assert.equal(dlane[dlane.indexOf("--cpus") + 1], "3");
});

test("live headroom refuses a launch even with reservation room", async () => {
  const { agent } = agentFixture({ live: () => ({ ok: false, reason: "only 1 GB available" }) });
  const r = await agent.launch({ spec: spec("x"), cpus: 1, mem_gb: 1 });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /host busy/);
});

test("router sends burst limits when configured and reserves only the small slice", async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/capacity") return new Response(JSON.stringify({ cpus_free: 10, mem_free_gb: 20 }), { status: 200 });
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ state: "running" }), { status: 201 });
  };
  const router = createRouter({ state_dir: tmpDir("cs-rb-"), lane: { cpus: 0.5, mem_gb: 1, limit: { cpus: 4, mem_gb: 4 } }, dind: { cpus: 0.25, mem_gb: 0.5, limit: { cpus: 2, mem_gb: 3 } }, repos: { "o/d": { docker: true } }, enroll_token: "e", forgedock_token: "f" }, { fetchFn, log: quiet });
  router.store.data.agents.a = { url: "http://a:7711", token: "t" };
  await router.launch(spec("plain"));
  await router.launch(spec("dock", { repo: { slug: "o/d", url: "", ref: null } }));
  assert.deepEqual([sent[0].cpus, sent[0].mem_gb, sent[0].limit], [0.5, 1, { lane_cpus: 4, lane_mem_gb: 4, lane_swap_gb: 0 }]);
  assert.deepEqual([sent[1].cpus, sent[1].mem_gb], [0.75, 1.5]);
  assert.deepEqual(sent[1].limit, { lane_cpus: 4, lane_mem_gb: 4, lane_swap_gb: 0, dind_cpus: 2, dind_mem_gb: 3, dind_swap_gb: 0 });
});

test("a teardown that fails and is retried records usage once", async () => {
  const { agent, docker, dir } = agentFixture();
  await agent.launch({ spec: spec("dup"), cpus: 1, mem_gb: 1 });
  docker.stats = async () => ({ "cs-dup": { cpu: 0.5, mem_gb: 0.5 } });
  await agent.reap();
  const realRemove = docker.remove.bind(docker); let fail = true;
  docker.remove = async (n) => { if (fail) { fail = false; throw new Error("busy"); } return realRemove(n); };
  await assert.rejects(agent.destroy("dup", "t1"));
  await agent.destroy("dup", "t2");
  const lines = (await import("node:fs")).readFileSync(join(dir, "usage-history.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});

test("credential relay hands out access tokens only; no refresh token leaves the router host", async () => {
  const dir = tmpDir("cs-cred-");
  const cfgDir = join(dir, ".claude");
  mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-xyz", refreshToken: "refresh-SECRET", expiresAt: Date.now() + 3 * 3600000 } }));
  const ghBin = join(dir, "gh");
  writeFileSync(ghBin, "#!/bin/sh\necho ghs_short_lived\n", { mode: 0o755 });
  const r = createRouter({ state_dir: dir, enroll_token: "enroll", forgedock_token: "fd", gh_bin: ghBin, claude_config_dirs: [cfgDir] }, { fetchFn: async () => new Response("{}"), log: quiet });
  r.store.data.agents.a1 = { url: "http://a1:7711", token: "agent-secret" };
  const get = (path) => new Promise((resolve) => {
    r.handle({ method: "GET", url: path, headers: { authorization: "Bearer agent-secret" }, socket: {} }, { writeHead(s) { this.s = s; }, setHeader() {}, end(b) { resolve({ status: this.s, text: String(b) }); } });
  });
  const claude = await get("/agent/creds/claude");
  const github = await get("/agent/creds/github");
  assert.equal(claude.status, 200);
  assert.equal(JSON.parse(claude.text).token, "access-xyz");
  assert.equal(github.status, 200);
  assert.equal(JSON.parse(github.text).token, "ghs_short_lived");
  assert.doesNotMatch(claude.text + github.text, /refresh/i);
});

const installDir = new URL("../../pool/install/", import.meta.url).pathname;
const linuxInstaller = join(installDir, "install-agent-linux.sh");

test("linux installer scripts parse and install the systemd unit without WSL", () => {
  for (const f of ["install-agent-linux.sh", "install-agent.sh"]) assert.equal(spawnSync("bash", ["-n", join(installDir, f)]).status, 0, f);
  assert.ok(!/wsl/i.test(readFileSync(linuxInstaller, "utf8")));
  assert.match(readFileSync(join(installDir, "install-agent.sh"), "utf8"), /computeshare-agent\.service/);
});

test("linux installer --dry-run resolves settings and redacts the token", () => {
  const r = spawnSync("bash", [linuxInstaller, "--dry-run", "--router", "http://100.1.1.1:7710", "--token", "sekret", "--name", "box", "--cpus", "6", "--mem", "9", "--port", "7712"],
    { encoding: "utf8", env: { ...process.env, AGENT_URL: "http://100.2.2.2:7712" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /router=http:\/\/100\.1\.1\.1:7710 name=box url=http:\/\/100\.2\.2\.2:7712 port=7712 cpus=6 mem_gb=9/);
  assert.ok(!r.stdout.includes("sekret"));
});

test("linux installer requires a router and token", () => {
  const env = { ...process.env }; delete env.ROUTER_URL; delete env.ENROLL_TOKEN;
  assert.notEqual(spawnSync("bash", [linuxInstaller, "--dry-run"], { env }).status, 0);
});

test("lane image version equals the dispatcher version (#4545)", async () => {
  const { laneImageTag, laneBuildArgs, versionOf, repoRoot } = await import("../pool/version.mjs");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(versionOf().version, pkg.version);
  assert.equal(laneImageTag(pkg.version), `forgedock-lane:${pkg.version}`);
  assert.deepEqual(laneBuildArgs(pkg.version), { FORGEDOCK_VERSION: pkg.version });
  const df = readFileSync(join(repoRoot, "pool", "image", "Dockerfile"), "utf8");
  assert.match(df, /^ARG FORGEDOCK_VERSION$/m, "no separate version pin in the Dockerfile");
  const dir = tmpDir("lane-image-");
  const docker = { ...fakeDocker(), builds: [], async hasImage() { return false; }, async build(d, tag, args) { this.builds.push({ tag, args }); } };
  const agent = createAgent({ state_dir: dir, allow_cpus: 2, allow_mem_gb: 4, router_url: "http://x" }, { docker, log: quiet });
  await agent.ensureImage();
  assert.deepEqual(docker.builds, [{ tag: `forgedock-lane:${pkg.version}`, args: { FORGEDOCK_VERSION: pkg.version } }]);
});

test("forgedock update upgrades pool agents only when a router is configured (#4545)", async () => {
  const { upgradeAgentsAfterUpdate } = await import("../pool/version.mjs");
  const dir = tmpDir("upd-hook-");
  const configPath = join(dir, "router.json");
  const calls = [];
  const runPoolCli = async (argv) => { calls.push(argv); };
  assert.equal(await upgradeAgentsAfterUpdate({ configPath, runPoolCli }), "skipped");
  assert.equal(calls.length, 0);
  writeFileSync(configPath, "{}");
  assert.equal(await upgradeAgentsAfterUpdate({ configPath, runPoolCli }), "upgraded");
  assert.deepEqual(calls, [["upgrade", "--config", configPath]]);
  const warns = [];
  assert.equal(await upgradeAgentsAfterUpdate({ configPath, runPoolCli: async () => { throw new Error("boom"); }, warn: (m) => warns.push(m) }), "failed");
  assert.match(warns[0], /boom/);
});
