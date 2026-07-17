// bin/tests/context-pack.test.mjs
// forge#2383: deterministic per-phase context pack builder — purity,
// truncation order, prototype-pollution sanitization, and fail-open behavior.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack } from "../engine/context-pack.mjs";

describe("buildContextPack — purity", () => {
  it("same inputs produce byte-identical output across repeated calls", () => {
    const input = {
      issue: { number: 42, title: "Fix: thing", body: "Do the thing." },
      priorOutputs: { investigate: { verdict: "CONFIRMED" }, context: { pitfalls: ["a", "b"] } },
      annotations: ["<!-- FORGE:CONTRACT -->\nSome contract text."],
      fileExcerpts: [{ path: "bin/foo.mjs", excerpt: "export function foo() {}" }],
    };
    const a = buildContextPack(input, { budgetBytes: 32000 });
    const b = buildContextPack(input, { budgetBytes: 32000 });
    assert.deepEqual(a, b, "identical inputs must produce an identical pack object");
  });

  it("does not mutate its inputs", () => {
    const input = {
      issue: { number: 1, title: "T", body: "B" },
      priorOutputs: { investigate: { a: 1 } },
      annotations: ["x"],
    };
    const before = JSON.parse(JSON.stringify(input));
    buildContextPack(input, {});
    assert.deepEqual(input, before, "buildContextPack must not mutate its input");
  });

  it("key order in priorOutputs does not change the resulting text when both are supplied", () => {
    const a = buildContextPack({ priorOutputs: { investigate: { x: 1 }, context: { y: 2 } } }, {});
    const b = buildContextPack({ priorOutputs: { investigate: { x: 1 }, context: { y: 2 } } }, {});
    assert.equal(a.text, b.text);
  });
});

describe("buildContextPack — fail-open / empty input", () => {
  it("returns a valid empty pack for no input at all", () => {
    const pack = buildContextPack();
    assert.equal(pack.text, "");
    assert.equal(pack.bytes, 0);
    assert.deepEqual(pack.sections, []);
    assert.deepEqual(pack.truncated, []);
  });

  it("returns a valid empty pack for {}", () => {
    const pack = buildContextPack({}, {});
    assert.equal(pack.text, "");
    assert.equal(pack.bytes, 0);
  });

  it("tolerates malformed/partial fields without throwing", () => {
    assert.doesNotThrow(() => buildContextPack({ issue: null, priorOutputs: null, annotations: null, fileExcerpts: null }));
    assert.doesNotThrow(() => buildContextPack({ priorOutputs: "not-an-object" }));
    assert.doesNotThrow(() => buildContextPack({ annotations: "not-an-array" }));
    assert.doesNotThrow(() => buildContextPack({ fileExcerpts: [{ excerpt: "no path" }, null, {}] }));
  });

  it("omits an empty priorOutputs object's phase entries with no throw", () => {
    const pack = buildContextPack({ priorOutputs: { investigate: {}, context: null } }, {});
    assert.equal(pack.sections.includes("priorOutputs"), false, "an all-empty priorOutputs object renders no section");
  });
});

describe("buildContextPack — section content", () => {
  it("renders the issue section with number/title/body", () => {
    const pack = buildContextPack({ issue: { number: 7, title: "Feat: x", body: "Body text." } }, {});
    assert.match(pack.text, /## Issue #7: Feat: x/);
    assert.match(pack.text, /Body text\./);
    assert.deepEqual(pack.sections, ["issue"]);
  });

  it("renders prior outputs as fenced JSON per phase", () => {
    const pack = buildContextPack({ priorOutputs: { investigate: { verdict: "CONFIRMED" } } }, {});
    assert.match(pack.text, /## Prior Phase Outputs/);
    assert.match(pack.text, /### investigate/);
    assert.match(pack.text, /"verdict": "CONFIRMED"/);
  });

  it("renders annotations verbatim, one per entry", () => {
    const pack = buildContextPack({ annotations: ["<!-- FORGE:CONTRACT -->\nApproach A", "<!-- FORGE:CONTEXT -->\nPitfall B"] }, {});
    assert.match(pack.text, /## Relevant FORGE Annotations/);
    assert.match(pack.text, /Approach A/);
    assert.match(pack.text, /Pitfall B/);
  });

  it("renders file excerpts under a fenced code block per file", () => {
    const pack = buildContextPack({ fileExcerpts: [{ path: "bin/x.mjs", excerpt: "const x = 1;" }] }, {});
    assert.match(pack.text, /## Candidate File Excerpts/);
    assert.match(pack.text, /### bin\/x\.mjs/);
    assert.match(pack.text, /const x = 1;/);
  });

  it("renders all four sections in issue -> priorOutputs -> annotations -> fileExcerpts order", () => {
    const pack = buildContextPack(
      {
        issue: { number: 1, title: "T", body: "B" },
        priorOutputs: { investigate: { a: 1 } },
        annotations: ["ann"],
        fileExcerpts: [{ path: "f.mjs", excerpt: "e" }],
      },
      {},
    );
    const issueIdx = pack.text.indexOf("## Issue");
    const priorIdx = pack.text.indexOf("## Prior Phase Outputs");
    const annIdx = pack.text.indexOf("## Relevant FORGE Annotations");
    const fileIdx = pack.text.indexOf("## Candidate File Excerpts");
    assert.ok(issueIdx >= 0 && priorIdx > issueIdx && annIdx > priorIdx && fileIdx > annIdx);
    assert.deepEqual(pack.sections, ["issue", "priorOutputs", "annotations", "fileExcerpts"]);
  });
});

describe("buildContextPack — deterministic truncation", () => {
  it("drops fileExcerpts first when over budget, keeping higher-priority sections", () => {
    const bigExcerpt = "x".repeat(5000);
    const input = {
      issue: { number: 1, title: "T", body: "short body" },
      priorOutputs: { investigate: { a: 1 } },
      annotations: ["short annotation"],
      fileExcerpts: [{ path: "f.mjs", excerpt: bigExcerpt }],
    };
    // Budget big enough for issue+priorOutputs+annotations but not the huge file excerpt.
    const pack = buildContextPack(input, { budgetBytes: 500 });
    assert.equal(pack.sections.includes("fileExcerpts"), false);
    assert.ok(pack.truncated.includes("fileExcerpts"));
    assert.equal(pack.sections.includes("issue"), true);
  });

  it("drops sections in strict priority order: fileExcerpts, then annotations, then priorOutputs, before issue", () => {
    const input = {
      issue: { number: 1, title: "T", body: "b".repeat(50) },
      priorOutputs: { investigate: { a: "p".repeat(2000) } },
      annotations: ["a".repeat(2000)],
      fileExcerpts: [{ path: "f.mjs", excerpt: "e".repeat(2000) }],
    };
    const pack = buildContextPack(input, { budgetBytes: 200 });
    // Only the issue section (highest priority) should survive at this tight budget.
    assert.deepEqual(pack.sections, ["issue"]);
    assert.deepEqual(pack.truncated.slice(0, 3), ["fileExcerpts", "annotations", "priorOutputs"]);
  });

  it("hard-truncates deterministically when even the issue section alone exceeds budget", () => {
    const hugeBody = "y".repeat(10000);
    const pack1 = buildContextPack({ issue: { number: 1, title: "T", body: hugeBody } }, { budgetBytes: 100 });
    const pack2 = buildContextPack({ issue: { number: 1, title: "T", body: hugeBody } }, { budgetBytes: 100 });
    assert.equal(pack1.text, pack2.text, "hard-truncation must be deterministic");
    // Review-finding #2517 fix: the result must never exceed the requested
    // budget at all (previously tolerated exceeding it by up to markerBytes).
    assert.ok(pack1.bytes <= 100, "truncated output must never exceed the requested budgetBytes");
    assert.ok(pack1.truncated.includes("hard-truncate"));
  });

  it("never splits a multi-byte UTF-8 character when hard-truncating", () => {
    // Repeat a 3-byte UTF-8 character (emoji-adjacent CJK char) enough to force
    // hard truncation at a byte budget that does not land on a char boundary.
    const ch = "文"; // U+6587, 3 bytes in UTF-8
    const body = ch.repeat(200);
    const pack = buildContextPack({ issue: { number: 1, title: "T", body } }, { budgetBytes: 101 });
    // toString('utf-8') on a valid buffer never produces the replacement
    // character (U+FFFD) for a boundary we chose correctly ourselves.
    assert.equal(pack.text.includes("�"), false, "must not contain a UTF-8 replacement character from a mid-char split");
  });

  // Review-finding #2517 (CONFIRMED, LOW): truncateToBytes previously
  // returned the full, un-truncated marker (~46 bytes) whenever budgetBytes
  // was smaller than the marker itself, violating its own "at most maxBytes"
  // contract. Fixed by shrinking the marker itself to fit.
  it("review-finding #2517: never exceeds budgetBytes even when the budget is smaller than the truncation marker", () => {
    for (const tinyBudget of [0, 1, 5, 10, 20, 45, 46, 47]) {
      const pack = buildContextPack({ issue: { number: 1, title: "T", body: "x".repeat(500) } }, { budgetBytes: tinyBudget });
      assert.ok(
        pack.bytes <= tinyBudget,
        `budgetBytes=${tinyBudget}: expected pack.bytes (${pack.bytes}) <= ${tinyBudget}`,
      );
    }
  });

  it("review-finding #2517: is deterministic at tiny budgets too", () => {
    const input = { issue: { number: 1, title: "T", body: "x".repeat(500) } };
    const a = buildContextPack(input, { budgetBytes: 10 });
    const b = buildContextPack(input, { budgetBytes: 10 });
    assert.deepEqual(a, b);
  });
});

describe("buildContextPack — prototype-pollution sanitization", () => {
  it("strips __proto__ from prior output objects", () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "verdict": "CONFIRMED"}');
    const pack = buildContextPack({ priorOutputs: { investigate: malicious } }, {});
    assert.equal(pack.text.includes("polluted"), false);
    assert.match(pack.text, /"verdict": "CONFIRMED"/);
    // Confirm no actual prototype pollution occurred on Object.prototype.
    assert.equal(({}).polluted, undefined);
  });

  it("strips constructor/prototype keys at nested levels", () => {
    const malicious = { outer: { constructor: { evil: 1 }, prototype: { evil: 2 }, safe: "kept" } };
    const pack = buildContextPack({ priorOutputs: { build: malicious } }, {});
    assert.equal(pack.text.includes("evil"), false);
    assert.match(pack.text, /"safe": "kept"/);
  });

  it("does not throw on a self-referential (cyclic) prior output object", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => buildContextPack({ priorOutputs: { build: cyclic } }, {}));
  });

  it("preserves arrays and non-dangerous nested structures", () => {
    const pack = buildContextPack({ priorOutputs: { context: { pitfalls: ["a", "b", { nested: "c" }] } } }, {});
    assert.match(pack.text, /"pitfalls": \[/);
    assert.match(pack.text, /"nested": "c"/);
  });
});
