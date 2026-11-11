// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { affectedFilesOf, parseTriage, fastForwardEligibility, skippedStages, skippedLine, investigationOnlyPrompt, contractStepPrompt, fastForwardSource, TRIAGE_FILE } from "./fastforward.mjs";
import { parseLightConfig } from "./light.mjs";

const CFG = { mode: "on", maxLines: 40, maxFiles: 2 };
const MD = "### Affected Files\n- `bin/lean/light.mjs`: eligibility\n- bin/lean/light.test.mjs\n- docs/CONFIG.md (see section 3)\n\n### Sibling Sweep\n- other/file.mjs\n";
const triage = (o = {}) => ({ files: ["src/a.mjs"], size: "S", risk: false, decisionNeeded: false, ...o });
const codes = (e) => e.reasons.map((r) => r.code);

describe("triage parsing (#5426)", () => {
  it("reads paths from the Affected Files section only, first token per bullet", () => {
    assert.deepEqual(affectedFilesOf(MD), ["bin/lean/light.mjs", "bin/lean/light.test.mjs", "docs/CONFIG.md"]);
    assert.deepEqual(affectedFilesOf("no section"), []);
  });
  it("prefers triage.json, falls back to Affected Files on junk, and treats a bad size as unknown", () => {
    assert.deepEqual(parseTriage('{"files":["./a.js","a.js","b.js"],"size":"s","risk":true,"decision_needed":true}', MD), { files: ["a.js", "b.js"], size: "S", risk: true, decisionNeeded: true, source: "triage" });
    const f = parseTriage("not json", MD);
    assert.equal(f.source, "affected_files"); assert.equal(f.size, null); assert.equal(f.files.length, 3);
    assert.equal(parseTriage('{"files":[],"size":"XL"}', "").size, null);
  });
  it("lean.light.source: investigation by default, text is the kill-switch", () => {
    assert.equal(fastForwardSource(parseLightConfig({})), "investigation");
    assert.equal(fastForwardSource(parseLightConfig({ source: "Text" })), "text");
    assert.equal(fastForwardSource(parseLightConfig({ light_source: "bogus" })), "investigation");
    assert.equal("source" in parseLightConfig({}), false);
  });
});

describe("eligibility from the investigation (#5426)", () => {
  it("an issue naming no file and no size label qualifies when the investigation predicts one small file", () => {
    const e = fastForwardEligibility({ title: "bug: x", body: "It breaks.", triage: triage(), cfg: CFG });
    assert.equal(e.verdict, "eligible"); assert.equal(e.light, true);
    assert.ok(e.signals.some((s) => s.code === "source_investigation"));
    assert.ok(e.signals.some((s) => s.code === "pre_text_ambiguous"), "the text heuristic is only a shadow signal");
  });
  it("the text heuristic never decides: text-eligible but the investigation predicts 3 files is ineligible", () => {
    const body = "```\nrepro\n```\nbin/a.mjs";
    const e = fastForwardEligibility({ body, textFiles: ["bin/a.mjs"], triage: triage({ files: ["a.mjs", "b.mjs", "c.mjs"] }), cfg: CFG });
    assert.equal(e.verdict, "ineligible"); assert.ok(codes(e).includes("files"));
    assert.ok(e.signals.some((s) => s.code === "pre_text_eligible"));
  });
  it("risk path, hotspot, size M, flagged risk and decision are each hard reasons", () => {
    assert.ok(codes(fastForwardEligibility({ triage: triage({ files: ["src/auth/login.mjs"] }), cfg: CFG })).includes("risk_path"));
    assert.ok(codes(fastForwardEligibility({ triage: triage(), hotspots: [{ path: "src/a.mjs", lines: 3000, over: true }], cfg: CFG })).includes("hotspot"));
    assert.ok(codes(fastForwardEligibility({ triage: triage({ size: "M" }), cfg: CFG })).includes("size"));
    assert.ok(codes(fastForwardEligibility({ triage: triage({ risk: true }), cfg: CFG })).includes("risk"));
    assert.ok(codes(fastForwardEligibility({ triage: triage({ decisionNeeded: true }), cfg: CFG })).includes("decision"));
  });
  it("no predicted files is ambiguous, not eligible; shadow mode never runs light; off is off", () => {
    assert.equal(fastForwardEligibility({ triage: triage({ files: [] }), cfg: CFG }).verdict, "ambiguous");
    const s = fastForwardEligibility({ triage: triage(), cfg: { ...CFG, mode: "shadow" } });
    assert.equal(s.eligible, true); assert.equal(s.light, false);
    assert.equal(fastForwardEligibility({ triage: triage(), cfg: { ...CFG, mode: "off" } }).verdict, "off");
  });
});

describe("fast-forward prompts and trajectory (#5426)", () => {
  it("names the skipped stages and why", () => {
    const e = fastForwardEligibility({ triage: triage(), cfg: CFG });
    assert.deepEqual(skippedStages(e).map((x) => x.stage), ["plan", "contract freeze", "multi-session review"]);
    assert.match(skippedLine(e), /Fast-forward: skipped plan, contract freeze.*1 non-test file/);
  });
  it("investigation-only keeps the close and block rules but defers the contract; the contract step carries it", () => {
    const a = investigationOnlyPrompt(7), b = contractStepPrompt(7);
    assert.match(a, /Write \.forge-lean\/investigation\.md/); assert.ok(a.includes(TRIAGE_FILE)); assert.match(a, /"blocked" needs a typed/);
    assert.ok(!a.includes('{"requirements":['));
    assert.ok(b.includes('{"requirements":[') && b.includes('"blocked" needs a typed'));
    assert.ok(!/1\. Write \.forge-lean\/investigation\.md/.test(b));
  });
});
