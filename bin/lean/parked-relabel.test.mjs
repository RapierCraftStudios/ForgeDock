// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parkedRelabel } from "./parked-relabel.mjs";

// A fake issue whose label set a stub `gh` edits; `missing` labels cannot be created or added.
const fake = ({ missing = [], failVerify = false } = {}) => {
  const labels = new Set(["needs-human"]), calls = [];
  const gh = async (a) => {
    calls.push(a.slice(0, 2).join(" "));
    const list = (f) => String(a[a.indexOf(f) + 1] ?? "").split(",").filter(Boolean);
    if (a[0] === "label") { if (missing.includes(a[2])) throw new Error("create failed"); return ""; }
    if (a[1] === "view") { if (failVerify) throw new Error("view failed"); return JSON.stringify({ labels: [...labels].map((name) => ({ name })) }); }
    if (a.includes("--add-label")) { const ls = list("--add-label"); if (ls.some((l) => missing.includes(l))) throw new Error("add failed"); ls.forEach((l) => labels.add(l)); }
    if (a.includes("--remove-label")) list("--remove-label").forEach((l) => labels.delete(l));
    return "";
  };
  return { labels, calls, run: () => parkedRelabel({ gh, repo: "o/r", issue: 7, code: "ci.red" }) };
};

describe("#5466 parkedRelabel", () => {
  it("adds both labels, verifies, then removes needs-human", async () => {
    const f = fake();
    assert.deepEqual(await f.run(), { ok: true, queued: true });
    assert.deepEqual([...f.labels].sort(), ["parked:ci.red", "remediation-queue"]);
  });
  it("missing remediation-queue label never leaves the issue stateless", async () => {
    const f = fake({ missing: ["remediation-queue"] });
    const r = await f.run();
    assert.equal(r.ok, true);
    assert.equal(r.queued, false);
    assert.deepEqual([...f.labels], ["parked:ci.red"]);
  });
  it("a failed parked add keeps needs-human", async () => {
    const f = fake({ missing: ["parked:ci.red", "remediation-queue"] });
    assert.equal((await f.run()).ok, false);
    assert.deepEqual([...f.labels], ["needs-human"]);
  });
  it("a failed verify rolls back and keeps needs-human", async () => {
    const f = fake({ failVerify: true });
    assert.equal((await f.run()).ok, false);
    assert.deepEqual([...f.labels], ["needs-human"]);
  });
});
