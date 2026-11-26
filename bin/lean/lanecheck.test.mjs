// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4866: lane preflight checks, the orchestrate admission hold, sandbox.clone typing and the heavy shim-loop finder.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { checkPoolAuth, checkPoolVersion, checkPathLoop, checkGhFields, availableFields, runLaneChecks, formatLaneChecks, UPGRADE_COMMAND, probeBatchEnv } from "./lanecheck.mjs";
import { which } from "./toolchain.mjs";
import { findShimLoops, heavyShimScript } from "./heavy.mjs";
import { orchestrate, deferPolicy } from "./orchestrate.mjs";
import { providerLanes, isCloneFailure, isEgressTimeout } from "./execution.mjs";

const pool = { mode: "remote", provider: "pool", tokenEnv: null, endpoint: null };
const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

describe("pool_auth", () => {
  it("fails naming the sources tried when no token resolves, passes once it appears (no restart)", async () => {
    let tok = null;
    const run = () => checkPoolAuth({ exec: pool, router: { endpoint: "http://r", token: tok }, credential: () => null });
    const a = await run();
    assert.equal(a.ok, false); assert.equal(a.code, "preflight.pool_auth"); assert.match(a.detail, /COMPUTESHARE_TOKEN/); assert.match(a.detail, /forgedock_token_file/);
    tok = "t";
    assert.equal((await run()).ok, true);
  });
  it("fails on a 401 ping and passes when the router is unreachable or no remote execution", async () => {
    const r = { endpoint: "http://r", token: "t" };
    assert.equal((await checkPoolAuth({ exec: pool, router: r, ping: async () => ({ status: 401 }) })).ok, false);
    assert.equal((await checkPoolAuth({ exec: pool, router: r, ping: async () => { throw new Error("down"); } })).ok, true);
    assert.equal((await checkPoolAuth({ exec: { mode: "local" }, router: null })).ok, true);
  });
});

describe("pool_auth shared resolver (#5131)", () => {
  const remote = { mode: "remote", provider: "remote", endpoint: "https://runner.example.com", tokenEnv: "COMPUTESHARE_TOKEN" };
  const router = { endpoint: "http://127.0.0.1:7710", token: "router-tok" };
  it("5131: FAILs remote on a non-matching endpoint although a router token exists, naming sources never the value", async () => {
    const a = await checkPoolAuth({ exec: remote, router, credential: () => null });
    assert.equal(a.ok, false); assert.equal(a.code, "preflight.pool_auth"); assert.equal(a.scope, "remote");
    assert.match(a.detail, /COMPUTESHARE_TOKEN/); assert.match(a.detail, /not the local router/); assert.doesNotMatch(a.detail, /router-tok/);
    const viaIo = await checkPoolAuth({ exec: remote, router, poolToken: () => ({ token: null, source: null }) });
    assert.equal(viaIo.ok, false);
    assert.equal((await checkPoolAuth({ exec: { ...remote, endpoint: "http://127.0.0.1:7710/" }, router, credential: () => null })).ok, true, "matching endpoint: router token applies");
  });
  it("5131: runLaneChecks uses io.poolToken for the auth check and the agents read, and FAILs a rejected token", async () => {
    const calls = [];
    const io = { router: () => router, poolToken: (exec, r) => { calls.push([exec.provider, r?.endpoint]); return { token: "tok", source: "token_file" }; },
      ping: async (_e, t) => ({ status: t === "tok" ? 401 : 200 }), agents: async (_e, t) => { calls.push(["agents", t]); return []; } };
    const checks = await runLaneChecks({ exec: remote, env: { PATH: "" }, io: { ...io, loops: () => [] } });
    const auth = checks.find((c) => c.code === "preflight.pool_auth");
    assert.equal(auth.ok, false); assert.match(auth.detail, /HTTP 401/); assert.match(auth.detail, /token_file/); assert.doesNotMatch(auth.detail, /\btok\b/);
    assert.ok(calls.some((c) => c[0] === "agents" && c[1] === "tok"));
    assert.ok(calls.some((c) => c[0] === "remote" && c[1] === router.endpoint));
  });
});

describe("pool_version", () => {
  it("pool_version detail recommends pool upgrade --wait on a shared host", () => {
    for (const [a, cli] of [["0.37.0", "1.39.0"], ["1.60.1", "1.61.1"]]) {
      const c = checkPoolVersion({ exec: pool, cliVersion: cli, agents: [{ name: "a1", ok: true, version: a }] });
      assert.match(c.detail, /pool upgrade --wait/); assert.match(c.detail, /shared/);
    }
  });
  const ver = (agentVersion, cli = "1.39.0") => checkPoolVersion({ exec: pool, cliVersion: cli, agents: [{ name: "a1", ok: true, version: agentVersion }, { name: "a2", ok: true, version: cli }] });
  it("a different major fails, naming the agent, image version, CLI version and upgrade command", () => {
    const c = ver("0.37.0", "1.39.0");
    assert.equal(c.ok, false); assert.equal(c.code, "preflight.pool_version");
    assert.match(c.detail, /a1/); assert.match(c.detail, /0\.37\.0/); assert.match(c.detail, /1\.39\.0/); assert.ok(c.detail.includes(UPGRADE_COMMAND)); assert.ok(!/a2/.test(c.detail));
  });
  it("#5745: minor and patch skew within the same major passes and notes the skew", () => {
    for (const [agent, cli] of [["1.60.1", "1.61.1"], ["1.61.0", "1.61.1"], ["v1.61.1-rc.1", "1.61.1"]]) {
      const c = ver(agent, cli);
      assert.equal(c.ok, true, `${agent} vs ${cli}`); assert.equal(c.code, "preflight.pool_version"); assert.equal(c.scope, "remote");
      assert.match(c.detail, /compatible, same major/); assert.ok(c.detail.includes(UPGRADE_COMMAND));
    }
  });
  it("#5745: an unparseable differing version fails; an exact match is unchanged", () => {
    assert.equal(ver("latest", "1.61.1").ok, false);
    assert.equal(ver("1.61.1", "dev").ok, false);
    const c = checkPoolVersion({ exec: pool, cliVersion: "1.39.0", agents: [{ name: "a", ok: true, version: "1.39.0" }] });
    assert.equal(c.ok, true); assert.equal(c.detail, "1 agent(s) at 1.39.0");
  });
});

describe("path_loop", () => {
  const wrapper = "#!/bin/sh\nexec \"$(command -v docker)\" \"$@\"\n";
  const mk = () => { const d = tmpDir("lc-"); const w = join(d, "wrap"); mkdirSync(w); writeFileSync(join(w, "docker"), wrapper); chmodSync(join(w, "docker"), 0o755); return { d, w }; };
  it("names the shim dir when a heavy shim execs a pass-through wrapper", () => {
    const { d, w } = mk(); const sh = join(d, "shim"); mkdirSync(sh);
    writeFileSync(join(sh, "docker"), heavyShimScript("docker", join(w, "docker"))); chmodSync(join(sh, "docker"), 0o755);
    const c = checkPathLoop({ env: { PATH: `${sh}:${w}` } });
    assert.equal(c.ok, false); assert.equal(c.code, "preflight.path_loop"); assert.ok(c.detail.includes(sh));
  });
  it("#5592: a batch-level wrapper with no real binary behind it does not trip (no shim is written over it)", () => {
    const { w } = mk();
    assert.equal(checkPathLoop({ env: { PATH: w } }).ok, true);
  });
  it("#5592: a wrapper our own shim already covers (shim points at the real binary) passes", () => {
    const { d, w } = mk(); const real = join(d, "real"), sh = join(d, "shim"); mkdirSync(real); mkdirSync(sh);
    writeFileSync(join(real, "docker"), "#!/bin/sh\necho hi\n"); chmodSync(join(real, "docker"), 0o755);
    writeFileSync(join(sh, "docker"), heavyShimScript("docker", join(real, "docker"))); chmodSync(join(sh, "docker"), 0o755);
    assert.equal(checkPathLoop({ env: { PATH: `${sh}:${w}:${real}` } }).ok, true);
  });
  it("passes when a real binary is behind the wrapper", () => {
    const { d, w } = mk(); const real = join(d, "real"); mkdirSync(real); writeFileSync(join(real, "docker"), "#!/bin/sh\necho hi\n"); chmodSync(join(real, "docker"), 0o755);
    assert.equal(checkPathLoop({ env: { PATH: `${w}:${real}` } }).ok, true);
    assert.deepEqual(findShimLoops(`${w}:${real}`), []);
  });
});

describe("gh_fields", () => {
  const out = (fields) => ({ stdout: "", stderr: `Unknown JSON field: "x"\nAvailable fields:\n${fields.join("\n")}\n` });
  const ghWith = (fields) => async (args) => (args[0] === "--version" ? { stdout: "gh version 2.40.0 (x)\n" } : out(fields[args[0] + " " + args[1]] ?? []));
  const all = { "issue view": ["number", "title", "body", "state", "stateReason", "labels", "comments", "milestone", "author", "createdAt", "updatedAt"], "pr view": ["number", "state", "mergeable", "mergeStateStatus"], "repo view": ["nameWithOwner", "defaultBranchRef"] };
  it("names the missing field and gh version, and passes when complete", async () => {
    assert.equal((await checkGhFields({ exec: ghWith(all) })).ok, true);
    const c = await checkGhFields({ exec: ghWith({ ...all, "issue view": all["issue view"].filter((f) => f !== "stateReason") }) });
    assert.equal(c.ok, false); assert.equal(c.code, "preflight.gh_fields"); assert.match(c.detail, /stateReason/); assert.match(c.detail, /2\.40\.0/);
  });
  it("parses the available list and passes on unparseable output", async () => {
    assert.deepEqual(availableFields("Available fields:\n  a\n  b\n"), ["a", "b"]);
    assert.equal((await checkGhFields({ exec: async () => ({ stdout: "gh version 2.1.0\n", stderr: "boom" }) })).ok, true);
  });
});

describe("#5806 batch env probe", () => {
  const exe = (dir, name) => { mkdirSync(dir, { recursive: true }); const p = join(dir, name); writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o755); return p; };

  it("resolves gh, git and node on the env's own PATH (no shell); a PATH reduced to one bogus entry names every missing tool", () => {
    const d = tmpDir("envprobe-"), bin = join(d, "bin");
    const names = process.platform === "win32" ? ["gh.exe", "git.exe", "node.cmd"] : ["gh", "git", "node"];
    for (const n of names) exe(bin, n);
    const ok = probeBatchEnv({ PATH: bin, PATHEXT: ".EXE;.CMD" });
    assert.deepEqual([ok.ok, ok.missing], [true, []]);
    const bad = probeBatchEnv({ PATH: join(d, "bogus") });
    assert.deepEqual([bad.ok, bad.missing], [false, ["gh", "git", "node"]]);
    assert.match(bad.detail, /^gh, git, node not resolvable on the batch env PATH \(1 entry: /);
    assert.match(probeBatchEnv({}).detail, /\(empty\)$/);
  });

  it("win32: `;`-separated PATH and PATHEXT extensions (.exe/.cmd); an extensionless file does not count", () => {
    const files = new Set(["C:\\tools\\gh.exe", "D:\\git\\cmd\\git.cmd", "D:\\node\\node"]);
    const access = (p) => { if (!files.has(p)) throw new Error("ENOENT"); };
    const path = "C:\\tools;D:\\git\\cmd;D:\\node";
    assert.equal(which("gh", path, [], { platform: "win32", pathext: ".COM;.EXE;.BAT;.CMD", access }), "C:\\tools\\gh.exe");
    assert.equal(which("git", path, [], { platform: "win32", pathext: ".COM;.EXE;.BAT;.CMD", access }), "D:\\git\\cmd\\git.cmd");
    const r = probeBatchEnv({ PATH: path, PATHEXT: ".EXE;.CMD" }, { platform: "win32", access });
    assert.deepEqual(r.missing, ["node"], "D:\\node\\node has no PATHEXT extension");
    assert.match(r.detail, /3 entries: C:\\tools;D:\\git\\cmd;D:\\node/);
    assert.equal(probeBatchEnv({ Path: path }, { platform: "win32", access, tools: ["gh"] }).ok, true, "Windows' `Path` spelling");
  });
});

describe("runLaneChecks / formatLaneChecks", () => {
  it("returns every check and prints PASS or FAIL per line", async () => {
    const checks = await runLaneChecks({ exec: pool, env: { PATH: "" }, cliVersion: "1.39.0", io: { router: () => ({ endpoint: "http://r", token: null }), credential: () => null } });
    assert.deepEqual(checks.map((c) => c.code), ["preflight.pool_auth", "preflight.pool_version", "preflight.path_loop", "preflight.gh_fields"]);
    const lines = formatLaneChecks(checks).split("\n");
    assert.equal(lines.length, 4); assert.match(lines[0], /^FAIL preflight\.pool_auth/); assert.match(lines[2], /^PASS preflight\.path_loop/);
  });
});

describe("orchestrate preflight hold", () => {
  it("admits no remote lane while pool_auth fails, says why once, never trips the breaker, and resumes when it clears", async () => {
    let bad = true; const started = [], rows = [];
    const done = orchestrate({ issues: [1], parallel: 2, pollMs: 5, readBody: async () => "", onUpdate: (r) => rows.push(r), breaker: { errors: 1, window_min: 30 },
      remote: { max: 1, isRemote: () => true, place: () => ({ where: "remote", reason: "t" }), admit: () => ({ ok: true }) },
      preflight: async () => (bad ? [{ code: "preflight.pool_auth", detail: "no token", scope: "remote" }] : []),
      runOne: async (n) => { started.push(n); return { terminalReason: "merged" }; } });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(started, []);
    assert.equal(rows.filter((r) => r.code === "preflight.pool_auth").length, 1);
    assert.ok(!rows.some((r) => r.outcome === "breaker"));
    bad = false;
    await until(() => started.length === 1);
    await done;
    assert.ok(rows.some((r) => /preflight cleared/.test(r.detail ?? "")));
  });
});

describe("sandbox.clone", () => {
  const prov = (over) => ({ name: "pool", idFor: (n) => `sb-${n}`, start: async () => ({}), status: async () => "exited", fetchResult: async () => null, teardown: async () => true, ...over });
  const lanes = (p, extra = {}) => providerLanes({ provider: p, laneArgs: () => [], ledgerFor: () => null, pollMs: 1, sleep: async () => {}, ...extra });
  it("a lane that exited without a result after a clone timeout ends deferred sandbox.clone with retry-in", async () => {
    const r = await lanes(prov(), { logTail: () => "fatal: git clone timed out after 300s" }).runOne(7, {}, {});
    assert.equal(r.terminalReason, "deferred"); assert.equal(r.code, "sandbox.clone"); assert.ok(r.retryInSeconds > 0);
  });
  it("an engine-error result naming a clone failure is retyped; other failures stay engine-error", async () => {
    const r = await lanes(prov({ fetchResult: async () => ({ terminalReason: "engine-error", detail: "git clone failed: early EOF" }) })).runOne(7, {}, {});
    assert.equal(r.code, "sandbox.clone");
    const o = await lanes(prov()).runOne(7, {}, {});
    assert.equal(o.terminalReason, "engine-error");
    assert.equal(isCloneFailure("clone of repo ok"), false);
  });
  it("#5923: an ls-remote/fetch timeout ends deferred sandbox.egress_timeout with retry-in; other failures stay engine-error", async () => {
    for (const t of ["fatal: unable to access 'https://github.com/o/r/': Failed to connect to github.com port 443: Connection timed out", "git ls-remote timed out after 60s", "git fetch hung: timeout"]) {
      const r = await lanes(prov(), { logTail: () => t }).runOne(7, {}, {});
      assert.equal(r.terminalReason, "deferred", t); assert.equal(r.code, "sandbox.egress_timeout", t); assert.ok(r.retryInSeconds > 0);
    }
    const e = await lanes(prov({ fetchResult: async () => ({ terminalReason: "engine-error", detail: "git fetch failed: Connection timed out" }) })).runOne(7, {}, {});
    assert.equal(e.code, "sandbox.egress_timeout");
    const o = await lanes(prov(), { logTail: () => "npm ERR! build failed" }).runOne(7, {}, {});
    assert.equal(o.terminalReason, "engine-error");
    assert.equal(isEgressTimeout("fetch of cache ok"), false);
    assert.equal(isEgressTimeout("git clone timed out after 300s"), false);
  });
  it("is requeued with its retry-in and is not an engine-error (breaker input)", () => {
    const p = deferPolicy({ terminalReason: "deferred", code: "sandbox.clone", retryInSeconds: 120 }, { now: 0 });
    assert.equal(p.delayMs, 120000);
  });
});
