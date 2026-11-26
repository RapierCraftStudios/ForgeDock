// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execCapped, makeLeanRunner } from "./effects.mjs";

describe("#5592 a huge git/gh output never crashes the lane", () => {
  it("output past the cap is truncated with a marker, not a maxBuffer error", async () => {
    const out = await execCapped(process.execPath, ["-e", "process.stdout.write('x'.repeat(3e6))"], { cap: 1_000_000 });
    assert.ok(out.startsWith("xxxx") && out.length < 1_000_200);
    assert.match(out, /output truncated at 1000000 bytes/);
  });
  it("normal output passes through; a failing child rejects with stderr", async () => {
    assert.equal(await execCapped(process.execPath, ["-e", "process.stdout.write('hi')"]), "hi");
    await assert.rejects(execCapped(process.execPath, ["-e", "console.error('boom');process.exit(3)"]), (e) => e.code === 3 && /boom/.test(e.stderr) && /boom/.test(e.message));
  });
});

describe("#5821 api route", () => {
  const cliRes = { text: "cli", sessionId: "s", usage: null, costUsd: 1, durationMs: 1, turns: 3, cliModel: "m", baselineTokens: 37000, toolUses: [] };
  const mk = (extra = {}) => { const calls = { cli: 0, api: 0 }; const runner = makeLeanRunner({ runCli: async () => { calls.cli++; return cliRes; }, probe: () => false, sandboxed: false, env: { ANTHROPIC_API_KEY: "k" },
    apiRunner: async (a) => { calls.api++; calls.args = a; return { text: "api", route: "api", turns: 1, baselineTokens: 120 }; }, ...extra }); return { runner, calls }; };
  const call = (runner, o = {}) => runner({ role: "reviewer", issue: 1, cwd: ".", model: null, resume: null, system: "s", prompt: "p<diff>\n</diff>", apiEligible: true, ...o });
  it("api route: configured reviewer role bypasses the CLI", async () => {
    const { runner, calls } = mk({ apiRoles: ["reviewer"] });
    const r = await call(runner);
    assert.equal(r.route, "api"); assert.equal(calls.cli, 0); assert.equal(calls.api, 1);
    // root cause: the old path spawned a CLI session (turns 3, 37k baseline); the API result must come back untouched, with the cacheable prefix split off the variable tail
    assert.equal(r.text, "api"); assert.equal(r.turns, 1); assert.equal(r.baselineTokens, 120);
    assert.equal(calls.args.system, "s"); assert.equal(calls.args.prefix, "p<diff>\n</diff>"); assert.equal(calls.args.tail, "");
    assert.equal(calls.args.env.ANTHROPIC_API_KEY, "k");
    const t = mk({ apiRoles: ["reviewer"] }); await call(t.runner, { prompt: "A<diff>\nD\n</diff>\nTAIL" });
    assert.equal(t.calls.args.prefix, "A<diff>\nD\n</diff>"); assert.equal(t.calls.args.tail, "\nTAIL");
  });
  it("api route: default config, other roles and ineligible calls stay on the CLI", async () => {
    const a = mk(); assert.equal((await call(a.runner)).route, "cli"); assert.equal(a.calls.api, 0);
    const b = mk({ apiRoles: ["reviewer"] });
    assert.equal((await call(b.runner, { role: "builder" })).route, "cli");
    assert.equal((await call(b.runner, { apiEligible: false })).route, "cli");
    assert.equal((await call(b.runner, { resume: "x" })).route, "cli");
    assert.equal(b.calls.api, 0);
  });
  it("api route: fallback cli vs fail", async () => {
    const boom = async () => { throw new Error("api down"); };
    const cli = mk({ apiRoles: ["reviewer"], apiRunner: boom });
    assert.equal((await call(cli.runner)).route, "cli");
    const nokey = mk({ apiRoles: ["reviewer"], env: {} });
    assert.equal((await call(nokey.runner)).route, "cli");
    const fail = mk({ apiRoles: ["reviewer"], apiFallback: "fail", apiRunner: boom });
    await assert.rejects(call(fail.runner), /api down/);
    await assert.rejects(call(mk({ apiRoles: ["reviewer"], apiFallback: "fail", env: {} }).runner), /ANTHROPIC_API_KEY/);
    assert.equal((await call(mk({ apiRoles: ["reviewer"], apiFallback: "fail" }).runner, { apiRoles: [], })).route, "cli");
  });
  it("api route: apiOnly never falls back to a CLI session", async () => {
    const { runner, calls } = mk({ apiRoles: ["contract_correction"] });
    assert.equal((await call(runner, { role: "contract_correction", apiOnly: true })).route, "api");
    const none = mk({ apiRoles: [] });
    await assert.rejects(call(none.runner, { role: "contract_correction", apiOnly: true }), /API-only/);
    assert.equal(none.calls.cli, 0); assert.equal(calls.cli, 0);
  });
});
