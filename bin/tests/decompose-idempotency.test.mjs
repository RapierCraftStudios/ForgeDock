import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(
  new URL("../../commands/work-on/decompose.md", import.meta.url),
  "utf8",
);

describe("decomposition idempotency", () => {
  it("returns an existing exact parent-linked child set before creating another", () => {
    assert.match(spec, /## Phase D2\.5: Equivalent Set Check/);
    assert.match(spec, /--state all/);
    assert.match(spec, /\*\*Parent\*\*: #\{NUMBER\}/);
    assert.match(spec, /group_by\(\.title\) \| map\(\.\[0\]\)/);
    assert.match(spec, /\$actual == \$expected/);
    assert.match(spec, /Do \*\*not\*\* create issues, edit the parent body, or post another decomposition comment/);
    assert.match(spec, /status: ALREADY_DONE/);
  });
});

describe("decomposition close-parent phase", () => {
  const d65 = spec.slice(spec.indexOf("## Phase D6.5"), spec.indexOf("## Phase D7"));

  it("is opt-in via decomposition.close_parent and fails safe to false", () => {
    assert.ok(d65.length > 0);
    assert.match(d65, /\.decomposition\.close_parent \/\/ false/);
    assert.match(d65, /\[ "\$CLOSE_PARENT" = "true" \] \|\| CLOSE_PARENT=false/);
  });

  it("closes only an OPEN parent after the DECOMPOSED:COMPLETE marker, keeping the label", () => {
    assert.match(d65, /FORGE:DECOMPOSED:COMPLETE/);
    assert.match(d65, /"\$PARENT_STATE" = "OPEN"/);
    assert.match(d65, /run gh issue close \{NUMBER\}/);
    assert.match(d65, /Decomposed into \$\{REFS\}; tracked here until all complete/);
    assert.doesNotMatch(d65, /remove-label[^\n]*workflow:decomposed/);
    assert.ok(spec.indexOf("## Phase D6.5") > spec.indexOf("## Phase D6:"));
  });

  it("guards every child for the **Parent**: #N reference and an empty SUB_NUMBER", () => {
    assert.match(d65, /\*\*Parent\*\*: #\{NUMBER\}/);
    assert.match(d65, /\[ -n "\$SUB_NUMBER" \] \|\| continue/);
  });

  it("runs on both ALREADY_DONE exits", () => {
    const hits = spec.match(/Phase D6\.5 \(close parent when `decomposition\.close_parent` is true\)/g) || [];
    assert.equal(hits.length, 2);
  });
});

