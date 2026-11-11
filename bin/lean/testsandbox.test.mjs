// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { envNamesOf, parseSandboxes, planNeeds, provisionSandboxes, sandboxFromCli, sandboxLine } from "./testsandbox.mjs";

const specs = parseSandboxes({
  postgres: "{ image: postgres:16, init: \"make migrate DB_URL=$SANDBOX_URL\", ttl: 30m }",
  redis: "{ image: redis:7 }",
  api: "{ compose: docker-compose.test.yml, service: api, needs: [postgres, redis] }",
  "http-replay": "{ fixtures: tests/fixtures/http/, for: integration }",
  broken: "{ ttl: 1m }",
});
const fakeDocker = () => {
  const calls = [], live = new Set();
  const docker = async (a) => {
    calls.push(a.join(" "));
    if (a[0] === "run") live.add(a[a.indexOf("--name") + 1]);
    if (a[0] === "rm") { live.delete(a[a.length - 1]); return ""; }
    if (a[0] === "compose" && a.includes("up")) live.add(a[2]);
    if (a[0] === "compose" && a.includes("down")) live.delete(a[2]);
    if (a[0] === "port") return "127.0.0.1:55432\n";
    return "";
  };
  return { docker, calls, live };
};
const fakeLedger = () => { const log = [], set = new Set(); return { log, set, register: (k, v) => { log.push(`register ${v}`); set.add(v); return true; }, release: (k, v) => { log.push(`release ${v}`); set.delete(v); return true; } }; };

test("parseSandboxes keeps valid entries, parses needs and drops invalid ones", () => {
  assert.deepEqual(Object.keys(specs).sort(), ["api", "http-replay", "postgres", "redis"]);
  assert.deepEqual(specs.api.needs, ["postgres", "redis"]);
  assert.equal(specs.postgres.init, "make migrate DB_URL=$SANDBOX_URL");
  assert.deepEqual(parseSandboxes(undefined), {});
});
test("envNamesOf collects unique env names across validate entries", () => {
  assert.deepEqual(envNamesOf({ validate: [{ id: "V1", env: ["postgres"] }, { id: "V2", env: "postgres, redis" }, { id: "V3" }] }), ["postgres", "redis"]);
  assert.deepEqual(envNamesOf({ validate: [{ id: "V1", command: "x" }] }), []);
});
test("planNeeds orders dependencies first and reports undefined names", () => {
  assert.deepEqual(planNeeds(["api", "nope"], specs), { order: ["postgres", "redis", "api"], missing: ["nope"] });
});
test("a lane whose plan has no env creates nothing and never calls the provider", async () => {
  const d = fakeDocker();
  const r = await provisionSandboxes({ names: [], specs, lane: "lean-1", docker: d.docker, exec: async () => ({ rc: 0 }) });
  assert.equal(r.ok, true);
  assert.deepEqual(d.calls, []);
});
test("postgres gets a migrated throwaway DB, the test env, and nothing is left running", async () => {
  const d = fakeDocker(), led = fakeLedger(), execs = [];
  const r = await provisionSandboxes({ names: ["postgres"], specs, lane: "lean-5", docker: d.docker, ledger: led, labels: ["forgedock.owner=1"], exec: async (a) => { execs.push(a); return { rc: 0 }; }, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.env.SANDBOX_POSTGRES_URL, "postgresql://postgres:sandbox@127.0.0.1:55432/postgres");
  assert.equal(execs[0].command, "make migrate DB_URL=$SANDBOX_URL");
  assert.equal(execs[0].env.SANDBOX_URL, r.env.SANDBOX_POSTGRES_URL);
  assert.ok(d.calls.some((c) => c.includes("--label forgedock.owner=1") && c.includes("--name forge-sbx-lean-5-postgres")));
  assert.ok(led.log.indexOf("register forge-sbx-lean-5-postgres") < d.calls.length); // registered before `docker run`
  assert.equal(d.live.size, 1);
  assert.match(r.lines[0], /^FORGE:SANDBOX \{"name":"postgres"/);
  await r.down();
  assert.equal(d.live.size, 0);
  assert.equal(led.set.size, 0);
});
test("the ledger entry is written before the container exists", async () => {
  const order = [], led = { register: (k, v) => order.push(`ledger ${v}`), release() {} };
  const docker = async (a) => { if (a[0] === "run") order.push("run"); if (a[0] === "port") return "0.0.0.0:1\n"; return ""; };
  await provisionSandboxes({ names: ["redis"], specs, lane: "lean-2", docker, ledger: led, exec: async () => ({ rc: 0 }), sleep: async () => {} });
  assert.deepEqual(order, ["ledger forge-sbx-lean-2-redis", "run"]);
});
test("two lanes get distinct container names", async () => {
  const names = [];
  const docker = async (a) => { if (a[0] === "run") names.push(a[a.indexOf("--name") + 1]); if (a[0] === "port") return "127.0.0.1:1\n"; return ""; };
  for (const lane of ["lean-1", "lean-2"]) await provisionSandboxes({ names: ["redis"], specs, lane, docker, exec: async () => ({ rc: 0 }), sleep: async () => {} });
  assert.equal(new Set(names).size, 2);
});
test("an env name no entry defines is a typed unavailable result, not a skip", async () => {
  const d = fakeDocker();
  const r = await provisionSandboxes({ names: ["mysql"], specs, lane: "lean-1", docker: d.docker, exec: async () => ({ rc: 0 }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_env");
  assert.deepEqual(d.calls, []);
});
test("a host without docker is a typed no_docker result and nothing is created", async () => {
  const r = await provisionSandboxes({ names: ["postgres"], specs, lane: "lean-1", docker: async () => { throw new Error("docker: command not found"); }, exec: async () => ({ rc: 0 }) });
  assert.equal(r.reason, "no_docker");
});
test("a failing init tears down what was created and reports failed", async () => {
  const d = fakeDocker();
  const r = await provisionSandboxes({ names: ["postgres"], specs, lane: "lean-1", docker: d.docker, exec: async () => ({ rc: 2 }), sleep: async () => {} });
  assert.equal(r.reason, "failed");
  assert.equal(d.live.size, 0);
});
test("needs start first and compose services come up and go down", async () => {
  const d = fakeDocker();
  const r = await provisionSandboxes({ names: ["api"], specs, lane: "lean-9", docker: d.docker, exec: async () => ({ rc: 0 }), sleep: async () => {} });
  assert.equal(r.ok, true);
  const runs = d.calls.filter((c) => c.startsWith("run")).map((c) => c.match(/--name (\S+)/)[1]);
  assert.deepEqual(runs, ["forge-sbx-lean-9-postgres", "forge-sbx-lean-9-redis"]);
  assert.ok(d.calls.some((c) => c.startsWith("compose -p forge-sbx-lean-9-api")));
  await r.down();
  assert.equal(d.live.size, 0);
});
test("a fixtures entry exports the replay dir and needs no docker", async () => {
  const r = await provisionSandboxes({ names: ["http-replay"], specs, lane: "lean-1", docker: async () => { throw new Error("no docker"); }, exec: async () => ({ rc: 0 }), cwd: "/work/wt" });
  assert.equal(r.ok, true);
  assert.equal(r.env.SANDBOX_HTTP_REPLAY_DIR, "/work/wt/tests/fixtures/http");
});
test("sandboxLine carries name, duration and cost", () => {
  assert.equal(sandboxLine({ name: "redis", kind: "container", ms: 5 }), 'FORGE:SANDBOX {"name":"redis","kind":"container","ms":5,"cost_usd":0}');
});
test("forgedock sandbox up prints the env, ls lists and down removes", async () => {
  const d = fakeDocker(), led = fakeLedger(), out = [];
  const entries = [];
  const ledger = { register: (k, v, x) => { entries.push({ value: v, ...x }); led.register(k, v); }, release: (k, v) => { const i = entries.findIndex((e) => e.value === v); if (i >= 0) entries.splice(i, 1); }, entries: () => entries, remove: () => true };
  const o = (t) => out.push(t);
  assert.equal(await sandboxFromCli(["up", "redis"], { specs, out: o, docker: d.docker, exec: async () => ({ rc: 0 }), ledger }), 0);
  assert.ok(out.some((l) => l.startsWith("SANDBOX_REDIS_URL=redis://127.0.0.1:55432")));
  out.length = 0;
  await sandboxFromCli(["ls"], { specs, out: o, ledger });
  assert.match(out[0], /forge-sbx-operator-redis/);
  assert.equal(await sandboxFromCli(["down"], { specs, out: o, docker: d.docker, ledger }), 0);
  assert.equal(d.live.size, 0);
  assert.equal(await sandboxFromCli(["up"], { specs, out: o, ledger }), 2);
});

test("lanes sharing the batch image cache inspect an image once", async () => {
  const { batchImageCache } = await import("./testsandbox.mjs");
  batchImageCache.clear();
  let inspects = 0;
  const docker = async (a) => { if (a[0] === "image") inspects++; if (a[0] === "port") return "0.0.0.0:49160\n"; return ""; };
  const specs = parseSandboxes({ redis: { image: "redis:7" } });
  for (const lane of ["a", "b"]) {
    const r = await provisionSandboxes({ names: ["redis"], specs, lane, docker, exec: async () => ({ rc: 0 }), cache: batchImageCache, sleep: async () => {} });
    assert.equal(r.ok, true);
    await r.down();
  }
  assert.equal(inspects, 1);
});
