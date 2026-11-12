// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// scripts/visual-gate.mjs (#5369): the review-pr-staging visual gate, run as the command spec runs it.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/visual-gate.mjs");
const CONF = "design:\n  gate: blocking\n  routes: [\"web/app/**/page.tsx\"]\n  viewports: [390, 1440]\n  require_visual_check: true\n";
const BAD = '<main><h1>Hands</h1><p>Delegate.</p><div className="rounded border p-4"></div><div className="rounded border p-4"></div><a href="/s">Get access</a></main>';
const GOOD = '<main><Hero title="Hands"/><Card title="Needs" body="A task."/><Button>Get access</Button></main>';
const run = (args, input) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", input }); return { rc: r.status, out: r.stdout, err: r.stderr }; };
let root;
const put = (rel, text) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };

before(() => {
  root = tmpDir("vgate-");
  put("forge.yaml", CONF); put("web/app/hands/page.tsx", BAD); put("web/app/pricing/page.tsx", GOOD);
  put("ev-ok.json", JSON.stringify({ "/pricing": { screenshots: ["p-390.png", "p-1440.png"], verdict: "PASS" } }));
  put("ev-bad.json", JSON.stringify({ "/hands": { screenshots: ["h-390.png", "h-1440.png"], verdict: "PASS" } }));
  put("off.yaml", "design:\n  system: [docs/ds.md]\n");
});
const base = () => ["--root", root, "--files-file", "-"];

describe("scripts/visual-gate.mjs (#5369)", () => {
  it("--list names every changed user-visible route with the viewports to render", () => {
    const r = run([...base(), "--list"], "web/app/hands/page.tsx\nweb/app/pricing/page.tsx\nservices/api/x.py\n");
    const j = JSON.parse(r.out);
    assert.equal(r.rc, 0); assert.deepEqual(j.routes.map((x) => x.route), ["/hands", "/pricing"]); assert.deepEqual(j.viewports, [390, 1440]);
  });
  it("regression fixture: the bundle adding the plain-text hero page with empty boxes fails (exit 1, GATE_FAILURE)", () => {
    const r = run([...base(), "--spec", "yes", "--evidence", join(root, "ev-bad.json")], "web/app/hands/page.tsx\n");
    const j = JSON.parse(r.out);
    assert.equal(r.rc, 1); assert.equal(j.verdict, "FAIL");
    assert.ok(j.rows.some((x) => /empty_box/.test(x.detail)) && j.rows.some((x) => /plain_text_hero/.test(x.detail)));
  });
  it("a missing spec fails with design.gate: blocking", () => {
    const r = run([...base(), "--evidence", join(root, "ev-ok.json")], "web/app/pricing/page.tsx\n");
    assert.equal(r.rc, 1); assert.equal(JSON.parse(r.out).rows[0].kind, "design_spec_missing");
  });
  it("a good page with spec, both screenshots and a PASS verdict passes; --comment prints the FORGE:VISUAL_GATE marker", () => {
    const a = [...base(), "--spec", "yes", "--evidence", join(root, "ev-ok.json")];
    assert.equal(run(a, "web/app/pricing/page.tsx\n").rc, 0);
    const c = run([...a, "--comment"], "web/app/pricing/page.tsx\n");
    assert.match(c.out, /<!-- FORGE:VISUAL_GATE -->/); assert.match(c.out, /Visual gate: PASS/); assert.match(c.out, /p-390\.png/);
  });
  it("no evidence for a route fails when require_visual_check is on", () => {
    const r = run([...base(), "--spec", "yes"], "web/app/pricing/page.tsx\n");
    assert.equal(r.rc, 1); assert.deepEqual(JSON.parse(r.out).rows.map((x) => x.kind), ["visual_screenshots_missing", "visual_critique_missing"]);
  });
  it("opt-in: without design.routes the gate is SKIP and exits 0", () => {
    const r = run(["--root", root, "--config", join(root, "off.yaml"), "--files-file", "-"], "web/app/hands/page.tsx\n");
    assert.equal(r.rc, 0); assert.equal(JSON.parse(r.out).verdict, "SKIP");
  });
  it("usage errors exit 2 (unknown flag, no file source)", () => {
    assert.equal(run(["--root", root, "--bogus"]).rc, 2);
    assert.equal(run(["--root", root]).rc, 2);
  });
});
