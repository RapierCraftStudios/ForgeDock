// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4778 read-only capability relay end to end: the real pool/image/cs-relay script in "the sandbox" -> a real pool agent
// HTTP server (per-sandbox credential) -> a real router HTTP server (queue) <- the dispatcher's remoteProvider status poll
// over httpTransport, which gates and runs the allowlisted command on "the host" and answers. Only the lane container is fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { chmodSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { httpTransport, remoteProvider } from "../lean/sandbox-remote.mjs";
import { runRelayed } from "../lean/relay.mjs";
import { tmpDir } from "./_tmp.mjs";

const CS_RELAY = fileURLToPath(new URL("../../pool/image/cs-relay", import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };
const listen = (handle) => new Promise((resolve) => { const s = createServer(handle); s.listen(0, "127.0.0.1", () => resolve(s)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;

function fakeDocker() {
  const containers = new Map();
  return {
    async run(args) { containers.set(args[args.indexOf("--name") + 1], { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }); return "cid"; },
    async inspect(name) { return containers.get(name) ?? null; },
    async remove(name) { containers.delete(name); },
    async listLabelled() { return [...containers.keys()]; },
    async wipe() {},
    async listVolumes() { return []; },
    async removeVolume() {},
  };
}

/** Run cs-relay like the lane would, with the sandbox's env; resolves {rc, stdout, stderr}. */
const csRelay = (argv, env) => new Promise((resolve) => {
  const p = spawn("bash", [CS_RELAY, ...argv], { env: { PATH: process.env.PATH, CS_RELAY_TIMEOUT_S: "30", ...env } });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += d; }); p.stderr.on("data", (d) => { stderr += d; });
  p.on("close", (rc) => resolve({ rc, stdout, stderr }));
});

test("#4778 relay: an allowlisted command runs on the host, a non-allowlisted one is refused, pre-fetch is served locally", async (t) => {
  const dir = tmpDir("relay-e2e-");
  // The host-only wrapper and a would-be dangerous command, both on the dispatching host; each logs that it ran.
  const hostBin = join(dir, "hostbin"), ranLog = join(dir, "ran.log");
  for (const [name, body] of [["obs-psql", `echo "obs-psql $*" >> ${ranLog}; echo " ?column? "; echo "  1 $OBS_KEY"; echo note >&2; exit 3`], ["evil", `echo evil >> ${ranLog}`]]) {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755);
  }
  const relayRun = (argv, o) => runRelayed(argv, { ...o, execFileFn: (cmd, args, opts, cb) => execFile(join(dir, cmd), args, { ...opts, env: { ...process.env, OBS_KEY: "host-key-123456" } }, cb) });

  const router = createRouter({ state_dir: tmpDir("relay-e2e-router-"), forgedock_token: "fd-token", lane: { cpus: 1, mem_gb: 1 } }, { log: quiet });
  const rs = await listen(router.handle);
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 0 }, router_url: url(rs), state_dir: tmpDir("relay-e2e-agent-"), allow_cpus: 4, allow_mem_gb: 8, lease_ttl_s: 600, token: "agent-token" },
    { docker: fakeDocker(), log: quiet, live: () => ({ ok: true }) });
  const as = await listen(agent.handle);
  t.after(() => { rs.close(); as.close(); });
  router.store.data.agents.a1 = { url: url(as), token: "agent-token", enrolledAt: new Date().toISOString() };

  const provider = remoteProvider({ batch: { id: "b1" }, repo: "o/r", transport: httpTransport({ endpoint: url(rs), token: "fd-token" }), env: { FD_SECRET: "host-key-123456" }, gitIdentity: () => null, relayRun,
    settings: { secrets: ["FD_SECRET"], relay: { prod_monitor: ["obs-*"] }, prefetch: () => [{ argv: ["obs-psql", "-c", "select 2"] }] } });
  assert.deepEqual(provider.relays, ["prod_monitor"]);
  const h = await provider.start({ issue: 7, args: [] });
  const rec = agent.store.data.sandboxes[h.id];
  assert.ok(rec, "the router placed the sandbox on the agent");
  const sandboxEnv = { CS_RELAY_BASE: `${url(as)}/sandboxes/${encodeURIComponent(h.id)}/relay`, CS_CRED_TOKEN: rec.credToken };
  // The lane's env (as the agent writes it) carries the relay endpoint and the pre-fetch, never the host key.
  const laneEnv = JSON.stringify(rec);
  assert.ok(!laneEnv.includes("host-key-123456"));

  // The dispatcher's status poll is what services the queue.
  let polling = true;
  const poll = (async () => { while (polling) { assert.equal(await provider.status(h), "running"); await new Promise((r) => setTimeout(r, 100)); } })();
  try {
    const ok = await csRelay(["obs-psql", "-c", "select 1; drop table x"], sandboxEnv);
    assert.equal(ok.rc, 3, ok.stderr);
    assert.equal(ok.stdout, " ?column? \n  1 [redacted]\n");
    assert.equal(ok.stderr, "note\n");

    const refused = await csRelay(["evil", "--now"], sandboxEnv);
    assert.equal(refused.rc, 126);
    assert.match(refused.stderr, /relay: evil not allowlisted/);
    const refusedPath = await csRelay([join(dir, "obs-psql")], sandboxEnv);
    assert.equal(refusedPath.rc, 126);

    // Another sandbox's credential (or none) cannot use this sandbox's relay.
    const forged = await csRelay(["obs-psql"], { ...sandboxEnv, CS_CRED_TOKEN: "nope" });
    assert.equal(forged.rc, 125);
    assert.match(forged.stderr, /relay unavailable/);
  } finally { polling = false; await poll; }

  // Pre-fetch: run on the host at dispatch, served from the lane env with no relay call (no relay base at all here).
  const spec = await (async () => { const specs = []; const tr = { async launch(s) { specs.push(s); return { id: s.id }; }, async status() { return "running"; }, async relayPending() { return []; }, async relayAnswer() {} };
    await remoteProvider({ batch: { id: "b2" }, repo: "o/r", transport: tr, env: { FD_SECRET: "host-key-123456" }, gitIdentity: () => null, relayRun, settings: { secrets: ["FD_SECRET"], relay: { prod_monitor: ["obs-*"] }, prefetch: () => [{ argv: ["obs-psql", "-c", "select 2"] }] } }).start({ issue: 8, args: [] });
    return specs[0]; })();
  const pre = await csRelay(["obs-psql", "-c", "select 2"], { CS_RELAY_PREFETCH_B64: spec.env.CS_RELAY_PREFETCH_B64 });
  assert.deepEqual([pre.rc, pre.stdout, pre.stderr], [3, " ?column? \n  1 [redacted]\n", "note\n"]);
  assert.ok(!Buffer.from(spec.env.CS_RELAY_PREFETCH_B64, "base64").toString().includes("host-key-123456"));
  assert.equal((await csRelay(["obs-psql", "-c", "select 3"], { CS_RELAY_PREFETCH_B64: spec.env.CS_RELAY_PREFETCH_B64 })).rc, 125);

  const ran = existsSync(ranLog) ? readFileSync(ranLog, "utf8") : "";
  assert.ok(!ran.includes("evil"), "a refused command never runs on the host");
  assert.match(ran, /obs-psql -c select 1; drop table x/);
});

test("#4778 router relay queue: owner-only, bounded, answered once, dropped with the sandbox", async (t) => {
  const router = createRouter({ state_dir: tmpDir("relay-q-router-"), forgedock_token: "fd-token" }, { log: quiet, fetchFn: async () => new Response("{}", { status: 404 }) });
  const rs = await listen(router.handle);
  t.after(() => rs.close());
  Object.assign(router.store.data.agents, { a1: { url: "http://a1", token: "tok-a1" }, a2: { url: "http://a2", token: "tok-a2" } });
  router.store.data.sandboxes.s1 = { agent: "a1", touched: Date.now() };
  const req = async (method, path, token, body) => { const r = await fetch(`${url(rs)}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };

  assert.equal((await req("POST", "/agent/relay/s1", "tok-a2", { argv: ["obs-psql"] })).status, 404, "another agent's sandbox");
  assert.equal((await req("POST", "/agent/relay/__proto__", "tok-a1", { argv: ["obs-psql"] })).status, 404);
  assert.equal((await req("POST", "/agent/relay/s1", "fd-token", { argv: ["obs-psql"] })).status, 401, "agent route needs an agent token");
  for (const argv of ["obs-psql", [], [1], Array(65).fill("a"), ["x".repeat(17 * 1024)]]) assert.equal((await req("POST", "/agent/relay/s1", "tok-a1", { argv })).status, 400);
  const { status, body: { rid } } = await req("POST", "/agent/relay/s1", "tok-a1", { argv: ["obs-psql", "-c", "1"] });
  assert.equal(status, 202);
  assert.equal((await req("GET", "/sandboxes/s1/relay", "tok-a1")).status, 401, "forgedock route needs the forgedock token");
  assert.deepEqual((await req("GET", "/sandboxes/s1/relay", "fd-token")).body, { requests: [{ rid, argv: ["obs-psql", "-c", "1"] }] });
  assert.deepEqual((await req("GET", `/agent/relay/s1/${rid}`, "tok-a1")).body, { state: "pending" });
  assert.equal((await req("GET", `/agent/relay/s1/${rid}`, "tok-a2")).status, 404);
  assert.equal((await req("POST", "/sandboxes/s1/relay/nope", "fd-token", { rc: 0 })).status, 404);
  assert.equal((await req("POST", `/sandboxes/s1/relay/${rid}`, "fd-token", { rc: 0, stdout: "1\n", stderr: "" })).status, 200);
  assert.deepEqual((await req("GET", "/sandboxes/s1/relay", "fd-token")).body, { requests: [] });
  assert.deepEqual((await req("GET", `/agent/relay/s1/${rid}`, "tok-a1")).body, { state: "done", rc: 0, stdout: "1\n", stderr: "" });
  assert.equal((await req("GET", `/agent/relay/s1/${rid}`, "tok-a1")).status, 404, "removed once read");
  for (let i = 0; i < 8; i++) assert.equal((await req("POST", "/agent/relay/s1", "tok-a1", { argv: ["obs-psql"] })).status, 202);
  assert.equal((await req("POST", "/agent/relay/s1", "tok-a1", { argv: ["obs-psql"] })).status, 429);
  assert.equal((await req("DELETE", "/sandboxes/s1", "fd-token")).status, 404);
  router.store.data.sandboxes.s1 = { agent: "a1", touched: Date.now() };
  assert.deepEqual((await req("GET", "/sandboxes/s1/relay", "fd-token")).body, { requests: [] }, "the queue went with the sandbox");
});
