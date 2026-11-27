// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5990: the schedd's batched GitHub read client.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeGhReader, isNetworkError } from "./gh-reader.mjs";

/** Fake gh: answers the batched graphql query for every `i<N>:issue(` alias; `down` makes it fail like an offline host. */
const fakeGh = () => {
  const st = { calls: [], down: false, labels: ["bug"], milestone: "M1" };
  st.gh = async (args) => {
    st.calls.push(args);
    if (st.down) throw new Error("Post https://api.github.com/graphql: dial tcp: lookup api.github.com: no such host");
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`unexpected per-issue gh ${args.join(" ")}`);
    const q = args.find((a) => a.startsWith("query="));
    const repository = {};
    for (const m of q.matchAll(/i(\d+):issue/g)) repository[`i${m[1]}`] = { number: Number(m[1]), state: "OPEN", stateReason: null, updatedAt: "2026-01-01T00:00:00Z", milestone: { title: st.milestone }, labels: { nodes: st.labels.map((name) => ({ name })) }, comments: { totalCount: 3 } };
    return JSON.stringify({ data: { repository } });
  };
  return st;
};
const issues = Array.from({ length: 200 }, (_, i) => i + 1);

describe("gh reader (#5990)", () => {
  it("200 issues cost at most 2 graphql calls and 0 per-issue spawns when nothing changed", async () => {
    const f = fakeGh(); let t = 0;
    const r = makeGhReader({ gh: f.gh, repo: "o/r", now: () => t });
    await r.refresh(issues);
    for (const n of issues) { assert.deepEqual(await r.labels(n), ["bug"]); assert.equal(await r.milestone(n), "M1"); }
    assert.ok(f.calls.length <= 2, `graphql calls: ${f.calls.length}`);
    assert.ok(f.calls.every((c) => c[1] === "graphql"));
    assert.equal(r.stats().spawns, f.calls.length);
  });

  it("15 minutes of network failure serve the cache; a never-read issue throws a network error", async () => {
    const f = fakeGh(); let t = 0;
    const r = makeGhReader({ gh: f.gh, repo: "o/r", now: () => t });
    await r.refresh(issues);
    f.down = true;
    for (let min = 1; min <= 15; min++) {
      t += 60_000;
      assert.equal(await r.milestone(7), "M1");
      assert.deepEqual(await r.labels(200), ["bug"]);
    }
    await assert.rejects(r.milestone(999), (e) => isNetworkError(e));
    f.down = false; f.milestone = "M2"; t += 60_000;
    assert.equal(await r.milestone(7), "M2", "recovers once GitHub answers");
  });

  it("isNetworkError matches transport failures and not content failures (negative examples)", () => {
    for (const m of ["dial tcp: lookup api.github.com: no such host", "Could not resolve host: github.com", "connect ETIMEDOUT 1.2.3.4:443", "read ECONNRESET", "error connecting to api.github.com"]) assert.ok(isNetworkError(new Error(m)), m);
    assert.ok(isNetworkError({ code: "ENOTFOUND" }));
    for (const m of ["GraphQL: Could not resolve to an Issue with the number of 5", "HTTP 404: Not Found", "HTTP 401: Bad credentials", "invalid json", "milestone has no slug"]) assert.equal(isNetworkError(new Error(m)), false, m);
    assert.equal(isNetworkError(null), false);
  });

  it("logs the pass's spawn count against the budget and serves the cache once the budget is spent", async () => {
    const f = fakeGh(); const logs = []; let t = 0;
    const r = makeGhReader({ gh: f.gh, repo: "o/r", now: () => t, passBudget: 1, log: (m) => logs.push(m) });
    r.beginPass();
    await r.refresh([1]);
    t += 60_000;
    assert.equal(await r.milestone(1), "M1");
    assert.equal(f.calls.length, 1, "no spawn beyond the budget");
    assert.ok(logs.some((l) => /spawn budget 1 reached/.test(l)));
    r.endPass("test");
    assert.ok(logs.some((l) => /gh-reader: test spawns=1 budget=1/.test(l)));
  });
});
