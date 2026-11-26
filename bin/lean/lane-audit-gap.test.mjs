// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeGapAuditor, parseGapConfig, redact, auditGap } from "./lane-audit-gap.mjs";
import { runLaneAudit } from "./lane-audit.mjs";

const ON = parseGapConfig({ orchestrate: { lane_audit: { file_gaps: "true" } } });
const C = { signature: "gh-network-text", class: "env", owner: "engine", action: "retry", fixed_in_later: false, active: true };
const fakeGh = () => { const issues = [], calls = []; return { issues, calls, gh: async (a) => { calls.push(a);
  if (a[1] === "list") return JSON.stringify(issues.map((i) => ({ number: i.number, body: i.body })));
  if (a[1] === "create") { const i = { number: 90 + issues.length, body: a[a.indexOf("--body") + 1] }; issues.push(i); return `https://github.com/x/y/issues/${i.number}\n`; }
  if (a[1] === "edit") { issues.find((i) => String(i.number) === a[2]).body = a[a.indexOf("--body") + 1]; return ""; }
  return ""; } }; };
const run = (g, issue, c = C, cfg = ON, repo = "acme/secret-app") => makeGapAuditor({ gh: g.gh, cfg, repo })({ issue, stamp: { engine_version: "1.2.0" } }, c);

describe("#6078 gap audit", () => {
  it("is off by default and only the string true enables", async () => {
    assert.equal(parseGapConfig({}).fileGaps, false);
    assert.equal(parseGapConfig({ orchestrate: { lane_audit: { file_gaps: "yes" } } }).fileGaps, false);
    const g = fakeGh();
    assert.equal(await run(g, 1, C, parseGapConfig({})), null);
    assert.equal(g.calls.length, 0);
    assert.equal(await auditGap({}, C), null);
  });
  it("creates one issue, then updates it for a second lane without a second create", async () => {
    const g = fakeGh();
    assert.deepEqual(await run(g, 11), { issue: 90, count: 1, action: "create" });
    assert.deepEqual(await run(g, 12), { issue: 90, count: 2, action: "update" });
    assert.equal(g.calls.filter((a) => a[1] === "create").length, 1);
    assert.match(g.issues[0].body, /Occurrences: 2/); assert.match(g.issues[0].body, /#11, #12/);
    assert.match(g.issues[0].body, /<!-- forge-gap: gh-network-text -->/);
  });
  it("does not double count the same lane", async () => {
    const g = fakeGh(); await run(g, 11);
    assert.deepEqual(await run(g, 11), { issue: 90, count: 1, action: "unchanged" });
    assert.equal(g.calls.filter((a) => a[1] === "edit").length, 0);
  });
  it("files nothing for fixed_in_later, inactive or genuine classes", async () => {
    const g = fakeGh();
    for (const c of [{ ...C, fixed_in_later: true }, { ...C, active: false }, { ...C, class: "genuine" }, { ...C, class: "spec" }, null]) assert.equal(await run(g, 1, c), null);
    assert.equal(g.calls.length, 0);
  });
  it("redacts repo names and paths from the body", async () => {
    const g = fakeGh();
    await run(g, 5, { ...C, action: "see acme/secret-app at /home/bob/work/secret-app/x.mjs" });
    assert.doesNotMatch(g.issues[0].body, /acme|secret-app|\/home/);
    assert.equal(redact("acme/secret-app /tmp/x/y", { repo: "acme/secret-app" }), "<repo> <path>");
    assert.equal(redact("version 1.2.0 ok", { repo: "a/b" }), "version 1.2.0 ok");
  });
  it("returns null without throwing when gh fails", async () => {
    assert.equal(await run({ gh: async () => { throw new Error("boom"); } }, 1), null);
  });
  it("runLaneAudit stores the gap in the audit", async () => {
    const g = fakeGh(), posts = [];
    const r = await runLaneAudit({ issue: 7, reason: "needs-human", code: "x", detail: "gh: error connecting to api.github.com", comments: [], post: async (m, b) => { posts.push(b); }, gap: makeGapAuditor({ gh: g.gh, cfg: ON, repo: "o/r" }), stamp: { engine_version: "0.0.1", attempt: 1 } });
    assert.equal(r.posted, true); assert.equal(r.audit.gap?.action, "create");
  });
});
