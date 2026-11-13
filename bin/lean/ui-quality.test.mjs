// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uiChanged, uiIssue, designPaths, designSystemRule, uiSelfCheckRule, uiBuildRule, visualReviewCheck, visualSection } from "./ui-quality.mjs";
import { DOMAIN_CHECKS, domainChecksBlock } from "./prompts.mjs";
import { renderPrBody } from "./render.mjs";

describe("UI lane quality (#5330)", () => {
  it("detects user-visible UI files, not tests", () => {
    assert.deepEqual(uiChanged(["web/app/page.tsx", "web/app/page.test.tsx", "src/a.mjs", "styles/x.css"]), ["web/app/page.tsx", "styles/x.css"]);
    assert.deepEqual(uiChanged(undefined), []);
  });
  it("detects a UI issue from text or labels", () => {
    assert.ok(uiIssue({ title: "Fix the settings page layout" }));
    assert.ok(uiIssue({ title: "x", labels: [{ name: "frontend" }] }));
    assert.ok(!uiIssue({ title: "Fix retry backoff", body: "scheduler bug" }));
  });
  it("names design.system paths, or falls back to forge.yaml", () => {
    assert.deepEqual(designPaths({ system: "a.md, b.css" }), ["a.md", "b.css"]);
    assert.match(designSystemRule({ system: ["docs/ds.md"] }), /docs\/ds\.md[\s\S]*empty, loading and error states[\s\S]*no placeholder boxes/);
    assert.match(designSystemRule(null), /forge\.yaml design\.system/);
  });
  it("the self-check never installs a browser and records the visual check", () => {
    const r = uiSelfCheckRule();
    assert.match(r, /desktop and mobile/); assert.match(r, /never install one/); assert.match(r, /### Visual Check/); assert.match(r, /\/design/);
  });
  it("adds the build rule only to UI lanes", () => {
    assert.equal(uiBuildRule(false), "");
    assert.match(uiBuildRule(true), /UI change[\s\S]*Self-check/);
  });
  it("the frontend domain check carries the visual check and the ISR check", () => {
    assert.ok(DOMAIN_CHECKS.frontend.startsWith(visualReviewCheck()));
    assert.match(DOMAIN_CHECKS.frontend, /headers\(\), cookies\(\)/);
    assert.match(domainChecksBlock(["frontend"]), /off-system colours, fonts or spacing/);
  });
  it("the PR body shows the Visual check section only when recorded", () => {
    const impl = "### Approach\nx\n### Visual Check\n- shots: $TMPDIR/a.png\n- verdict: consistent\n### Notes\nn";
    assert.equal(visualSection("### Approach\nx"), "");
    assert.equal(visualSection("### Visual Check\n\n### Notes\n"), "");
    const body = renderPrBody({ issue: 1, investigation: "", contract: { deliverables: [] }, implementation: impl, result: {}, gitFiles: [] });
    assert.match(body, /## Visual check\n- shots: \$TMPDIR\/a\.png\n- verdict: consistent\n\nCloses #1/);
    assert.ok(!renderPrBody({ issue: 1, investigation: "", contract: { deliverables: [] }, implementation: "### Approach\nx", result: {}, gitFiles: [] }).includes("Visual check"));
  });
});

describe("design.system wiring (#5330)", () => {
  it("forge.yaml design.system feeds the build rule", async () => {
    const { parseForgeYaml } = await import("../forge-utils.mjs");
    const cfg = parseForgeYaml("design:\n  system: [docs/ds.md, web/tokens.css]\n").design;
    assert.deepEqual(designPaths(cfg), ["docs/ds.md", "web/tokens.css"]);
    assert.match(uiBuildRule(true, cfg), /docs\/ds\.md, web\/tokens\.css/);
    assert.equal(uiBuildRule(false, cfg), "");
  });
});
