// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sweepParked, formatParkedSweepSummary } from "./parked-sweep.mjs";

const MERGE = "a".repeat(40);
const item = (extra = "") => `- [ ] \`R2: the window shows a row\` — post-deploy: [check:smoke] ${extra} after promotion`;
const bodyOf = (extra) => `## AC\n\n${item(extra)}\n\n<!-- FORGE:DEFERRED_FROM: #40 -->\n`;
const CHECKS = JSON.stringify({ smoke: "echo ok" });

/** Fake repo: `parked` maps issue -> {labels, body}; `promoted` says whether the parent's merge SHA is on origin/main. */
function world({ parked, promoted, now = Date.parse("2026-11-04T00:00:00Z") }) {
  const w = { edits: [], closed: [], comments: [], commits: [] };
  w.io = {
    now: () => now,
    gh: async (a) => {
      const k = a.slice(0, 2).join(" ");
      if (k === "issue list") { const l = a[a.indexOf("--label") + 1]; return JSON.stringify(Object.entries(parked).filter(([, v]) => v.labels.includes(l)).map(([n]) => ({ number: Number(n) }))); }
      if (k === "issue view") { const n = Number(a[2]); return JSON.stringify({ number: n, state: "OPEN", title: "", comments: [], ...parked[n], labels: parked[n].labels.map((name) => ({ name })) }); }
      if (k === "pr list") return JSON.stringify([{ number: 90, title: "fix (#40)", body: "", mergeCommit: { oid: MERGE } }]);
      if (k === "issue edit") { w.edits.push(a); return ""; }
      if (k === "issue comment") { w.comments.push(a); return ""; }
      if (k === "issue close") { w.closed.push(Number(a[2])); return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (a) => {
      if (a[0] === "fetch") return "";
      if (a[0] === "rev-parse") return "deadbeef\n";
      if (a[0] === "show") return CHECKS;
      if (a[0] === "merge-base") { if (promoted) return ""; throw Object.assign(new Error("exit 1"), { code: 1 }); }
      throw new Error(`unexpected git ${a.join(" ")}`);
    },
    spawnCheck: async () => ({ code: 0, stdout: "ok", stderr: "" }),
  };
  return w;
}
const sweep = (w, extra = {}) => sweepParked({ repo: "o/r", cwd: "/repo", io: w.io, defaultBranch: "main", ...extra });

describe("parked follow-up sweep (#4689)", () => {
  it("one pass after the parent's commit reaches the default branch removes awaiting-promotion and measures; before it nothing changes", async () => {
    const parked = { 41: { labels: ["awaiting-promotion"], body: bodyOf() } };
    const before = world({ parked, promoted: false });
    const rows0 = await sweep(before);
    assert.deepEqual(rows0.map((r) => [r.issue, r.outcome, r.kind]), [[41, "still-parked", "awaiting-promotion"]]);
    assert.deepEqual(before.closed, []);
    const after = world({ parked, promoted: true });
    const rows = await sweep(after, { dryRun: false });
    assert.ok(after.edits.some((a) => a.includes("--remove-label") && a.includes("awaiting-promotion")), "label removed");
    assert.equal(rows[0].issue, 41); assert.notEqual(rows[0].outcome, "still-parked");
    assert.equal(formatParkedSweepSummary([{ issue: 41, outcome: "released" }, { issue: 5, outcome: "error" }]), "parked: released #41; error #5");
  });

  it("a due date in the past is released, a future one stays parked", async () => {
    const parked = { 50: { labels: ["awaiting-due", "due:2026-11-03"], body: bodyOf("due:2026-11-03") }, 51: { labels: ["awaiting-due"], body: bodyOf("due:2026-12-01") } };
    const w = world({ parked, promoted: true });
    const rows = await sweep(w);
    assert.equal(rows.find((r) => r.issue === 51).outcome, "still-parked");
    assert.notEqual(rows.find((r) => r.issue === 50).outcome, "still-parked");
    assert.ok(w.edits.some((a) => a[2] === "50" && a.includes("--remove-label") && /awaiting-due,due:2026-11-03/.test(a.join(" "))));
  });

  it("an unreadable issue is an error row, never a throw; a dry run changes nothing", async () => {
    const w = world({ parked: { 60: { labels: ["awaiting-promotion"], body: bodyOf() } }, promoted: true });
    const g = w.io.gh; w.io.gh = async (a) => { if (a[1] === "view") throw new Error("boom"); return g(a); };
    assert.equal((await sweep(w))[0].outcome, "error");
    const w2 = world({ parked: { 61: { labels: ["awaiting-promotion"], body: bodyOf() } }, promoted: true });
    await sweep(w2, { dryRun: true });
    assert.deepEqual(w2.edits, []); assert.deepEqual(w2.closed, []);
  });
});
