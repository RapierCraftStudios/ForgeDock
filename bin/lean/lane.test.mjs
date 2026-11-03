// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { milestoneSlug, readBranches, resolveLane, makeLaneCache } from "./lane.mjs";

/** Fake gh/git: the issue's milestone, GitHub's default branch, and the branches on origin. */
function io({ milestone = null, ghDefault = "main", onOrigin = ["staging", "main"], ghFails = null, gitFails = false } = {}) {
  const calls = [];
  return {
    calls,
    gh: async (a) => {
      calls.push(["gh", ...a]);
      if (ghFails && a[0] === ghFails) throw new Error("HTTP 502");
      if (a[0] === "issue" && a[1] === "view") return JSON.stringify({ milestone: milestone ? { title: milestone } : null });
      if (a[0] === "repo" && a[1] === "view") return `${ghDefault}\n`;
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (a) => {
      calls.push(["git", ...a]);
      if (gitFails) throw new Error("network down");
      const b = a.at(-1).replace(/^refs\/heads\//, "");
      return onOrigin.includes(b) ? `abc\trefs/heads/${b}\n` : "";
    },
  };
}
const resolve = (o, extra = {}) => resolveLane({ issue: 5, repo: "o/r", io: io(o), cwd: "/repo", ...extra });

describe("lane resolution (#4125)", () => {
  it("slug matches scripts/classify-lane.sh", () => {
    assert.equal(milestoneSlug("Adaptive Unblocking: Control Loop"), "adaptive-unblocking-control-loop");
    assert.equal(milestoneSlug("User Auth v2"), "user-auth-v2");
    assert.equal(milestoneSlug(" -- Foo  (Bar) -- "), "foo-bar");
    assert.equal(milestoneSlug("🚀✨"), "");
  });

  it("a milestone issue resolves to feature_pattern with the slug; no milestone resolves to staging", async () => {
    const m = await resolve({ milestone: "Adaptive Unblocking Control Loop", onOrigin: ["staging", "milestone/adaptive-unblocking-control-loop"] });
    assert.deepEqual([m.ok, m.lane, m.overridden], [true, "milestone/adaptive-unblocking-control-loop", false]);
    const s = await resolve({});
    assert.deepEqual([s.ok, s.lane], [true, "staging"]);
  });

  it("forge.yaml branches.staging and feature_pattern are honoured", async () => {
    const branches = { staging: "develop", featurePattern: "feature/{slug}" };
    assert.equal((await resolve({ onOrigin: ["develop"] }, { branches })).lane, "develop");
    assert.equal((await resolve({ milestone: "X Y", onOrigin: ["feature/x-y"] }, { branches })).lane, "feature/x-y");
    const bad = await resolve({}, { branches: { featurePattern: "milestone/fixed" } });
    assert.equal(bad.code, "lane.unresolved");
  });

  it("--lane is an assertion: a mismatch is refused, --lane-override accepts it", async () => {
    const o = { milestone: "M1", onOrigin: ["staging", "milestone/m1"] };
    const r = await resolve(o, { requested: "staging" });
    assert.equal(r.ok, false); assert.equal(r.code, "lane.mismatch");
    assert.match(r.detail, /--lane staging does not match #5's lane milestone\/m1/);
    assert.equal((await resolve(o, { requested: "milestone/m1" })).ok, true);
    const ov = await resolve(o, { requested: "staging", override: true });
    assert.deepEqual([ov.ok, ov.lane, ov.expected, ov.overridden], [true, "staging", "milestone/m1", true]);
  });

  it("the default branch is never a lane, even with an override or when staging is configured as it", async () => {
    for (const requested of ["main", "trunk"]) {
      const r = await resolve({ ghDefault: "trunk" }, { requested, override: true, branches: { default: "main" } });
      assert.equal(r.code, "lane.default_branch", requested);
    }
    assert.equal((await resolve({}, { branches: { staging: "main" } })).code, "lane.default_branch");
  });

  it("a missing lane branch fails closed with lane.branch_missing", async () => {
    const r = await resolve({ milestone: "Not Created", onOrigin: ["staging"] });
    assert.equal(r.code, "lane.branch_missing");
    assert.match(r.detail, /milestone\/not-created/);
  });

  it("unreadable milestone, default branch or origin, and an empty slug, fail closed with lane.unresolved", async () => {
    assert.equal((await resolve({ ghFails: "issue" })).code, "lane.unresolved");
    assert.equal((await resolve({ ghFails: "repo" })).code, "lane.unresolved");
    assert.equal((await resolve({ gitFails: true })).code, "lane.unresolved");
    assert.equal((await resolve({ milestone: "🚀" })).code, "lane.unresolved");
  });

  it("readBranches reads forge.yaml branches; missing keys are null", () => {
    const d = tmpDir("lane-");
    writeFileSync(`${d}/forge.yaml`, 'branches:\n  default: "main"\n  staging: "develop"\n  feature_pattern: "milestone/{slug}"\n');
    assert.deepEqual(readBranches(d), { default: "main", staging: "develop", featurePattern: "milestone/{slug}" });
    assert.deepEqual(readBranches(tmpDir("lane-")), { default: null, staging: null, featurePattern: null });
  });

  it("#4791 a failed gh/git command is transient; a genuine refusal is not", async () => {
    for (const o of [{ ghFails: "issue" }, { ghFails: "repo" }, { gitFails: true }]) {
      const r = await resolve(o);
      assert.deepEqual([r.ok, r.code, r.transient], [false, "lane.unresolved", true]);
    }
    const missing = await resolve({ onOrigin: ["main"] });
    assert.equal(missing.ok, false);
    assert.ok(!missing.transient);
    const slug = await resolve({ milestone: "🚀" });
    assert.deepEqual([slug.code, !!slug.transient], ["lane.unresolved", false]);
  });
});

describe("per-batch lane lookups (#4963)", () => {
  it("one default-branch read and one ls-remote per lane across issues; a supplied milestone skips the issue view", async () => {
    const fake = io({ onOrigin: ["staging", "main", "milestone/m1"] }), cache = makeLaneCache();
    const rs = await Promise.all([1, 2, 3, 4].map((issue) => resolveLane({ issue, repo: "o/r", io: fake, cwd: "/r", cache, milestone: issue % 2 ? "M1" : null })));
    assert.deepEqual(rs.map((r) => r.lane), ["milestone/m1", "staging", "milestone/m1", "staging"]);
    const n = (k, ...m) => fake.calls.filter((c) => c[0] === k && m.every((x, i) => c[i + 1] === x)).length;
    assert.equal(n("gh", "repo", "view"), 1);
    assert.equal(n("gh", "issue", "view"), 0);
    assert.equal(fake.calls.filter((c) => c[1] === "ls-remote").length, 2);
  });
  it("without cache or milestone every call reads (unchanged)", async () => {
    const fake = io();
    await resolveLane({ issue: 1, repo: "o/r", io: fake, cwd: "/r" });
    await resolveLane({ issue: 2, repo: "o/r", io: fake, cwd: "/r" });
    assert.equal(fake.calls.filter((c) => c[1] === "issue").length, 2);
    assert.equal(fake.calls.filter((c) => c[1] === "repo").length, 2);
  });
  it("a failed lookup is not cached: the retry re-reads", async () => {
    const cache = makeLaneCache();
    const bad = await resolveLane({ issue: 1, repo: "o/r", io: io({ ghFails: "repo" }), cwd: "/r", cache, milestone: null });
    assert.equal(bad.transient, true);
    const ok = await resolveLane({ issue: 1, repo: "o/r", io: io(), cwd: "/r", cache, milestone: null });
    assert.equal(ok.ok, true);
  });
  it("a missing lane branch is not cached either", async () => {
    const cache = makeLaneCache();
    const miss = await resolveLane({ issue: 1, repo: "o/r", io: io({ onOrigin: ["main"] }), cwd: "/r", cache, milestone: null });
    assert.equal(miss.ok, false);
    assert.equal((await resolveLane({ issue: 1, repo: "o/r", io: io(), cwd: "/r", cache, milestone: null })).ok, true);
  });
});
