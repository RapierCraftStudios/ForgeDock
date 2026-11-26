// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6091: a lane held on env.engine_skew is re-admitted by the engine of the agent that will run it, not the orchestrator's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const SKEW = { terminalReason: "needs-human", code: "recurrence.design_missing", detail: "gate fired", engineVersion: "1.66.0" };
const MERGED = { terminalReason: "merged", pr: 9 };
const run = ({ agentVersion, script }) => {
  let t = 1_000_000, k = 0;
  const calls = [];
  return orchestrate({ issues: [1], parallel: 1, readBody: async () => "", now: () => t, pollMs: 1000, version: "1.67.0",
    sleep: async (ms) => { t += Math.max(1, Number(ms) || 0); },
    envHold: { version: () => "1.67.0", maxMs: 120_000, watchMs: 30_000, agentVersion: () => agentVersion(calls.length) },
    runOne: async (n) => { calls.push(n); t += 1000; return script[Math.min(k++, script.length - 1)]; },
    remote: { max: 2, isRemote: () => true, admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 } })
    .then((rows) => ({ rows, calls }));
};

describe("#6091 engine-held re-admission follows the agent's engine", () => {
  it("stays held while the only agent is still on the old engine", async () => {
    const { rows, calls } = await run({ agentVersion: () => "1.66.0", script: [SKEW, MERGED] });
    assert.equal(calls.length, 1, "not relaunched onto the old agent");
    assert.equal(rows[0].outcome, "held");
    assert.equal(rows[0].code, "env.engine_skew");
    assert.equal(rows[0].engineVersion, "1.66.0", "the engine that ran stays on the row");
  });

  it("is re-admitted once the agent upgrades to the needed engine", async () => {
    const { rows, calls } = await run({ agentVersion: (n) => (n >= 1 ? "1.67.1" : "1.66.0"), script: [SKEW, MERGED] });
    assert.deepEqual(calls, [1, 1]);
    assert.equal(rows[0].outcome, "merged");
  });
});
