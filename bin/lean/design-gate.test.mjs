// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDesignConfig, designOn, designFiles, designPages, routeOf, specApproved, designGate, designGateNote, critiqueMarkup, visualGate, designFailures, visualGateComment } from "./design-gate.mjs";
import { precheck } from "./conformance.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";

// The AlterLab block as filed on #5330 (2026-11-10): these exact keys are consumed.
const YAML = `design:
  gate: blocking
  routes: ["web/src/app/(site)/**/page.tsx", "web/src/app/(site)/**/layout.tsx"]
  exclude: ["web/src/app/(site)/api/**"]
  system: [web/src/components/marketing/home, web/src/components/dashboard, web/src/components/ui]
  spec_label: design:approved
  needed_label: design:needed
  directions_param: dir
  viewports: [390, 1440]
  require_visual_check: true
`;
const cfg = parseDesignConfig(parseForgeYaml(YAML).design);

/** The regression fixture: Hands 2026-11-09, a plain-text hero, empty Needs/Evidence/Action boxes, a bare "Get access" link. */
const HANDS_BAD = `export default function Page() {
  return (
    <main>
      <h1>AlterLab Hands</h1>
      <p>Delegate any task to a person.</p>
      <div className="rounded border p-4"><h3>Needs</h3></div>
      <div className="rounded border p-4"></div>
      <div className="rounded border p-4" />
      <a href="/signup">Get access</a>
    </main>
  );
}`;
const HANDS_GOOD = `import { Hero } from "@/components/marketing/home/Hero";
import { NeedCard } from "@/components/marketing/home/NeedCard";
export default function Page() {
  return (
    <main>
      <Hero title="AlterLab Hands" />
      <section className="grid">
        <NeedCard title="Needs" body="A named task with an owner." />
        <div className="rounded border p-4"><h3>Evidence</h3><p>Receipts and photos.</p></div>
      </section>
      <Button asChild><a href="/signup">Get access</a></Button>
    </main>
  );
}`;

describe("design config (#5330 R15)", () => {
  it("parses the AlterLab keys exactly", () => {
    assert.equal(cfg.gate, "blocking");
    assert.deepEqual(cfg.routes, ["web/src/app/(site)/**/page.tsx", "web/src/app/(site)/**/layout.tsx"]);
    assert.deepEqual(cfg.exclude, ["web/src/app/(site)/api/**"]);
    assert.equal(cfg.system.length, 3);
    assert.equal(cfg.specLabel, "design:approved"); assert.equal(cfg.neededLabel, "design:needed"); assert.equal(cfg.directionsParam, "dir");
    assert.deepEqual(cfg.viewports, [390, 1440]); assert.equal(cfg.requireVisual, true);
    assert.ok(designOn(cfg));
  });
  it("defaults: advisory, 390/1440, label design:approved, rendered check required", () => {
    const c = parseDesignConfig({ routes: ["web/app/**"], gate: "bogus" });
    assert.deepEqual([c.gate, c.viewports, c.specLabel, c.requireVisual], ["advisory", [390, 1440], "design:approved", true]);
    assert.equal(parseDesignConfig({ routes: "web/app/**, other/**", require_visual_check: "false" }).requireVisual, false);
  });
  it("opt-in: no design block or no design.routes means the gate is off and nothing is routed", () => {
    for (const c of [null, undefined, parseDesignConfig(undefined), parseDesignConfig({ system: ["docs/ds.md"] }), parseDesignConfig({ gate: "blocking" })]) {
      assert.equal(designOn(c), false);
      assert.deepEqual(designGate({ files: ["web/app/x/page.tsx"], cfg: c }), { route: false, blocked: false, pages: [], reason: "" });
      assert.equal(designGateNote(designGate({ files: ["web/app/x/page.tsx"], cfg: c })), "");
      assert.deepEqual(designFailures({ cfg: c, files: ["web/app/x/page.tsx"], readFile: () => HANDS_BAD }), []);
      assert.equal(visualGate({ cfg: c, files: ["web/app/x/page.tsx"] }).verdict, "SKIP");
    }
    assert.deepEqual(parseDesignConfig({ system: ["docs/ds.md"] }).system, ["docs/ds.md"]); // system is still read for UI lanes
  });
});

describe("design routing (#5330 R11)", () => {
  const P = "web/src/app/(site)/hands/page.tsx";
  it("selects user-visible route files, minus exclude and tests", () => {
    const files = [P, "web/src/app/(site)/layout.tsx", "web/src/app/(site)/api/x/page.tsx", "web/src/app/(site)/hands/page.test.tsx", "web/src/app/dashboard/page.tsx", "services/api/x.py"];
    assert.deepEqual(designFiles(files, cfg), [P, "web/src/app/(site)/layout.tsx"]);
    assert.deepEqual(designPages(files, cfg), [P]);
    assert.equal(routeOf(P), "/hands"); assert.equal(routeOf("web/src/app/(site)/layout.tsx"), "/");
  });
  it("a predicted new page.tsx under design.routes with no spec is routed to /design and blocked with gate: blocking", () => {
    const g = designGate({ files: [P, "src/a.mjs"], cfg });
    assert.deepEqual([g.route, g.blocked, g.pages], [true, true, [P]]);
    assert.match(g.reason, /\/design/); assert.match(designGateNote(g), /stop with a block asking for \/design/);
  });
  it("advisory routes without blocking", () => {
    const g = designGate({ files: [P], cfg: { ...cfg, gate: "advisory" } });
    assert.deepEqual([g.route, g.blocked], [true, false]); assert.match(designGateNote(g), /reference a \/design spec/);
  });
  it("a FORGE:DESIGN_SPEC comment or the spec label clears it; a draft spec does not", () => {
    assert.equal(designGate({ files: [P], cfg, comments: [{ body: "<!-- FORGE:DESIGN_SPEC -->\nok" }] }).route, false);
    assert.equal(designGate({ files: [P], cfg, labels: [{ name: "design:approved" }] }).route, false);
    assert.equal(designGate({ files: [P], cfg, comments: [{ body: '<!-- FORGE:DESIGN_SPEC {"status":"draft"} -->' }] }).route, true);
    assert.equal(specApproved({ labels: ["design:approved"], cfg }), true);
  });
  it("a change that adds no page entry (a component, an excluded api route) is not routed", () => {
    assert.equal(designGate({ files: ["web/src/components/ui/button.tsx", "web/src/app/(site)/api/x/page.tsx"], cfg }).route, false);
  });
});

describe("deterministic render critique floor (#5330 R14)", () => {
  const ids = (src) => critiqueMarkup(src).map((f) => f.id);
  it("flags the plain-text hero page with empty boxes", () => {
    const f = ids(HANDS_BAD);
    assert.ok(f.includes("empty_box")); assert.ok(f.includes("plain_text_hero")); assert.ok(f.includes("bare_cta"));
  });
  it("passes a page with components, filled cards and a real button", () => assert.deepEqual(critiqueMarkup(HANDS_GOOD), []));
  it("placeholder copy and null samples block", () => {
    assert.ok(ids("<main><Hero/><p>Lorem ipsum dolor</p></main>").includes("placeholder_text"));
    assert.ok(ids("<main><Hero/><p>[[null]]</p></main>").includes("placeholder_text"));
  });
  it("decorative dividers, skeletons and commented-out boxes are not empty boxes", () => {
    assert.deepEqual(ids('<main><Hero/><div className="border-t" /><div className="rounded animate-pulse" /><div aria-hidden className="rounded border" />{/* <div className="rounded border"></div> */}</main>'), []);
  });
});

describe("visual gate (#5330 R12, R14; shared with #5369)", () => {
  const P = "web/src/app/(site)/hands/page.tsx";
  const shots = { "/hands": { screenshots: ["shots/hands-390.png", "shots/hands-1440.png"], verdict: "PASS" } };
  it("regression fixture: a bundle adding the plain-text hero page with empty boxes fails the gate", () => {
    const g = visualGate({ cfg, files: [P], specs: true, sources: { [P]: HANDS_BAD } });
    assert.equal(g.verdict, "FAIL");
    assert.ok(g.rows.some((r) => r.kind === "visual_critique_failed" && /empty_box/.test(r.detail)));
    assert.ok(g.rows.some((r) => /plain_text_hero/.test(r.detail)));
  });
  it("the same bundle through the lane precheck is a conformance.unimplemented failure", () => {
    const rows = designFailures({ cfg, files: [P], specs: true, readFile: () => HANDS_BAD });
    assert.ok(rows.length >= 2); assert.ok(rows.every((r) => r.code === "conformance.unimplemented"));
    const p = precheck({ contract: { requirements: [], deliverables: [{ id: "D1", path: P }] }, result: { status: "fixed" }, changedFiles: [P], pageFailures: rows });
    assert.ok(JSON.stringify(p).includes("visual_critique_failed"));
  });
  it("blocking: a missing spec yields a failure; a good page with a spec, screenshots at both viewports and a PASS verdict passes", () => {
    assert.equal(visualGate({ cfg, files: [P], specs: false, sources: { [P]: HANDS_GOOD } }).rows[0].kind, "design_spec_missing");
    const g = visualGate({ cfg, files: [P], specs: true, sources: { [P]: HANDS_GOOD }, evidence: shots, rendered: true });
    assert.deepEqual([g.verdict, g.rows], ["PASS", []]);
  });
  it("rendered evidence is required: a missing viewport, a missing verdict or a non-PASS verdict fails", () => {
    const run = (evidence) => visualGate({ cfg, files: [P], specs: true, sources: { [P]: HANDS_GOOD }, evidence, rendered: true });
    assert.match(run({ "/hands": { screenshots: ["a-1440.png"], verdict: "PASS" } }).rows[0].detail, /390px/);
    assert.equal(run({}).rows.map((r) => r.kind).join(), "visual_screenshots_missing,visual_critique_missing");
    assert.match(run({ "/hands": { ...shots["/hands"], verdict: "BUDGET-EXHAUSTED" } }).rows[0].detail, /BUDGET-EXHAUSTED/);
    assert.equal(visualGate({ cfg: { ...cfg, requireVisual: false }, files: [P], specs: true, rendered: true }).verdict, "PASS");
  });
  it("advisory reports the same rows but never fails; lane precheck returns no rows", () => {
    const a = { ...cfg, gate: "advisory" };
    const g = visualGate({ cfg: a, files: [P], specs: false, sources: { [P]: HANDS_BAD } });
    assert.equal(g.verdict, "ADVISORY"); assert.ok(g.rows.length >= 2);
    assert.deepEqual(designFailures({ cfg: a, files: [P], readFile: () => HANDS_BAD }), []);
  });
  it("per-route specs: only the route without a spec is flagged", () => {
    const Q = "web/src/app/(site)/pricing/page.tsx";
    const g = visualGate({ cfg, files: [P, Q], specs: { "/hands": true } });
    assert.deepEqual(g.rows.map((r) => r.route), ["/pricing"]);
  });
  it("nothing user-visible in the bundle: PASS with no routes", () => {
    const g = visualGate({ cfg, files: ["services/api/x.py"] });
    assert.deepEqual([g.verdict, g.routes.length], ["PASS", 0]);
  });
  it("the comment lists each route with its screenshots and the verdict", () => {
    const g = visualGate({ cfg, files: [P], specs: true, sources: { [P]: HANDS_GOOD }, evidence: shots, rendered: true });
    const c = visualGateComment(g, shots);
    assert.match(c, /FORGE:VISUAL_GATE/); assert.match(c, /Visual gate: PASS/); assert.match(c, /hands-390\.png/);
  });
});

describe("copy-only edits to existing pages (#5648)", () => {
  const P = "web/src/app/(site)/docs/api/search/page.tsx", G = "web/src/app/(site)/docs/api/generated/search/page.tsx";
  const diff = `+++ b/${P}\n-Google\n+the web\n+++ b/${G}\n-Google\n+the web\n`;
  it("visualGate: a copy change needs no spec, generated is exempt, unknown still needs a spec", () => {
    assert.deepEqual(visualGate({ cfg, files: [P, G], specs: false, changes: { [P]: "copy", [G]: "generated" } }).rows, []);
    assert.ok(visualGate({ cfg, files: [P], specs: false, changes: { [P]: "rewrite" } }).rows.some((r) => r.kind === "design_spec_missing"));
    assert.ok(visualGate({ cfg, files: [P], specs: false }).rows.some((r) => r.kind === "design_spec_missing"));
  });
  it("designFailures: modified copy passes without a spec; new or unknown fails closed", () => {
    const a = { ...cfg, gate: "blocking" }, rd = () => Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
    assert.deepEqual(designFailures({ cfg: a, files: [P, G], added: [], diff, readFile: rd }), []);
    assert.ok(designFailures({ cfg: a, files: [P], added: [P], diff, readFile: rd }).some((r) => r.kind === "design_spec_missing"));
    assert.ok(designFailures({ cfg: a, files: [P], readFile: rd }).some((r) => r.kind === "design_spec_missing"));
  });
  it("designGate: a page already on the base is not routed to /design; a generated page is exempt", () => {
    assert.equal(designGate({ files: [P], cfg, baseFiles: [P] }).route, false);
    assert.equal(designGate({ files: [G], cfg }).route, false);
    assert.equal(designGate({ files: [P], cfg }).route, true);
  });
});
