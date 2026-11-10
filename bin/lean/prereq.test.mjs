// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Prerequisite pull-in (#5340).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openPrerequisites } from "./prereq.mjs";

const states = { 2: "OPEN", 3: "CLOSED", 4: "OPEN", 5: "OPEN", 6: "boom" };
const issueState = async (n) => { if (n === 6) throw new Error("gh down"); return states[n]; };
const issueLabels = async (n) => (n === 4 ? ["needs-human"] : []);

describe("openPrerequisites (#5340)", () => {
  it("pulls open out-of-batch prerequisites; skips closed, in-batch, finished, parked and unreadable ones", async () => {
    const r = await openPrerequisites({ deps: [2, 3, 4, 5, 6, 7, 2], inBatch: (d) => d === 5, results: new Map([[7, {}]]), issueState, issueLabels });
    assert.deepEqual(r, { pull: [2], parked: [4] });
  });
  it("without a state probe nothing is known to be open", async () => {
    assert.deepEqual(await openPrerequisites({ deps: [2], inBatch: () => false }), { pull: [], parked: [] });
  });
});
