// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickSalvage } from "./salvage-resume.mjs";

/** refs: [{ sha, name, ct }]; ahead: shas strictly ahead of origin/<branch>; behind: shas that are ancestors of it. */
const world = ({ refs = [], ahead = [], behind = [] } = {}) => {
  const calls = [];
  const git = async (a) => {
    calls.push(a);
    if (a[0] === "ls-remote") return refs.map((r) => `${r.sha}\trefs/heads/forge-salvage/7-${r.name}`).join("\n");
    if (a[0] === "log") return String(refs.find((r) => r.sha === a[3])?.ct ?? "");
    if (a[0] === "merge-base") {
      if (a[2].startsWith("origin/") ? ahead.includes(a[3]) : behind.includes(a[2])) return "";
      throw new Error("not an ancestor");
    }
    return "";
  };
  return { io: { git }, calls };
};
const pick = (w, hasBranch) => pickSalvage({ io: w.io, cwd: ".", issue: 7, branch: "b", hasBranch });

describe("pickSalvage (#5063)", () => {
  it("no salvage refs: null", async () => assert.equal(await pick(world(), false), null));
  it("newest by commit time, not by sha suffix", async () => {
    const w = world({ refs: [{ sha: "f", name: "ffff", ct: 10 }, { sha: "a", name: "aaaa", ct: 20 }] });
    assert.equal((await pick(w, false)).ref, "refs/heads/forge-salvage/7-aaaa");
  });
  it("branch exists: a salvage ref strictly ahead of it is picked", async () => {
    const w = world({ refs: [{ sha: "a", name: "aaaa", ct: 20 }], ahead: ["a"] });
    assert.equal((await pick(w, true)).ref, "refs/heads/forge-salvage/7-aaaa");
  });
  it("branch exists: behind or diverged refs are ignored, an older usable one is kept", async () => {
    const w = world({ refs: [{ sha: "n", name: "new", ct: 30 }, { sha: "b", name: "behind", ct: 20 }, { sha: "o", name: "old", ct: 10 }], ahead: ["o"], behind: ["b"] });
    assert.equal((await pick(w, true)).ref, "refs/heads/forge-salvage/7-old");
    assert.equal(await pick(world({ refs: [{ sha: "d", name: "div", ct: 5 }] }), true), null);
  });
});
