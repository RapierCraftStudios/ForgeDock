// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MECHANICAL_KINDS, FIX_PROMPT_MAX, citesFileLine, freshFix, issueSummary, capText, TRIGGERS, REWORK_TRIGGERS, firstPassOf, formatFirstPassSummary, sessionCostDelta } from "./fixround.mjs";
import { fixSessionPrompt } from "./prompts.mjs";

describe("#4363 fresh fix sessions: which rounds, and the prompt caps", () => {
  it("every mechanical kind is fresh; block/contract/conflict kinds are not", () => {
    assert.deepEqual([...MECHANICAL_KINDS], ["precheck", "ci", "docs", "structure", "enumerating", "sequence"]);
    for (const k of MECHANICAL_KINDS) assert.equal(freshFix(k, []), true, k);
    for (const k of ["block", "contract", "base-sync", "ci-unavailable"]) assert.equal(freshFix(k, [{ detail: "src/a.js:1" }]), false, k);
  });

  it("a conformance or review FAIL is fresh only when every failure cites a file:line", () => {
    const cited = [{ code: "c", detail: "R1 partial: null throws (src/foo.js:9)" }, { code: "c", detail: "P1 violated (lib/bar.ts:12)" }];
    const mixed = [...cited, { code: "c", detail: "validate V1 (`npm test`) failed (exit 1)" }];
    for (const k of ["conformance", "review"]) {
      assert.equal(freshFix(k, cited), true, k);
      assert.equal(freshFix(k, mixed), false, `${k}: one failure without a file:line`);
      assert.equal(freshFix(k, []), false, `${k}: no failures`);
    }
  });

  it("file:line detection is codebase-agnostic", () => {
    for (const d of ["app/models.py:42", "cmd/main.go:7", "src/lib.rs:310", "web/src/App.tsx:5", "lib/x/y.rb:1", "@scope/pkg/index.mjs:88", "Foo.java:3"]) {
      assert.equal(citesFileLine([`fails at ${d}`]), true, d);
    }
    for (const d of ["the foo module", "R1 partial", "exit 1: 3 tests failed", "http://host:8080"]) assert.equal(citesFileLine([d]), false, d);
  });

  it("the issue summary drops HTML comments (FORGE:STATE) and is capped", () => {
    const s = issueSummary(`## Problem\nfoo breaks\n\n<!-- FORGE:STATE\n{"v":1}\n-->\n${"y".repeat(5000)}`);
    assert.doesNotMatch(s, /FORGE:STATE|"v":1/);
    assert.match(s, /^## Problem\nfoo breaks/);
    assert.ok(s.length < 1600);
    assert.equal(capText("abc", 5), "abc");
  });

  it("an oversized task, diff and contract still give a prompt under 60K with the title, summary, contract and diff", () => {
    const diff = Array.from({ length: 50 }, (_, i) => `diff --git a/src/f${i}.js b/src/f${i}.js\n${"+line\n".repeat(2000)}`).join("");
    const contract = { requirements: [{ id: "R1", quote: "q".repeat(50000), disposition: "deliver" }] };
    const p = fixSessionPrompt({ task: `lint failed\n${"z".repeat(200000)}`, diff, stat: " src/f0.js | 2000 +", base: "origin/staging", contract, title: "foo breaks", summary: "foo crashes on null" });
    assert.ok(p.length < 60000, `prompt ${p.length} chars`);
    assert.ok(p.length < FIX_PROMPT_MAX);
    assert.match(p, /no earlier session/); assert.match(p, /## Issue: foo breaks\nfoo crashes on null/);
    assert.match(p, /"id": "R1"/); assert.match(p, /diff --git a\/src\/f0\.js/); assert.match(p, /git diff origin\/staging\.\.\.HEAD/);
    assert.match(p, /lint failed/); assert.match(p, /Host rules/);
  });
});

describe("#4362 attempt triggers and first pass", () => {
  const t = (...xs) => xs.map((trigger) => ({ trigger }));
  it("the trigger vocabulary is the issue's closed list; rework is a subset", () => {
    assert.deepEqual([...TRIGGERS], ["plan", "build", "block_correction", "contract_correction", "precheck", "structure", "docs", "enumerating",
      "sequence", "ci_unavailable", "ci_red", "conformance", "review", "merge_ci", "timeout_restart", "recovery", "verifier", "context_restart", "budget_wrapup"]);
    for (const r of REWORK_TRIGGERS) assert.ok(TRIGGERS.includes(r), r);
  });
  it("firstPassOf: null without a build or with an untagged attempt; rework after the build breaks it, repairs do not", () => {
    assert.equal(firstPassOf(t("plan")), null);
    assert.equal(firstPassOf([{ trigger: "plan" }, {}]), null);
    assert.equal(firstPassOf(t("plan", "build")), true);
    assert.equal(firstPassOf(t("plan", "precheck", "build")), true, "only attempts after the build count");
    assert.equal(firstPassOf(t("plan", "build", "timeout_restart", "recovery", "ci_unavailable", "block_correction")), true);
    for (const r of REWORK_TRIGGERS) assert.equal(firstPassOf(t("plan", "build", r)), false, r);
    const killed = [{ trigger: "plan" }, { trigger: "timeout_restart", restart_of: "build" }];
    assert.equal(firstPassOf(killed), true, "a killed and restarted build still reached the build");
    assert.equal(firstPassOf([...killed, { trigger: "review" }]), false);
    assert.equal(firstPassOf([{ trigger: "timeout_restart", restart_of: "plan" }]), null, "a restarted plan is not the build");
    assert.equal(firstPassOf([{ trigger: "plan" }, { trigger: "context_restart", restart_of: "build" }]), true, "#4390: a context-ceiling restart of the build reached the build");
    assert.equal(firstPassOf(t("plan", "build", "context_restart")), true, "#4390: a context restart is not rework");
  });
  it("formatFirstPassSummary counts only rows that reached the build", () => {
    assert.equal(formatFirstPassSummary([{ first_pass: true }, { first_pass: false }, { issue: 3 }, { first_pass: true }]), "first-pass: 67% (2/3 lanes that reached the build)");
    assert.equal(formatFirstPassSummary([{ first_pass: true }]), "first-pass: 100% (1/1 lane that reached the build)");
    assert.equal(formatFirstPassSummary([{ issue: 1 }]), null);
    assert.equal(formatFirstPassSummary(undefined), null);
  });
});

describe("#4407 sessionCostDelta: per-attempt cost from a resumed session's running total", () => {
  it("a session of N attempts: the deltas sum to the final session total", () => {
    const last = new Map(), totals = [2.33, 2.41, 15.25, 16.31];
    const ds = totals.map((cost, i) => sessionCostDelta(last, { resume: i ? "s" : null, sessionId: "s", cost }));
    assert.deepEqual(ds.map((d) => d.session), totals);
    assert.equal(Math.round(ds.reduce((a, d) => a + d.delta, 0) * 1e9) / 1e9, 16.31);
    assert.deepEqual(ds.map((d) => d.delta), [2.33, 0.08, 12.84, 1.06]);
  });

  it("a fresh call, an unknown session and a total below the previous one count in full", () => {
    const last = new Map([["s", 5]]);
    assert.equal(sessionCostDelta(last, { resume: null, sessionId: "s", cost: 1 }).delta, 1, "fresh");
    assert.equal(sessionCostDelta(new Map(), { resume: "x", sessionId: "x", cost: 3 }).delta, 3, "unknown session");
    const l2 = new Map([["s", 5]]);
    assert.equal(sessionCostDelta(l2, { resume: "s", sessionId: "s", cost: 2 }).delta, 2, "below the previous total");
  });

  it("a non-finite cost yields nulls and leaves the map alone", () => {
    const last = new Map([["s", 1]]);
    assert.deepEqual(sessionCostDelta(last, { resume: "s", sessionId: "s", cost: null }), { delta: null, session: null });
    assert.deepEqual(sessionCostDelta(last, { resume: "s", sessionId: "s", cost: NaN }), { delta: null, session: null });
    assert.deepEqual([...last], [["s", 1]]);
  });

  it("a resume that returns a new session id: the next resume of that id subtracts its total", () => {
    const last = new Map();
    sessionCostDelta(last, { resume: null, sessionId: "a", cost: 1 });
    assert.equal(sessionCostDelta(last, { resume: "a", sessionId: "b", cost: 1.5 }).delta, 0.5);
    assert.equal(sessionCostDelta(last, { resume: "b", sessionId: "b", cost: 2 }).delta, 0.5);
  });
});
