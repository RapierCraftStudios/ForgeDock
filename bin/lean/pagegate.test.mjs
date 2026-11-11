// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePagesConfig, pageFiles, contractBriefProblems, pageFailures, designSpecApproved, designHold, designLabelApproved } from "./pagegate.mjs";
import { pagePlanNote, domainChecksBlock } from "./prompts.mjs";
import { pathDomains } from "./review-trigger.mjs";
import { validateContract, precheck } from "./conformance.mjs";

const cfg = parsePagesConfig(undefined, { hasAppPages: true });
// The shape of the AlterLab Store PRs (#5428): listing pages with null samples, no structured data, no sitemap, no briefs.
const storeFiles = ["web/app/store/[slug]/page.tsx"];
const storeDiff = "+++ b/web/app/store/[slug]/page.tsx\n+<p>Sample output [[null]]</p>\n+<p>Success rate 0.0%</p>\n+<a href=\"/pricing\">x</a>\n";
const read = (p) => (p === storeFiles[0] ? "export default function P() { return null }" : "");

describe("page gate (#5428)", () => {
  it("is on by default only for app repos and off when disabled", () => {
    assert.equal(parsePagesConfig(undefined), null);
    assert.equal(parsePagesConfig({ enabled: false }, { hasAppPages: true }), null);
    assert.deepEqual(cfg.require, ["design", "seo_intent", "geo"]);
    assert.equal(parsePagesConfig({ routes: ["site/**/*.html"] }).routes.length, 1);
    assert.deepEqual(pageFiles(["web/app/a/page.tsx", "web/app/a/page.test.tsx", "web/app/api/x/route.ts"], cfg), ["web/app/a/page.tsx"]);
    assert.equal(pagePlanNote(null), "");
    assert.match(pagePlanNote(cfg), /page_gate/);
  });
  it("replay at contract time: a page deliverable with no design spec, ICP or GEO brief fails validateContract", () => {
    const c = { deliverables: [{ id: "D1", path: storeFiles[0], change: "x", requirements: ["R1"] }] };
    assert.equal(contractBriefProblems(c, cfg).length, 1);
    const partial = { ...c, page_gate: { design_spec: "", seo: { intent: "buy tools" }, geo: {} } };
    const p = contractBriefProblems(partial, cfg).join("\n");
    assert.match(p, /design_spec/); assert.match(p, /seo is missing .*icp/); assert.match(p, /geo is missing/);
    const issue = "Add the store page";
    const v = validateContract({ requirements: [{ id: "R1", quote: "Add the store page", disposition: "deliver" }], deliverables: c.deliverables, validate: [{ id: "V1", command: "true" }] }, issue, { pages: cfg });
    assert.ok(v.problems.some((x) => /page_gate/.test(x)));
    const ok = { ...c, page_gate: { design_spec: "#1 FORGE:DESIGN_SPEC", seo: { intent: "a", icp: "b", title: "c", h1: "d", meta: "e", structured_data: "Product", links_in: ["/"], links_out: ["/x"], gsc_baseline: "none", measure_by: "2027-01-01" }, geo: { surfaces: ["llms.txt"], agent_question: "q?" } } };
    assert.deepEqual(contractBriefProblems(ok, cfg), []);
    assert.deepEqual(contractBriefProblems(c, null), []);
  });
  it("replay at CI: null samples, missing structured data, sitemap, canonical, design and screenshots all fail precheck", async () => {
    const f = await pageFailures({ cfg, files: storeFiles, diff: storeDiff, readFile: read, tracked: storeFiles, designApproved: false });
    assert.deepEqual([...new Set(f.map((x) => x.kind))].sort(), ["page_canonical_missing", "page_design_missing", "page_forbidden_pattern", "page_link_broken", "page_metadata_missing", "page_sitemap_missing", "page_structured_data_missing", "page_visual_missing"]);
    const pc = precheck({ contract: { requirements: [], deliverables: [], validate: [] }, result: {}, changedFiles: storeFiles, pageFailures: f });
    assert.ok(pc.failures.some((x) => x.kind === "page_sitemap_missing"));
  });
  it("passes a complete page, ignores repos without pages, and runs pages.lint", async () => {
    const good = (p) => (p === storeFiles[0] ? "export const metadata = {alternates:{canonical:'/s'}}; <script type=\"application/ld+json\"/>" : "");
    const files = [...storeFiles, "web/app/sitemap.ts"];
    const diff = "+++ b/web/app/store/[slug]/page.tsx\n+<a href=\"/store\">all</a>\n";
    const tracked = [...files, "web/app/store/page.tsx"];
    const shots = { page_gate: { screenshots: ["home-390.png", "home-1440.png"] } };
    assert.deepEqual(await pageFailures({ cfg, files, diff, readFile: good, tracked, designApproved: true, result: shots }), []);
    assert.deepEqual(await pageFailures({ cfg, files: ["src/cli.ts"], diff: "", tracked: [] }), []);
    assert.deepEqual(await pageFailures({ cfg: null, files: storeFiles }), []);
    const lint = { ...cfg, lint: "bash lint.sh" };
    const bad = await pageFailures({ cfg: lint, files, diff, readFile: good, tracked, designApproved: true, result: shots, run: async () => ({ rc: 1, output: "nope" }) });
    assert.deepEqual(bad.map((x) => x.kind), ["page_lint_failed"]);
  });
  it("reads design spec approval and adds design + seo-geo review domains", () => {
    assert.equal(designSpecApproved([{ body: "<!-- FORGE:DESIGN_SPEC -->\n{}" }]), true);
    assert.equal(designSpecApproved([{ body: "FORGE:DESIGN_SPEC status: draft" }]), false);
    assert.equal(designSpecApproved([]), false);
    const d = pathDomains(storeFiles, { pages: cfg });
    assert.ok(d.includes("design") && d.includes("seo-geo"));
    assert.ok(!pathDomains(storeFiles).includes("design"));
    assert.match(domainChecksBlock(["seo-geo"]), /canonical/);
  });
});

describe("design hold (#5442)", () => {
  it("holds design:* before approval and lifts on design:approved", () => {
    assert.equal(designHold([{ name: "design:needed" }]), "design:needed");
    assert.equal(designHold(["design:needed", "design:approved"]), null);
    assert.equal(designHold([{ name: "bug" }]), null);
    assert.equal(designLabelApproved([{ name: "design:approved" }]), true);
    assert.equal(designLabelApproved([]), false);
  });
});
