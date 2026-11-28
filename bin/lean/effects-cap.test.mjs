// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execCapped, elideArgs, runCheckCommand } from "./effects.mjs";
import { HEAVY_DEFER_CODE, HEAVY_DEFER_MARKER } from "./heavy.mjs";

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
  it("a failure message elides long arguments so stderr (the reason) stays near the start (2026-11-26 #6034)", async () => {
    const body = "<!-- FORGE:CONTRACT -->" + "x".repeat(5000);
    await assert.rejects(execCapped(process.execPath, ["-e", "console.error('HTTP 502: unexpected EOF');process.exit(1)", body]), (e) => {
      const head = e.message.slice(0, 300);
      return /<\d+ chars>/.test(head) && /HTTP 502: unexpected EOF/.test(head) && !head.includes("xxxx") && e.stderr.includes("HTTP 502");
    });
    assert.equal(elideArgs(["issue", "comment", "7"]), "issue comment 7");
  });
});

describe("#6242 heavy-gate denial maps to the infra rc", () => {
  const run = (command) => runCheckCommand({ command, cwd: process.cwd(), timeoutMs: 20000 });
  it("marker + exit 75 -> rc 124 with the infra note", async () => {
    const r = await run(`echo '${HEAVY_DEFER_MARKER} test deferred, agent unreachable (exit 75)' >&2; exit ${HEAVY_DEFER_CODE}`);
    assert.equal(r.rc, 124);
    assert.match(r.output, /heavy gate unavailable: infra/);
  });
  it("bare exit 75 stays 75", async () => { assert.equal((await run("exit 75")).rc, 75); });
  it("ordinary failure keeps its code", async () => { assert.equal((await run("echo boom; exit 1")).rc, 1); });
});
