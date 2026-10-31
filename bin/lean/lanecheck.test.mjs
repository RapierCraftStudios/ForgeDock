// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4866: lane preflight checks, the orchestrate admission hold, sandbox.clone typing and the heavy shim-loop finder.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPoolAuth, checkPoolVersion, checkPathLoop, checkGhFields, availableFields, runLaneChecks, formatLaneChecks, UPGRADE_COMMAND } from "./lanecheck.mjs";
import { findShimLoops } from "./heavy.mjs";
import { orchestrate, deferPolicy } from "./orchestrate.mjs";
import { providerLanes, isCloneFailure } from "./execution.mjs";

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

describe("pool_version", () => {
  it("reports the agent, image version, CLI version and upgrade command", () => {
    const c = checkPoolVersion({ exec: pool, cliVersion: "1.39.0", agents: [{ name: "a1", ok: true, version: "1.37.0" }, { name: "a2", ok: true, version: "1.39.0" }] });
    assert.equal(c.ok, false); assert.equal(c.code, "preflight.pool_version");
    assert.match(c.detail, /a1/); assert.match(c.detail, /1\.37\.0/); assert.match(c.detail, /1\.39\.0/); assert.ok(c.detail.includes(UPGRADE_COMMAND)); assert.ok(!/a2/.test(c.detail));
    assert.equal(checkPoolVersion({ exec: pool, cliVersion: "1.39.0", agents: [{ name: "a", ok: true, version: "1.39.0" }] }).ok, true);
  });
});

describe("path_loop", () => {
  const wrapper = "#!/bin/sh\nexec \"$(command -v docker)\" \"$@\"\n";
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "lc-")); const w = join(d, "wrap"); mkdirSync(w); writeFileSync(join(w, "docker"), wrapper); chmodSync(join(w, "docker"), 0o755); return { d, w }; };
  it("names the wrapper dir when no real binary sits behind it", () => {
    const { w } = mk();
    const c = checkPathLoop({ env: { PATH: w } });
    assert.equal(c.ok, false); assert.equal(c.code, "preflight.path_loop"); assert.ok(c.detail.includes(w));
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
  it("is requeued with its retry-in and is not an engine-error (breaker input)", () => {
    const p = deferPolicy({ terminalReason: "deferred", code: "sandbox.clone", retryInSeconds: 120 }, { now: 0 });
    assert.equal(p.delayMs, 120000);
  });
});
