// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../tests/_tmp.mjs";
import { computeTrigger, riskPathHits, parseRiskPaths, riskClassOf, triggerReport, readRunLogs, formatReport } from "./review-trigger.mjs";

const HOT = { enabled: true, file_lines: 2000, growth_lines: 150, files: [] };
const clean = (patch = {}) => computeTrigger({ files: ["src/foo.js", "test/foo.test.js"], hotspots: HOT, ...patch });
const codes = (t) => t.reasons.map((r) => r.code);

describe("riskPathHits (#4398)", () => {
  it("only declared review.risk_paths globs count, sorted and unique; built-in risk words never do", () => {
    assert.deepEqual(riskPathHits(["src/auth/login.ts", "src/billing/b.ts", "src/billing/a.ts", "src/billing/a.ts"], ["src/billing/**"]), ["src/billing/a.ts", "src/billing/b.ts"]);
    assert.deepEqual(riskPathHits(["src/auth/login.ts"], []), [], "no declared globs: nothing enforces");
    assert.deepEqual(riskPathHits(["db/x.sql", "lib/a.js"], "db/**, *.sql"), ["db/x.sql"]);
    assert.deepEqual(riskPathHits(undefined, ["**"]), []);
  });
});

describe("computeTrigger (#4273)", () => {
  it("a clean diff with passing gates would skip, with no reasons", () => {
    assert.deepEqual(clean(), { would_skip: true, reasons: [] });
  });
  it("risk_path: a built-in risk word in any path segment, camelCase included", () => {
    for (const f of ["src/auth/login.ts", "api/payments/charge.py", "lib/security/x.go", "app/userDelete.js", "db/migrations/001_init.sql", "src/AuthService.ts"]) {
      const t = clean({ files: [f] });
      assert.equal(t.would_skip, false, f);
      assert.deepEqual(codes(t), ["risk_path"], f);
    }
    assert.equal(riskClassOf("src/billing/x.ts"), "payments");
    assert.equal(riskClassOf("src/authorship.md"), null); // whole words only
  });
  it("risk_path: a configured review.risk_paths glob", () => {
    const t = clean({ files: ["infra/main.tf"], riskPaths: ["infra/**"] });
    assert.deepEqual(t.reasons, [{ code: "risk_path", detail: "infra/main.tf (review.risk_paths infra/**)" }]);
    assert.equal(clean({ files: ["infra/main.tf"], riskPaths: ["other/**"] }).would_skip, true);
  });
  it("package_edge: any added package edge, declared or not", () => {
    const t = clean({ structure: { package_edges_added: [{ from: "@a/web", to: "@a/db" }], import_pairs: [] } });
    assert.deepEqual(t.reasons, [{ code: "package_edge", detail: "@a/web → @a/db" }]);
    assert.equal(clean({ structure: { package_edges_added: [] } }).would_skip, true);
  });
  it("hotspot: a changed file over the threshold, unless excluded or not over", () => {
    const files = [{ path: "src/foo.js", lines: 2400, over: true, excluded: false }];
    assert.deepEqual(codes(clean({ hotspots: { ...HOT, files } })), ["hotspot"]);
    assert.equal(clean({ hotspots: { ...HOT, files: [{ ...files[0], excluded: true }] } }).would_skip, true);
    assert.equal(clean({ hotspots: { ...HOT, files: [{ ...files[0], over: false }] } }).would_skip, true);
    assert.equal(clean({ hotspots: { enabled: false, files: [] } }).would_skip, true); // disabled is an answer
  });
  it("gate.failed: precheck failures, declared check commands still failing, CI fallback", () => {
    assert.deepEqual(clean({ gates: { precheckFailures: [{ code: "conformance.scope" }] } }).reasons, [{ code: "gate.failed", detail: "precheck conformance.scope" }]);
    assert.deepEqual(codes(clean({ gates: { checkCommandsFailing: true } })), ["gate.failed"]);
    assert.deepEqual(codes(clean({ gates: { ciFellBack: true } })), ["gate.failed"]);
  });
  it("gate.ambiguous: hotspot facts unavailable, or a deferred/post-deploy requirement", () => {
    assert.deepEqual(codes(computeTrigger({ files: ["src/foo.js"], hotspots: null })), ["gate.ambiguous"]);
    assert.deepEqual(codes(computeTrigger({ files: ["src/foo.js"] })), ["gate.ambiguous"]);
    const contract = { requirements: [{ id: "R1", disposition: "deliver" }, { id: "R2", disposition: "post-deploy" }] };
    assert.deepEqual(clean({ contract }).reasons, [{ code: "gate.ambiguous", detail: "contract defers R2 (only the reviewer judges deferrals)" }]);
    assert.equal(clean({ contract: { requirements: [{ id: "R1", disposition: "deliver" }] } }).would_skip, true);
  });
  it("is deterministic: same facts in any order give the same sorted reasons", () => {
    const a = computeTrigger({ files: ["src/auth/a.ts", "db/migrations/1.sql"], hotspots: null, gates: { ciFellBack: true } });
    const b = computeTrigger({ files: ["db/migrations/1.sql", "src/auth/a.ts"], hotspots: null, gates: { ciFellBack: true } });
    assert.deepEqual(a, b);
    assert.deepEqual(codes(a), ["gate.ambiguous", "gate.failed", "risk_path", "risk_path"]);
  });
  it("#4404 an out-of-band requirement forces the reviewer (only it judges instrumentation)", () => {
    const t = clean({ contract: { requirements: [{ id: "R2", disposition: "deliver", verify: "out_of_band" }, { id: "R1", disposition: "deliver" }] } });
    assert.equal(t.would_skip, false);
    assert.deepEqual(t.reasons, [{ code: "gate.ambiguous", detail: "contract verifies R2 out of band (only the reviewer judges instrumentation)" }]);
    assert.equal(clean({ contract: { requirements: [{ id: "R1", disposition: "deliver", verify: "in_lane" }] } }).would_skip, true);
  });

  it("parseRiskPaths takes a comma string or a list", () => {
    assert.deepEqual(parseRiskPaths(" a/** , ,*.sql"), ["a/**", "*.sql"]);
    assert.deepEqual(parseRiskPaths(["x", " ", "y "]), ["x", "y"]);
    assert.deepEqual(parseRiskPaths(undefined), []);
  });
});

const start = (repo) => ({ event: "RUN_START", repo });
const trig = (would_skip, skipped = false) => ({ event: "REVIEW_TRIGGER", mode: skipped ? "enforce" : "shadow", would_skip, reasons: would_skip ? [] : ["risk_path"], skipped });
const conf = (state) => ({ event: "CONFORMANCE", round: 1, state });

describe("triggerReport (#4273)", () => {
  it("per repo: runs, would-skip, would-skip the reviewer flagged nonconforming, enforce skips", () => {
    const logs = [
      [start("o/a"), trig(true), conf("nonconforming"), conf("conforms")],
      [start("o/a"), trig(true), conf("conforms")],
      [start("o/a"), trig(false), conf("nonconforming")],
      [start("o/b"), trig(true, true)],
      // only the last RUN_START slice counts: the earlier flagged run is superseded
      [start("o/b"), trig(true), conf("nonconforming"), start("o/b"), trig(true), conf("conforms")],
      [start("o/b"), conf("conforms")], // trigger off: not counted
      [trig(true)], // no RUN_START
    ];
    assert.deepEqual(triggerReport(logs), {
      "o/a": { runs: 3, would_skip: 2, would_skip_flagged: 1, skipped: 0 },
      "o/b": { runs: 2, would_skip: 2, would_skip_flagged: 0, skipped: 1 },
    });
  });
  it("reads *.jsonl run logs, skipping corrupt lines; a missing dir is an empty report", () => {
    const dir = tmpDir("rtrig-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "7.jsonl"), [start("o/a"), trig(true), conf("nonconforming")].map((e) => JSON.stringify(e)).join("\n") + "\n{broken\n");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    assert.deepEqual(triggerReport(readRunLogs(dir)), { "o/a": { runs: 1, would_skip: 1, would_skip_flagged: 1, skipped: 0 } });
    assert.deepEqual(readRunLogs(join(dir, "missing")), []);
    assert.match(formatReport(triggerReport(readRunLogs(dir))), /\| o\/a \| 1 \| 1 \| 1 \| 0 \|/);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./review-trigger.mjs", import.meta.url)), "--dir", dir, "--json"], { encoding: "utf8" });
    assert.equal(cli.status, 0);
    assert.deepEqual(JSON.parse(cli.stdout)["o/a"].would_skip_flagged, 1);
  });
});
