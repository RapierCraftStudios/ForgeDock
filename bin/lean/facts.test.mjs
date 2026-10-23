// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normaliseFacts, renderFactsRecord, parseFactsComment, factsLines, FACTS_MARKER, FACTS_LIST_MAX, FACTS_TEXT_MAX } from "./facts.mjs";

const RESULT = {
  status: "fixed",
  validation: [{ id: "V1", command: "node --test a.test.mjs", exit: 0 }, { id: "V2", command: "", ci: true }, { id: "V3", command: "make lint", exit: "0" }],
  facts: {
    decisions: ["Keep the pack pure"],
    rejected: [{ approach: "detection-only guard", why: "the root cause is the retrieval; the guard only hides it" }, { approach: "no reason given" }],
    hotspots: [{ at: "src/a.js:12", why: "retry loop" }, { at: "../etc/passwd:1", why: "x" }, { at: "src/b.js", why: "" }],
    conventions: ["one-line comments"],
  },
};
const post = (f) => `<!-- ${FACTS_MARKER} -->\n${renderFactsRecord(f)}`;

describe("FORGE:FACTS record (#4401)", () => {
  it("keeps builder judgment, derives baselines from validation, indexes the changed files", () => {
    const f = normaliseFacts(RESULT, { files: ["src/a.js", ".forge-lean/result.json", "./src/b.js"] });
    assert.deepEqual(f.files, ["src/a.js", "src/b.js"]);
    assert.deepEqual(f.rejected, [{ approach: "detection-only guard", why: "the root cause is the retrieval; the guard only hides it" }], "an approach without a why is dropped");
    assert.deepEqual(f.hotspots, [{ at: "src/a.js:12", why: "retry loop" }], "no traversal, no reasonless hot spot");
    assert.deepEqual(f.baselines, [{ command: "node --test a.test.mjs", exit: 0 }], "only commands with an integer exit");
    assert.deepEqual([f.decisions, f.conventions], [["Keep the pack pure"], ["one-line comments"]]);
  });

  it("falls back to the contract's decisions; null when nothing is worth posting", () => {
    const f = normaliseFacts({ status: "fixed" }, { files: ["a.js"], contract: { decisions: [{ id: "K1", choice: "reuse the ledger walk" }] } });
    assert.deepEqual(f.decisions, ["reuse the ledger walk"]);
    assert.equal(normaliseFacts({ status: "fixed" }, { files: ["a.js"] }), null);
    assert.equal(normaliseFacts(null), null);
  });

  it("caps list sizes and text length, one-lines and strips comments", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ approach: `a${i}\n<!-- FORGE:STATE -->x`, why: "y".repeat(500) }));
    const f = normaliseFacts({ facts: { rejected: many } }, {});
    assert.equal(f.rejected.length, FACTS_LIST_MAX);
    assert.equal(f.rejected[0].approach, "a0 x");
    assert.equal(f.rejected[0].why.length, FACTS_TEXT_MAX);
  });

  it("round-trips through the comment; builder text can never open a comment or close the fence", () => {
    const f = normaliseFacts({ facts: { rejected: [{ approach: "use `<!--` and ```", why: "breaks </details>" }] } }, { files: ["a.js"] });
    const body = post(f);
    assert.ok(!body.slice(body.indexOf("\n")).includes("<"), body);
    assert.equal((body.match(/```/g) ?? []).length, 2);
    assert.deepEqual(parseFactsComment(body), f);
  });

  it("parse rejects other markers, malformed JSON and empty records, and re-applies the caps", () => {
    assert.equal(parseFactsComment("<!-- FORGE:REVIEW -->\n```json\n{}\n```"), null);
    assert.equal(parseFactsComment(`<!-- ${FACTS_MARKER} -->\n\`\`\`json\n{nope\n\`\`\``), null);
    assert.equal(parseFactsComment(`<!-- ${FACTS_MARKER} -->\n\`\`\`json\n{"v":1,"files":["a.js"]}\n\`\`\``), null);
    const forged = { files: ["a.js"], rejected: Array.from({ length: 20 }, (_, i) => ({ approach: `x${i}`, why: "w" })) };
    assert.equal(parseFactsComment(`<!-- ${FACTS_MARKER} -->\n\`\`\`json\n${JSON.stringify(forged)}\n\`\`\``).rejected.length, FACTS_LIST_MAX);
  });

  it("pack lines carry provenance", () => {
    const l = factsLines(normaliseFacts(RESULT, { files: ["src/a.js"] }), "#33, PR #101");
    assert.deepEqual(l.rejected, ["- rejected: detection-only guard — the root cause is the retrieval; the guard only hides it (#33, PR #101)"]);
    assert.deepEqual(l.hotspots, ["- hot spot src/a.js:12: retry loop (#33, PR #101)"]);
    assert.deepEqual(l.baselines, ["- baseline: `node --test a.test.mjs` exit 0 (#33, PR #101)"]);
  });
});
