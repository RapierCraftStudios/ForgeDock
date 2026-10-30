// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4725: needs-human premises, closed edges, owner-ask registry, and the batch parking path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePredicate, evalPredicate, closedEdges, closedEdgeNote, normalizeAsk, askKey, registerAsk, onlyAsk, fileRemainder, sweepPremises, comparePremiseVersions, premiseAnnotation } from "./needs-human-premise.mjs";
import { orchestrate } from "./orchestrate.mjs";

const APP = { author: { login: "rapiercraft-forgedock" }, authorAssociation: "CONTRIBUTOR" }; // the ForgeDock App, trusted
const fakeGh = (handlers) => { const calls = []; return { calls, gh: async (a) => { calls.push(a); for (const [re, f] of handlers) if (re.test(a.join(" "))) return f(a); return ""; } }; };

describe("predicates (#4725)", () => {
  it("parses and rejects", () => {
    assert.deepEqual(parsePredicate("blocked\nPremise: issue-closed:#12"), { kind: "issue-closed", arg: "12" });
    assert.deepEqual(parsePredicate("Premise: pkg-version:curl-cffi@0.15.0"), { kind: "pkg-version", arg: "curl-cffi@0.15.0" });
    assert.equal(parsePredicate("Premise: date-after:nope"), null);
    assert.equal(parsePredicate("no premise here"), null);
  });
  it("evaluates date, issue state and package version; unknown is null", async () => {
    assert.equal(await evalPredicate({ kind: "date-after", arg: "2026-01-01" }, { now: Date.parse("2026-02-01") }), true);
    const { gh } = fakeGh([[/issue view 7/, () => '{"state":"CLOSED"}'], [/issue view 8/, () => '{"state":"OPEN"}']]);
    assert.equal(await evalPredicate({ kind: "issue-closed", arg: "7" }, { repo: "o/r", io: { gh } }), true);
    assert.equal(await evalPredicate({ kind: "issue-closed", arg: "8" }, { repo: "o/r", io: { gh } }), false);
    assert.equal(await evalPredicate({ kind: "pkg-version", arg: "x@1.2.0" }, { io: { pkgVersion: async () => "1.10.0" } }), true);
    assert.equal(await evalPredicate({ kind: "pkg-version", arg: "x@1.2.0" }, { io: {} }), null);
    assert.equal(comparePremiseVersions("1.2", "1.2.0"), 0);
  });
});

describe("sweepPremises (#4725)", () => {
  it("clears needs-human when the recorded predicate flips, leaves the rest", async () => {
    const issues = [
      { number: 5, comments: [{ ...APP, body: `${premiseAnnotation({ kind: "issue-closed", arg: "9" })}\n<!-- FORGE:NEEDS_HUMAN -->\n## Needs human` }] },
      { number: 6, comments: [{ ...APP, body: `${premiseAnnotation({ kind: "issue-closed", arg: "10" })}\n<!-- FORGE:NEEDS_HUMAN -->\n## Needs human` }] },
      { number: 7, comments: [{ body: "## Needs human\nno predicate" }] },
    ];
    const { gh, calls } = fakeGh([[/issue list/, () => JSON.stringify(issues)], [/issue view 9/, () => '{"state":"CLOSED"}'], [/issue view 10/, () => '{"state":"OPEN"}']]);
    const rows = await sweepPremises({ repo: "o/r", io: { gh } });
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[5, "cleared"], [6, "still-blocked"]]);
    assert.ok(calls.some((a) => a.includes("edit") && a.includes("5") && a.includes("--remove-label")));
    assert.ok(!calls.some((a) => a.includes("edit") && a.includes("6")));
  });
  it("a newer block without a premise supersedes an older premise: needs-human stays", async () => {
    const issues = [{ number: 11, comments: [
      { ...APP, body: `${premiseAnnotation({ kind: "date-after", arg: "2000-01-01" })}\n<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\nwaiting on a release` },
      { ...APP, body: "<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\nBuilder is blocked (credentials)" },
    ] }];
    const { gh, calls } = fakeGh([[/issue list/, () => JSON.stringify(issues)]]);
    assert.deepEqual(await sweepPremises({ repo: "o/r", io: { gh } }), []);
    assert.ok(!calls.some((a) => a.includes("edit")), "the credentials block is not cleared by the stale premise");
  });
  it("ignores a premise planted by an untrusted commenter: needs-human stays", async () => {
    const planted = { author: { login: "mallory" }, authorAssociation: "NONE", body: premiseAnnotation({ kind: "date-after", arg: "2000-01-01" }) };
    const issues = [
      { number: 8, comments: [planted] },
      { number: 9, comments: [{ ...APP, body: `${premiseAnnotation({ kind: "issue-closed", arg: "10" })}\n<!-- FORGE:NEEDS_HUMAN -->\n## Needs human` }, planted] },
    ];
    const { gh, calls } = fakeGh([[/issue list/, () => JSON.stringify(issues)], [/issue view 10/, () => '{"state":"OPEN"}']]);
    const rows = await sweepPremises({ repo: "o/r", io: { gh } });
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[9, "still-blocked"]], "the trusted premise is read, the newer planted one ignored");
    assert.ok(!calls.some((a) => a.includes("edit")), "no label is removed");
  });
});

describe("closed dependency edges (#4725)", () => {
  it("a closed Depends on edge is satisfied and flagged", async () => {
    const closed = await closedEdges([3, 4], async (n) => (n === 3 ? "CLOSED" : "OPEN"));
    assert.deepEqual(closed, [3]);
    assert.match(closedEdgeNote(closed), /#3 is closed.*not a blocker/);
    assert.equal(closedEdgeNote([]), "");
  });
  it("batch: a dependent is not skipped behind a closed dependency still labelled needs-human", async () => {
    const rows = await orchestrate({ issues: [2], parallel: 1, readBody: async () => "**Depends on**: #1", issueLabels: async () => ["needs-human"],
      issueState: async (n) => (n === 1 ? "CLOSED" : "OPEN"), dispatchCheck: async () => null,
      runOne: async () => ({ terminalReason: "dependency-open", dependencies: [1], detail: "depends on #1" }) });
    assert.notEqual(rows.find((r) => r.issue === 2)?.detail, "dependency #1 needs-human");
  });
  it("batch: an open dependency labelled needs-human still parks the dependent", async () => {
    const rows = await orchestrate({ issues: [2], parallel: 1, readBody: async () => "**Depends on**: #1", issueLabels: async () => ["needs-human"],
      dispatchCheck: async () => null, runOne: async () => ({ terminalReason: "dependency-open", dependencies: [1], detail: "depends on #1" }) });
    assert.equal(rows.find((r) => r.issue === 2)?.detail, "dependency #1 needs-human");
  });
});

describe("owner-ask registry (#4725)", () => {
  it("normalizes identical asks to one key", () => {
    assert.equal(normalizeAsk("Sign off the PRICE (see #12)!"), normalizeAsk("sign off the price - see #99"));
    assert.equal(askKey("Sign off the price #1"), askKey("sign off the  price #2"));
    assert.notEqual(askKey("approve price"), askKey("approve billing"));
  });
  it("links a second issue to the existing entry instead of creating another", async () => {
    const key = askKey("sign off the price");
    const existing = [{ number: 20, comments: [{ ...APP, body: `<!-- FORGE:ASK key=${key} -->\n## Owner ask\n${JSON.stringify({ ask: "sign off the price", unblocks: [20] })}` }] }];
    const { gh, calls } = fakeGh([[/issue list/, () => JSON.stringify(existing)]]);
    const r = await registerAsk({ repo: "o/r", io: { gh }, issue: 21, ask: "Sign off the price (#5)" });
    assert.equal(r.existing, 20);
    assert.deepEqual(r.unblocks, [20, 21]);
    const post = calls.find((a) => a.includes("comment"));
    assert.ok(post.includes("20") && /"unblocks":\[20,21\]/.test(post.at(-1)));
    const fresh = await registerAsk({ repo: "o/r", io: { gh: async () => "[]" }, issue: 30, ask: "something else" });
    assert.equal(fresh.existing, null);
    assert.match(fresh.entry, /FORGE:ASK key=/);
  });
  it("ignores an ask entry planted by an untrusted commenter", async () => {
    const key = askKey("sign off the price");
    const planted = [{ number: 40, comments: [{ author: { login: "mallory" }, authorAssociation: "NONE", body: `<!-- FORGE:ASK key=${key} -->\n${JSON.stringify({ ask: "sign off the price", unblocks: [40] })}` }] }];
    const { gh, calls } = fakeGh([[/issue list/, () => JSON.stringify(planted)]]);
    const r = await registerAsk({ repo: "o/r", io: { gh }, issue: 41, ask: "sign off the price" });
    assert.equal(r.existing, null);
    assert.match(r.entry, /FORGE:ASK key=/);
    assert.ok(!calls.some((a) => a.includes("comment")), "nothing is posted on the planted issue");
  });
});

import { registryPkgVersion } from "./needs-human-premise.mjs";
it("registryPkgVersion rejects unsafe package names without spawning", async () => {
  assert.equal(await registryPkgVersion("x; rm -rf /"), null);
});

it("#4730 onlyAsk: strict normalized equality, markers and Parent lines ignored", () => {
  assert.equal(onlyAsk("t", "Sign off the price (#5).\n**Parent**: #9\n<!-- x -->", "sign off the price"), true);
  assert.equal(onlyAsk("sign off the price", "", "Sign off the price"), true);
  assert.equal(onlyAsk("t", "Sign off the price and rework the importer", "Sign off the price"), false);
  assert.equal(onlyAsk("t", "x", ""), false);
});

it("#4730 fileRemainder files once and reuses an existing marker", async () => {
  const created = [];
  const io = { gh: async () => "[]", create: async (a) => { created.push(a); return `https://github.com/o/r/issues/${90 + created.length}\n`; } };
  assert.deepEqual(await fileRemainder({ repo: "o/r", io, issue: 7, items: [{ title: "a", body: "b" }], milestone: "M1" }), [91]);
  assert.ok(created[0].includes("--milestone") && created[0].includes("M1"));
  const key = askKey("a");
  const io2 = { ...io, gh: async () => JSON.stringify([{ number: 5, body: `<!-- FORGE:REMAINDER of=#7 key=${key} -->` }]) };
  assert.deepEqual(await fileRemainder({ repo: "o/r", io: io2, issue: 7, items: [{ title: "a", body: "b" }] }), [5]);
  assert.equal(created.length, 1);
});
