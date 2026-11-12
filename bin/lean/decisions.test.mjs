// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { normaliseDecision, interfaceDecisions, renderDecision, parseDecisionComment, foldDecisions, anchorMatches, deadAnchors, staleDecisions, historyRows, withDecisionRows, supersede, readDecisionIndex, recordDecisions, HISTORY_ROWS_MAX } from "./decisions.mjs";

const D = (o) => normaliseDecision({ choice: "use A not B", why: "B leaks", anchors: ["src/a/**"], ...o }, { issue: 10, n: 1 });

describe("decisions (#4695)", () => {
  it("round-trips through the marker line and ignores prose FORGE:DECISION comments", () => {
    const d = D({ symbols: ["foo"], anchors: ["src/a/x.js", "lib/-->evil"] });
    const m = renderDecision(d);
    const body = `<!-- ${m.marker} -->\n${m.body}`;
    assert.deepEqual(parseDecisionComment(body), d);
    assert.equal(parseDecisionComment("<!-- FORGE:DECISION -->\n## Decision (batch 1)\n**What**: x"), null);
    assert.equal(parseDecisionComment("<!-- FORGE:DECISION {nope} -->"), null);
    assert.equal(normaliseDecision({ choice: "x", anchors: [] }), null);
  });
  it("matches files, directory prefixes and globs", () => {
    assert.ok(anchorMatches("src/a.js", "src/a.js"));
    assert.ok(anchorMatches("src/a/", "src/a/b/c.js"));
    assert.ok(anchorMatches("src/**", "src/a/b.js"));
    assert.ok(anchorMatches("src/*.js", "src/a.js"));
    assert.ok(!anchorMatches("src/*.js", "src/a/b.js"));
    assert.deepEqual(deadAnchors(["src/a.js", "gone/**"], ["src/a.js"]), ["gone/**"]);
  });
  it("history rows: only anchored deliverables, capped at 5, deterministic", () => {
    const recs = Array.from({ length: 8 }, (_, i) => normaliseDecision({ id: `d${i}`, choice: `c${i}`, anchors: ["src/**"], issue: i + 1 }));
    const a = historyRows(recs, ["src/x.js"]), b = historyRows([...recs].reverse(), ["src/x.js"]);
    assert.equal(a.length, HISTORY_ROWS_MAX);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((r) => r.id), ["H1", "H2", "H3", "H4", "H5"]);
    assert.equal(a[0].decision, "d7");
    assert.ok(a.every((r) => r.source === "decision" && r.what.includes("supersedes")));
    assert.deepEqual(historyRows(recs, ["docs/x.md"]), []);
    assert.deepEqual(historyRows([], ["src/x.js"]), []);
  });
  it("withDecisionRows leaves a contract with no hit untouched (same object)", () => {
    const c = { preserve: [{ id: "P1", what: "w" }], deliverables: [{ id: "D1", path: "docs/x.md" }] };
    assert.equal(withDecisionRows(c, [D()]), c);
    const c2 = withDecisionRows({ ...c, deliverables: [{ id: "D1", path: "src/a/x.js" }] }, [D()]);
    assert.deepEqual(c2.preserve.map((p) => p.id), ["P1", "H1"]);
  });
  it("supersession links both records and the old one stops binding", () => {
    const old = D({ id: "d10-1" }), next = D({ id: "d11-1", choice: "use B" });
    const r = supersede(old, next);
    assert.equal(r.old.status, "superseded");
    assert.equal(r.old.superseded_by, "d11-1");
    assert.equal(r.next.supersedes, "d10-1");
    assert.deepEqual(historyRows([old, r.old], ["src/a/x.js"]), []);
    assert.equal(foldDecisions([old, r.old]).length, 1);
  });
  it("lists stale decisions with dead anchors, never superseded ones", () => {
    const live = D({ id: "a" }), dead = D({ id: "b", anchors: ["src/a/**", "old/x.js"] }), gone = D({ id: "c", anchors: ["old/y.js"], status: "superseded", superseded_by: "z" });
    const s = staleDecisions([live, dead, gone], ["src/a/q.js"]);
    assert.deepEqual(s.map((x) => [x.decision.id, x.dead]), [["b", ["old/x.js"]]]);
  });
  it("recordDecisions posts the new and the superseded old record and updates the index", async () => {
    process.env.FORGEDOCK_DECISIONS_DIR = tmpDir("dec-");
    const posts = [], post = async (marker, body, on) => { posts.push({ marker, on }); };
    const first = await recordDecisions([{ choice: "use A", anchors: ["src/**"], why: "w" }], { issue: 10, repo: "o/r", post });
    assert.equal(first[0].id, "d10-1");
    const second = await recordDecisions([{ choice: "use B", anchors: ["src/**"], why: "w2", supersedes: "d10-1" }], { issue: 11, repo: "o/r", post });
    assert.equal(second[0].supersedes, "d10-1");
    assert.deepEqual(posts.map((p) => p.on), [10, 11, 10]);
    const idx = foldDecisions(readDecisionIndex("o/r"));
    assert.equal(idx.find((d) => d.id === "d10-1").status, "superseded");
    assert.equal(idx.find((d) => d.id === "d11-1").supersedes, "d10-1");
  });
  it("interface decisions (#5338): spike rows and anchored choices become records; lanes on the anchors get H-rows; supersedes retires one", () => {
    const spike = [
      "## Stack", "next", "**Rationale**: one framework", "**Anchors**: `web/`", "",
      "## Interfaces", "| Boundary | Signature or schema | Auth mode | Owner issue | Anchors |", "|---|---|---|---|---|",
      "| api -> worker | refund(id: str, amount: int) | internal key | WORKER | `worker/refund.py`, `api/` |",
      "| {x} | {y} | {z} | {o} | `{p}` |", "| no anchor | sig | key | O | |", "",
    ].join("\n");
    const recs = interfaceDecisions(spike, { issue: 7 });
    assert.deepEqual(recs.map((r) => r.id), ["i7-1", "i7-2"]);
    assert.deepEqual(recs.map((r) => r.anchors), [["web/"], ["worker/refund.py", "api/"]]);
    assert.equal(recs[1].choice, "Interface api -> worker: refund(id: str, amount: int); auth internal key; owner WORKER");
    const lane = withDecisionRows({ deliverables: [{ id: "D1", path: "worker/refund.py" }], preserve: [] }, recs);
    assert.equal(lane.preserve.length, 1);
    assert.equal(lane.preserve[0].source, "decision");
    assert.match(lane.preserve[0].what, /Interface api -> worker.*supersedes:"i7-2"/);
    const { old, next } = supersede(recs[1], D({ id: "n" }));
    const gone = withDecisionRows({ deliverables: [{ id: "D1", path: "worker/refund.py" }], preserve: [] }, [...recs, old, next]);
    assert.ok(gone.preserve.every((p) => p.decision !== "i7-2"));
    assert.deepEqual(interfaceDecisions("## Interfaces\nnone", { issue: 1 }), []);
  });
});
