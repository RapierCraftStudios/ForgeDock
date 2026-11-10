// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normaliseInvalidation, epicOf, findAmendment, affectedChildren, amendmentBody, holdEdge, releaseEdge, parseDispositions, validateDispositions, renderEpicChecklist, fileAmendment, applyReplan, DISPOSITIONS_TAG } from "./replan.mjs";

const kid = (n, body = "**Parent**: #5\n") => ({ number: n, body, labels: [], author: { login: "o" }, authorAssociation: "OWNER" });
const inv = normaliseInvalidation({ decision: "replay_store is optional", why: "core loop needs it", epic: 5 }, 7);

// A fake gh over an in-memory repo: issue list/view/create/edit/close and the REST association list.
const repoWorld = (issues) => {
  const w = { issues: new Map(issues.map((i) => [i.number, { ...i }])), calls: [], next: 100 };
  w.gh = async (a) => {
    w.calls.push(a);
    if (a[0] === "issue" && a[1] === "list" && a.includes("--help")) return "JSON FIELDS\n  author, body, labels, number\n";
    if (a[0] === "issue" && a[1] === "list") return JSON.stringify([...w.issues.values()].filter((i) => i.state !== "closed").map(({ number, body, labels, author }) => ({ number, body, labels: labels ?? [], author: author ?? { login: "o" } })));
    if (a[0] === "api") return [...w.issues.values()].map((i) => `${i.number}\tOWNER`).join("\n");
    if (a[1] === "view") { const i = w.issues.get(Number(a[2])); return JSON.stringify({ body: i.body, comments: i.comments ?? [] }); }
    if (a[1] === "create") { const n = ++w.next; w.issues.set(n, { number: n, body: a[a.indexOf("--body") + 1], title: a[a.indexOf("--title") + 1] }); return `https://github.com/o/r/issues/${n}\n`; }
    if (a[1] === "edit") { w.issues.get(Number(a[2])).body = a[a.indexOf("--body") + 1]; return ""; }
    if (a[1] === "close") { w.issues.get(Number(a[2])).state = "closed"; return ""; }
    throw new Error(`unexpected gh ${a.join(" ")}`);
  };
  return w;
};

describe("re-plan loop (#5342)", () => {
  it("normaliseInvalidation needs a decision and a why; epic never equals the lane issue", () => {
    assert.equal(normaliseInvalidation({ decision: "x" }, 7), null);
    assert.equal(normaliseInvalidation({ why: "y" }, 7), null);
    assert.equal(normaliseInvalidation({ decision: "x", why: "y", epic: 7 }, 7).epic, null);
    assert.equal(epicOf(normaliseInvalidation({ decision: "x", why: "y" }, 7), "**Parent**: #12\n"), 12);
  });

  it("hold edge is added once and released cleanly", () => {
    const held = holdEdge("body\n", 100);
    assert.equal(holdEdge(held, 100), held);
    assert.match(held, /^\*\*Depends on\*\*: #100$/m);
    assert.doesNotMatch(releaseEdge(held, 100), /Depends on/);
  });

  it("affectedChildren: open children of the epic, narrowed by declared paths, never the lane itself", () => {
    const list = [kid(7), kid(8, "**Parent**: #5\nedits src/a.ts"), kid(9, "**Parent**: #5\nedits src/b.ts"), kid(10, "**Parent**: #6\n")];
    assert.deepEqual(affectedChildren({ list, epic: 5, self: 7 }), [8, 9]);
    assert.deepEqual(affectedChildren({ list, epic: 5, self: 7, paths: ["src/a.ts"] }), [8]);
  });

  it("fileAmendment files one amendment, holds siblings and the lane; a second invalidation joins it", async () => {
    const w = repoWorld([{ number: 7, body: "**Parent**: #5\n" }, { number: 8, body: "**Parent**: #5\n" }, { number: 9, body: "**Parent**: #5\n" }]);
    const f = await fileAmendment({ gh: w.gh, create: w.gh, repo: "o/r", issue: 7, inv, epic: 5 });
    assert.deepEqual([f.created, f.held.sort()], [true, [7, 8, 9]]);
    for (const n of [7, 8, 9]) assert.match(w.issues.get(n).body, new RegExp(`^\\*\\*Depends on\\*\\*: #${f.amendment}$`, "m"));
    assert.equal(findAmendment([...w.issues.values()], 5), f.amendment);
    const again = await fileAmendment({ gh: w.gh, create: w.gh, repo: "o/r", issue: 8, inv, epic: 5 });
    assert.deepEqual([again.created, again.amendment], [false, f.amendment]);
    assert.equal([...w.issues.values()].filter((i) => /spike amendment/.test(i.title ?? "")).length, 1);
  });

  it("parseDispositions takes the last block; validateDispositions fails closed on a missing or bad one", () => {
    const blk = (o) => `\`\`\`${DISPOSITIONS_TAG}\n${JSON.stringify(o)}\n\`\`\``;
    const d = parseDispositions([blk({ children: { 8: { disposition: "dropped" } } }), blk({ children: { 8: { disposition: "unchanged" } } })]);
    assert.equal(d.children[8].disposition, "unchanged");
    assert.equal(validateDispositions(d, [8, 9]).ok, false);
    assert.equal(validateDispositions({ children: { 8: { disposition: "re-scoped" } } }, [8]).ok, false);
    assert.equal(validateDispositions({ children: { 8: { disposition: "bogus" } } }, [8]).ok, false);
    assert.equal(validateDispositions(d, [8]).ok, true);
  });

  it("renderEpicChecklist strikes dropped children and annotates re-scoped ones once", () => {
    const rows = [{ n: 8, disposition: "dropped" }, { n: 9, disposition: "re-scoped" }, { n: 10, disposition: "unchanged" }];
    const once = renderEpicChecklist("- [ ] #8 a\n- [ ] #9 b\n- [ ] #10 c\n", rows, 100);
    assert.equal(once, "- [x] ~~#8 a~~ (dropped, superseded by #100)\n- [ ] #9 b (re-scoped by #100)\n- [ ] #10 c\n");
    assert.equal(renderEpicChecklist(once, rows, 100), once);
  });

  it("applyReplan marks each open child unchanged, re-scoped or dropped, releases the hold and updates the epic", async () => {
    const w = repoWorld([{ number: 5, body: "- [ ] #8 a\n- [ ] #9 b\n- [ ] #10 c\n" }, { number: 8, body: "**Parent**: #5\n" }, { number: 9, body: "**Parent**: #5\n" }, { number: 10, body: "**Parent**: #5\n" }, { number: 99, body: "**Parent**: #5\n" }]);
    w.issues.get(5).labels = [{ name: "epic" }];
    // 5 is the epic; the children sit under it. Hold 8, 9, 10 as fileAmendment would.
    const f = await fileAmendment({ gh: w.gh, create: w.gh, repo: "o/r", issue: 99, inv, epic: 5 });
    w.issues.get(f.amendment).comments = [{ body: `\`\`\`${DISPOSITIONS_TAG}\n${JSON.stringify({ children: { 8: { disposition: "dropped" }, 9: { disposition: "re-scoped", body: "new design for 9" }, 10: { disposition: "unchanged" }, 99: { disposition: "unchanged" } } })}\n\`\`\`` }];
    const r = await applyReplan({ gh: w.gh, create: w.gh, repo: "o/r", amendment: f.amendment });
    assert.equal(r.ok, true);
    assert.equal(w.issues.get(8).state, "closed");
    assert.match(w.issues.get(9).body, /^new design for 9/);
    assert.match(w.issues.get(9).body, /^\*\*Parent\*\*: #5$/m);
    for (const n of [9, 10]) assert.doesNotMatch(w.issues.get(n).body, /Depends on/);
    assert.match(w.issues.get(5).body, /~~#8 a~~ \(dropped, superseded by #/);
  });

  it("applyReplan changes nothing when a held child has no disposition", async () => {
    const w = repoWorld([{ number: 8, body: "**Parent**: #5\n" }, { number: 9, body: "**Parent**: #5\n" }, { number: 99, body: "**Parent**: #5\n" }]);
    const f = await fileAmendment({ gh: w.gh, create: w.gh, repo: "o/r", issue: 99, inv, epic: 5 });
    w.issues.get(f.amendment).comments = [{ body: `\`\`\`${DISPOSITIONS_TAG}\n${JSON.stringify({ children: { 8: { disposition: "dropped" } } })}\n\`\`\`` }];
    const r = await applyReplan({ gh: w.gh, create: w.gh, repo: "o/r", amendment: f.amendment });
    assert.equal(r.ok, false);
    assert.match(r.problem, /#9/);
    assert.notEqual(w.issues.get(8).state, "closed");
  });

  it("applyReplan refuses an issue that is not an amendment", async () => {
    const w = repoWorld([{ number: 3, body: "plain" }]);
    assert.equal((await applyReplan({ gh: w.gh, create: w.gh, repo: "o/r", amendment: 3 })).ok, false);
    assert.match(amendmentBody({ inv, epic: 5, from: 7, children: [8] }), /FORGE:REPLAN/);
  });

  it("amendmentBody routes re-scoped user-visible children to /design before build (#5330)", () => {
    assert.match(amendmentBody({ inv, epic: 5, from: 7, children: [8] }), /user-visible[\s\S]*`\/design`[\s\S]*before build/);
  });
});
