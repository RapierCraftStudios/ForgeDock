// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeIssues, findDeadLinks, nextStep, parseFirstRunMarker, markerLine, runFirstRun, MAX_PROPOSALS } from "../first-run.mjs";
import { maybeOfferFirstRun } from "../journey.mjs";

const repoDir = (files) => {
  const d = mkdtempSync(join(tmpdir(), "fr-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
  return d;
};

describe("first-run (#5290)", () => {
  it("finds dead relative links only", () => {
    const d = repoDir({ "README.md": "[a](docs/x.md) [b](https://e.com) [c](#top) [d](LICENSE)", LICENSE: "x" });
    assert.deepEqual(findDeadLinks(d), [{ file: "README.md", target: "docs/x.md" }]);
  });
  it("proposes at most 3 deterministic candidates", () => {
    const d = repoDir({ "README.md": "[a](nope.md)", "package.json": JSON.stringify({ scripts: { lint: "x" } }) });
    const p = proposeIssues(d);
    assert.ok(p.length <= MAX_PROPOSALS);
    assert.deepEqual(p.map((x) => x.kind), ["dead-link", "doc-gap", "lint-debt"]);
    assert.equal(proposeIssues(repoDir({ "CONTRIBUTING.md": "x" })).length, 0);
  });
  it("round-trips the start marker", () => {
    assert.equal(parseFirstRunMarker(`body\n${markerLine(Date.UTC(2026, 10, 1))}`).started, "2026-11-01T00:00:00.000Z");
    assert.equal(parseFirstRunMarker("none"), null);
  });
  it("maps failures to a plain next step", () => {
    assert.match(nextStep("gh auth: not logged in"), /gh auth login/);
    assert.match(nextStep("GH006 protected branch"), /protected/);
    assert.match(nextStep("no CI"), /CI/);
    assert.match(nextStep("fatal: not a git repository"), /remote/);
    assert.ok(nextStep(new Error("???")).length > 10);
  });
  const calls = [];
  const mkExec = (over = {}) => (cmd, args) => {
    calls.push(args.join(" "));
    if (over[args[0] + args[1]]) throw new Error(over[args[0] + args[1]]);
    if (args[0] === "repo") return "o/r";
    if (args[0] === "issue") return `https://github.com/o/r/issues/${40 + calls.filter((c) => c.startsWith("issue")).length}`;
    return "";
  };
  it("files nothing without approval", async () => {
    calls.length = 0;
    const out = []; const d = repoDir({ "README.md": "[a](nope.md)" });
    const r = await runFirstRun({ cwd: d, exec: mkExec(), confirmFn: async () => false, write: (t) => out.push(t), runIssueFn: async () => { throw new Error("no"); } });
    assert.equal(r.status, "declined");
    assert.equal(calls.some((c) => c.startsWith("issue")), false);
  });
  it("files with the marker on approval and runs the first issue", async () => {
    calls.length = 0;
    const d = repoDir({ "README.md": "[a](nope.md)" }); const ran = [];
    const r = await runFirstRun({ cwd: d, exec: mkExec(), confirmFn: async () => true, write: () => {}, runIssueFn: async (n) => ran.push(n), startedMs: Date.UTC(2026, 10, 1) });
    assert.equal(r.status, "done");
    assert.deepEqual(ran, [r.issues[0].number]);
    assert.ok(calls.some((c) => c.includes("FORGE:FIRST_RUN") && c.includes("2026-11-01")));
  });
  it("ends an auth failure with a next step", async () => {
    const out = [];
    const r = await runFirstRun({ cwd: repoDir({}), exec: mkExec({ authstatus: "not logged in" }), confirmFn: async () => true, write: (t) => out.push(t), runIssueFn: async () => {} });
    assert.equal(r.status, "error");
    assert.match(out.join(""), /Next step: .*gh auth login/);
  });
  it("journey offer is skipped without a TTY", async () => {
    const r = await maybeOfferFirstRun({ isTTY: false, argv: [], confirmFn: async () => { throw new Error("asked"); } });
    assert.equal(r.offered, false);
  });
});
