// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execCapped, elideArgs } from "./effects.mjs";

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
