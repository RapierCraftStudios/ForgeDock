// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChecks, itemCheckIds, measureFollowup, monitorRecord, CHECK_ID_RE, tickItems } from "./postdeploy-check.mjs";
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
      assert.deepEqual(w.spawned, []); assert.ok(w.gh.every((a) => a[1] === "comment" && /FORGE:OWNER_ASK/.test(a[a.indexOf("--body") + 1])), "only the typed owner ask (#4689)");
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

describe("windowed post-deploy checks (#4627)", () => {
  const WIN = JSON.stringify({ soak: { run: "echo ok", for: "7d", every: "6h" }, soakd: { run: "echo ok", for: "2d" }, noFor: { run: "echo ok", every: "6h" }, badFor: { run: "echo ok", for: "soon" }, zero: { run: "echo ok", for: "0" }, plain: "echo ok" });
  const NOW = Date.parse("2026-10-26T00:00:00Z");
  it("parses for/every; every defaults to 6h; every without for or a bad duration drops the entry", () => {
    const c = parseChecks(WIN);
    assert.deepEqual(Object.keys(c).sort(), ["plain", "soak", "soakd"]);
    assert.equal(c.soak.forMs, 7 * 86400e3); assert.equal(c.soak.everyMs, 6 * 3600e3);
    assert.equal(c.soakd.everyMs, 6 * 3600e3);
    assert.equal(c.plain.forMs, undefined);
  });
  it("first pass records the release and window, labels, and keeps the follow-up open", async () => {
    const w = world({ file: WIN });
    const r = await run(w, body([item("R1", "[check:soak] x")]), { now: () => NOW });
    assert.equal(r.state, "monitoring");
    assert.ok(!w.gh.some((a) => a[1] === "close") && !w.gh.some((a) => a[1] === "reopen"));
    assert.ok(w.gh.some((a) => a[1] === "edit" && a.includes("post-deploy-monitoring")));
    const cm = w.gh.find((a) => a[1] === "comment");
    const rec = monitorRecord(cm[cm.indexOf("--body") + 1]);
    assert.equal(rec.result, "pass"); assert.equal(rec.until, NOW + 7 * 86400e3); assert.equal(rec.everyMs, 6 * 3600e3); assert.equal(rec.defaultSha, "deadbeef");
  });
  it("a recorded windowed pass is not re-measured by the pre-filter path", async () => {
    const w = world({ file: WIN });
    const rec = { body: `<!-- ${PROBE_MARKER} -->\n${JSON.stringify({ fix: "abc", result: "pass", at: new Date(NOW).toISOString(), window_until: new Date(NOW + 1e9).toISOString() })}` };
    const b = body([item("R1", "[check:soak] x")]);
    const r = await run(w, b, { iss: { number: 41, body: b, comments: [rec] }, isTrusted: () => true });
    assert.equal(r.state, "monitoring"); assert.deepEqual(w.spawned, []);
  });
  it("a non-windowed check still closes on pass (part 1 unchanged)", async () => {
    const w = world({ file: WIN });
    assert.equal((await run(w, body([item("R1", "[check:plain] x")]))).state, "pass");
    assert.ok(w.gh.some((a) => a[1] === "close"));
  });
  it("a first-run fail of a windowed check reopens the parent as before", async () => {
    const w = world({ file: JSON.stringify({ soak: { run: "echo nope", for: "7d" } }), spawn: () => ({ code: 1, stdout: "boom", stderr: "" }) });
    assert.equal((await run(w, body([item("R1", "[check:soak] x")]))).state, "fail");
    assert.ok(w.gh.some((a) => a[1] === "reopen" && a[2] === "40"));
  });
});


describe("verification outcome (#4689)", () => {
  it("a pass ticks the post-deploy items with the evidence in the PROBE record, and writes no code", async () => {
    const w = world();
    const r = await run(w, body([item("R1", "[check:smoke] x")]));
    assert.equal(r.state, "pass");
    const edit = w.gh.find((a) => a[0] === "issue" && a[1] === "edit");
    const text = edit[edit.indexOf("--body") + 1];
    assert.match(text, /- \[x\] `R1: some quote here`/);
    assert.equal(tickItems("- [ ] `R9: other` — defer: code"), "- [ ] `R9: other` — defer: code");
    const probe = w.gh.find((a) => a[1] === "comment" && /FORGE:PROBE/.test(a[a.indexOf("--body") + 1]));
    assert.match(probe[probe.indexOf("--body") + 1], /"id":"smoke","result":"pass"/);
    assert.ok(w.git.every((a) => ["show", "rev-parse"].includes(a[0])), "no git write: " + JSON.stringify(w.git));
    assert.equal(tickItems("no items"), "no items");
  });

  it("a fail files one engineering issue per failing check and ticks nothing", async () => {
    const w = world({ file: JSON.stringify({ bad: "echo nope", worse: "echo nope", smoke: "echo ok" }) });
    const r = await run(w, body([item("R1", "[check:bad] x"), item("R2", "[check:worse] x"), item("R3", "[check:smoke] x")]));
    assert.equal(r.state, "fail");
    const created = w.gh.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(created.length, 2);
    assert.ok(created.every((a) => a.includes("followup:engineering")));
    assert.ok(created[0][created[0].indexOf("--title") + 1].includes("bad"));
    assert.ok(!w.gh.some((a) => a[1] === "edit" && a.includes("--body")));
  });

  it("an item with no runnable check posts one typed owner ask, once", async () => {
    const w = world({ file: null });
    assert.equal((await run(w, body([item("R1", "[check:smoke] x")]))).state, "awaiting-measurement");
    const asks = w.gh.filter((a) => a[1] === "comment" && /FORGE:OWNER_ASK/.test(a[a.indexOf("--body") + 1]));
    assert.equal(asks.length, 1);
    const seen = { number: 41, body: body([item("R1", "[check:smoke] x")]), comments: [{ body: "<!-- FORGE:OWNER_ASK -->\nask", author: { login: "rapiercraft-forgedock" }, authorAssociation: "CONTRIBUTOR" }] };
    const w2 = world({ file: null });
    await run(w2, seen.body, { iss: seen, isTrusted: () => true });
    assert.equal(w2.gh.filter((a) => a[1] === "comment").length, 0);
  });
});
