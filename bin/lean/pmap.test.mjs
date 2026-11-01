// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "./pmap.mjs";

describe("mapLimit", () => {
  it("bounds concurrency and keeps input order", async () => {
    let live = 0, peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6], 3, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, n * 3));
      live--; return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30, 60]);
    assert.equal(peak, 3);
  });
  it("handles empty input and a bad limit as serial", async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
    let live = 0, peak = 0;
    await mapLimit([1, 2, 3], 0, async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; });
    assert.equal(peak, 1);
  });
  it("rejects with the first error", async () => {
    await assert.rejects(mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("boom"); return n; }), /boom/);
  });
});
