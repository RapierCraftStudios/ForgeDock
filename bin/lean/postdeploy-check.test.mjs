// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChecks, itemCheckIds, measureFollowup, CHECK_ID_RE } from "./postdeploy-check.mjs";
import { postDeployOnly } from "./prefilter.mjs";
import { validateContract, applyAmendments, precheck, followupItems } from "./conformance.mjs";
import { PROBE_MARKER } from "./probe.mjs";

const item = (id, why) => `- [ ] \`${id}: some quote here\` — post-deploy: ${why}`;
const body = (items) => `## Acceptance Criteria\n\n${items.join("\n")}\n\n<!-- FORGE:DEFERRED_FROM: #40 -->\n`;
const CHECKS = JSON.stringify({ smoke: { run: "echo ok", timeout: 5 }, bad: "echo nope", "bad id!": "x", rx: { run: "echo up", pass: "/up/" }, norun: {} });

function world({ file = CHECKS, spawn } = {}) {
  const w = { gh: [], git: [], spawned: [] };
  w.io = {
    gh: async (a) => { w.gh.push(a); return ""; },
    git: async (a) => { w.git.push(a); if (a[0] === "show") { if (file == null) throw new Error("missing"); return file; } return "deadbeef\n"; },
  };
  w.spawn = async (o) => { w.spawned.push(o.run); return spawn ? spawn(o) : { code: o.run === "echo nope" ? 1 : 0, stdout: o.run === "echo nope" ? "boom" : "ok", stderr: "" }; };
  return w;
}
const run = (w, bodyText, extra = {}) => measureFollowup({ iss: { number: 41, body: bodyText, comments: [] }, repo: "o/r", parent: 40, def: "main", shas: ["abc"], cwd: "/repo", io: w.io, config: { env: [], timeoutS: 5 }, env: {}, spawn: w.spawn, ...extra });

describe("post-deploy named checks (#4626)", () => {
  it("parses the checks file; malformed entries are dropped", () => {
    const c = parseChecks(CHECKS);
    assert.deepEqual(Object.keys(c).sort(), ["bad", "rx", "smoke"]);
    assert.equal(c.smoke.timeoutS, 5); assert.equal(c.rx.pass.kind, "regex");
    assert.deepEqual(parseChecks("not json"), {});
    assert.ok(CHECK_ID_RE.test("login-smoke") && !CHECK_ID_RE.test("Bad Id"));
  });

  it("postDeployOnly still matches items with and without a [check:id] token", () => {
    assert.ok(postDeployOnly(body([item("R1", "[check:smoke] soak"), item("R2", "only in prod")])));
  });
  it("extracts [check:id] per item; an item without one yields null", () => {
    assert.deepEqual(itemCheckIds(body([item("R1", "[check:smoke] soak"), item("R2", "only in prod")])), ["smoke", null]);
  });

  it("pass: runs the default-branch command, records FORGE:PROBE, closes the follow-up, no reopen", async () => {
    const w = world();
    const r = await run(w, body([item("R1", "[check:smoke] x")]));
    assert.equal(r.state, "pass");
    assert.deepEqual(w.spawned, ["echo ok"]);
    assert.ok(w.git.some((a) => a.join(" ") === "show origin/main:.forge/post-deploy-checks.json"));
    const cm = w.gh.find((a) => a[1] === "comment");
    assert.match(cm[cm.indexOf("--body") + 1], new RegExp(PROBE_MARKER));
    assert.ok(w.gh.some((a) => a[1] === "close" && a[2] === "41"));
    assert.ok(!w.gh.some((a) => a[1] === "reopen"));
  });

  it("fail: reopens the parent with the output and does not close", async () => {
    const w = world();
    const r = await run(w, body([item("R1", "[check:bad] x")]));
    assert.equal(r.state, "fail");
    assert.ok(w.gh.some((a) => a[1] === "reopen" && a[2] === "40"));
    assert.ok(w.gh.some((a) => a[1] === "comment" && a[2] === "40" && a[a.indexOf("--body") + 1].includes("boom")));
    assert.ok(!w.gh.some((a) => a[1] === "close"));
  });

  it("no runnable check: awaiting-measurement, nothing runs, no model call", async () => {
    for (const [file, b] of [[CHECKS, body([item("R1", "[check:ghost] x")])], [null, body([item("R1", "[check:smoke] x")])], [CHECKS, body([item("R1", "x"), item("R2", "[check:smoke] y")])]]) {
      const w = world({ file });
      assert.equal((await run(w, b)).state, "awaiting-measurement");
      assert.deepEqual(w.spawned, []); assert.deepEqual(w.gh, []);
    }
  });

  it("a command declared in the issue body never runs", async () => {
    const w = world();
    const b = body([item("R1", "[check:ghost] x")]) + "\n```forge-probe\nrun: rm -rf /\n```\n";
    assert.equal((await run(w, b)).state, "awaiting-measurement");
    assert.deepEqual(w.spawned, []);
  });

  it("migration: the six open follow-up shapes (no check id) all park awaiting-measurement", async () => {
    for (const n of [4415, 4421, 4438, 4488, 4495, 4498]) {
      const w = world();
      const r = await run(w, body([item(`R${n % 7}`, "only checkable after the next deploy")]));
      assert.equal(r.state, "awaiting-measurement", `#${n}`);
      assert.deepEqual(w.spawned, []);
    }
  });

  it("a recorded fail for the same fix is not re-run", async () => {
    const w = world();
    const c = { body: `<!-- ${PROBE_MARKER} -->\n${JSON.stringify({ fix: "abc", result: "fail" })}` };
    const r = await run(w, body([item("R1", "[check:smoke] x")]), { iss: { number: 41, body: body([item("R1", "[check:smoke] x")]), comments: [c] }, isTrusted: () => true });
    assert.equal(r.state, "recorded-fail"); assert.deepEqual(w.spawned, []);
  });

  it("contract: post-deploy needs a check id; amendment too; precheck rejects an unknown id; followup item names it", () => {
    const Q = "The deploy-time health row must exist after promotion.";
    const c = { requirements: [{ id: "R1", quote: Q, disposition: "post-deploy", why: "w" }], deliverables: [], preserve: [], validate: [{ id: "V1", command: "true" }] };
    assert.ok(validateContract(c, Q).problems.some((p) => /needs a check id/.test(p)));
    assert.ok(!validateContract({ ...c, requirements: [{ ...c.requirements[0], check: "smoke" }] }, Q).problems.some((p) => /check id/.test(p)));
    const frozen = { ...c, requirements: [{ id: "R1", quote: Q, disposition: "deliver" }] };
    assert.ok(applyAmendments(frozen, [{ kind: "post-deploy", requirement: "R1", why: "w" }], Q).problems.some((p) => /check id/.test(p)));
    const ok = applyAmendments(frozen, [{ kind: "post-deploy", requirement: "R1", why: "w", check: "smoke" }], Q);
    assert.equal(ok.contract.requirements[0].check, "smoke");
    const pc = precheck({ contract: { ...c, requirements: [{ ...c.requirements[0], check: "ghost" }] }, result: { requirements: [] }, changedFiles: [], checkIds: new Set(["smoke"]) });
    assert.ok(pc.failures.some((f) => f.kind === "check_unknown"));
    assert.match(followupItems([{ ...c.requirements[0], check: "smoke" }])[0].why, /^post-deploy: \[check:smoke\] w/);
  });
});
