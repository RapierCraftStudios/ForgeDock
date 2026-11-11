// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDocsConfig, userFacingSurfaces, docsLinks, docsFailures, milestoneDocsGate, docsFromCli } from "./docsgate.mjs";
import { docsPlanNote, domainChecksBlock } from "./prompts.mjs";
import { pathDomains } from "./review-trigger.mjs";

const cfg = parseDocsConfig({ required_for: "[api, dashboard]", paths: ["web/docs/**"], registries: ["web/public/llms.txt"] });
// The shape of the AlterLab Hands dashboard PR (#40276): a dashboard page linking a docs page that does not exist.
const handsFiles = ["web/app/dashboard/hands/page.tsx", "web/app/dashboard/hands/HandsDashPage.tsx"];
const handsDiff = "+++ b/web/app/dashboard/hands/page.tsx\n+<HandsDashPage docsHref=\"/docs/hands\" />\n+<a href=\"/docs/hands/credentials\">How it works</a>\n+<a href=\"/pricing\">x</a>\n";

describe("docs gate (#5419)", () => {
  it("is off without required_for (library/CLI repos)", async () => {
    assert.equal(parseDocsConfig(undefined), null);
    assert.equal(parseDocsConfig({ paths: ["docs/**"] }), null);
    assert.equal(parseDocsConfig({ required_for: "bogus" }), null);
    assert.deepEqual(await docsFailures({ cfg: null, files: handsFiles, diff: handsDiff }), []);
    assert.equal(docsPlanNote(null), "");
  });
  it("detects configured surfaces only, ignoring tests", () => {
    assert.deepEqual(Object.keys(userFacingSurfaces(["web/app/api/x/route.ts", "web/app/dashboard/p/page.tsx", "web/app/api/x/route.test.ts"], cfg)).sort(), ["api", "dashboard"]);
    assert.deepEqual(userFacingSurfaces(["src/cli.ts"], parseDocsConfig({ required_for: ["cli"], surfaces: { cli: ["src/cli.ts"] } })), { cli: ["src/cli.ts"] });
    assert.deepEqual(userFacingSurfaces(["web/app/api/x/route.ts"], parseDocsConfig({ required_for: ["cli"] })), {});
  });
  it("extracts only added internal docs links", () => {
    assert.deepEqual(docsLinks(handsDiff), ["/docs/hands", "/docs/hands/credentials"]);
    assert.deepEqual(docsLinks("-<a href=\"/docs/old\">\n+<a href=\"https://x.io/docs/a\">"), []);
  });
  it("replay: the Hands dashboard diff fails docs_missing and the link gate, and its plan carries R-docs", async () => {
    const f = await docsFailures({ cfg, files: handsFiles, diff: handsDiff, tracked: ["web/docs/api/index.mdx"] });
    assert.deepEqual(f.map((x) => x.kind).sort(), ["docs_link_broken", "docs_missing"]);
    assert.match(docsPlanNote(cfg), /R-docs/);
    assert.match(docsPlanNote(cfg), /web\/docs\/\*\*/);
  });
  it("passes when the pages exist, or the repo link_check exits 0, or the change is justified", async () => {
    const files = [...handsFiles, "web/docs/hands/index.mdx", "web/docs/hands/credentials.mdx"];
    assert.deepEqual(await docsFailures({ cfg, files, diff: handsDiff, tracked: [] }), []);
    const c2 = parseDocsConfig({ required_for: ["dashboard"], paths: ["web/docs/**"], link_check: "bash chk.sh" });
    let ran; const run = async ({ command }) => { ran = command; return { rc: 0 }; };
    assert.deepEqual(await docsFailures({ cfg: c2, files: [...handsFiles, "web/docs/x.mdx"], diff: handsDiff, run }), []);
    assert.match(ran, /^bash chk\.sh '\/docs\/hands' '\/docs\/hands\/credentials'$/);
    const bad = await docsFailures({ cfg: c2, files: ["web/docs/x.mdx"], diff: handsDiff, run: async () => ({ rc: 1, output: "404 /docs/hands" }) });
    assert.equal(bad[0].kind, "docs_link_broken");
    const crashed = await docsFailures({ cfg: c2, files: [], diff: handsDiff, run: async () => { throw new Error("nope"); } });
    assert.match(crashed[0].detail, /exited 127/);
    assert.deepEqual(await docsFailures({ cfg, files: handsFiles, result: { docs: [{ surface: "dashboard", justification: "internal page" }] }, diff: "" }), []);
  });
  it("adds the docs domain and its reviewer check only for a configured surface", () => {
    assert.ok(pathDomains(handsFiles, { docs: cfg })?.includes("docs"));
    assert.ok(!pathDomains(handsFiles)?.includes("docs"));
    assert.match(domainChecksBlock(["docs"]), /docs that contradict the code/);
  });
  it("blocks milestone close until a docs child is merged", () => {
    const ui = { number: 1, state: "closed", labels: ["dashboard"] };
    assert.equal(milestoneDocsGate({ children: [ui], cfg: null }).ok, true);
    assert.equal(milestoneDocsGate({ children: [{ number: 2, state: "open", labels: ["chore"] }], cfg }).gated, false);
    assert.match(milestoneDocsGate({ children: [ui], cfg }).reasons[0], /no docs child/);
    assert.match(milestoneDocsGate({ children: [ui, { number: 3, state: "open", labels: ["docs"] }], cfg }).reasons[0], /not merged/);
    assert.equal(milestoneDocsGate({ children: [ui, { number: 3, state: "closed", labels: ["docs"] }], cfg }).ok, true);
  });
  it("docs gate CLI exits 1 on a blocked milestone and 0 when off", async () => {
    const out = [], print = (t) => out.push(t);
    assert.equal(await docsFromCli(["gate", "--milestone", "M", "--repo", "o/r"], { config: undefined, print }), 0);
    assert.equal(await docsFromCli(["gate", "--milestone", "M", "--repo", "o/r"], { config: cfg, print, io: { gh: async (a) => { if (String(a[1]).includes("issues?milestone")) return JSON.stringify([{ number: 1, state: "closed", labels: ["dashboard"] }]); return JSON.stringify([{ number: 7, title: "M" }]); } } }), 1);
  });
});
