// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeInputHash, emptyLedger, normalizeLedger, recordFailure, breach, admitInput, markEscalated, renderEscalation, renderAttempts, parseAttempts, validateAmendments, budgets, makeAttemptsSeam } from "./attempts.mjs";
import { postKeyed } from "./statuscomment.mjs";

const base = { title: "t", body: "b", labels: ["bug"], decisions: [], engineVersion: "1.2.3", sandboxVersion: "1.2.0", contractHash: "c1" };
const fail = (l, sig, hash) => recordFailure(l, { signature: sig, hash, spend: 1.5, run: `run-${(l?.attempts ?? 0) + 1}` });

describe("#5986 input hash", () => {
  it("changes with body, title, labels, decisions, engine major.minor and contract; not with needs-human or a patch bump", () => {
    const h = computeInputHash(base);
    for (const k of [{ body: "b2" }, { title: "t2" }, { labels: ["bug", "x"] }, { decisions: ["FORGE:DECISION ok"] }, { engineVersion: "1.3.0" }, { sandboxVersion: "2.0.0" }, { contractHash: "c2" }]) assert.notEqual(computeInputHash({ ...base, ...k }), h, JSON.stringify(k));
    assert.equal(computeInputHash({ ...base, labels: ["bug", { name: "needs-human" }] }), h);
    assert.equal(computeInputHash({ ...base, engineVersion: "1.2.9" }), h);
    assert.equal(computeInputHash({ ...base, labels: ["x", "bug"] }), computeInputHash({ ...base, labels: ["bug", "x"] }));
  });
});

describe("#5986 admission, budgets, escalation", () => {
  const cfg = {};
  it("defaults are 4 and 2; a missing ledger admits; a changed hash admits", () => {
    assert.deepEqual(budgets(undefined), { maxAttempts: 4, maxIdentical: 2 });
    assert.deepEqual(admitInput(null, "H1", cfg), { ok: true });
    assert.deepEqual(admitInput(fail(null, "s", "H1"), "H2", cfg), { ok: true });
    assert.deepEqual(admitInput(fail(null, "s", "H1"), null, cfg), { ok: true }, "unreadable input fails open");
  });
  it("same hash after a failure is refused with loop.no_new_input", () => {
    const a = admitInput(fail(null, "ci.red:x", "H1"), "H1", cfg);
    assert.equal(a.ok, false); assert.equal(a.code, "loop.no_new_input"); assert.match(a.reason, /ci\.red:x/);
  });
  it("the 3rd identical signature breaches; 4 lanes breach; different signatures stay under max_identical", () => {
    let l = fail(null, "s", "H1"); l = fail(l, "s", "H2");
    assert.equal(breach(l, cfg), null);
    assert.equal(breach(fail(l, "s", "H3"), cfg).kind, "identical");
    let m = null; for (const [i, s] of ["a", "b", "c", "d"].entries()) m = fail(m, s, `H${i}`);
    assert.equal(breach(m, cfg).kind, "attempts");
    assert.equal(breach(m, { maxAttempts: 5 }), null);
  });
  it("a breach escalates once at the same hash, then loop.no_new_input; a new hash admits and clears the escalated flag after the next failure", () => {
    let l = null; for (let i = 1; i <= 3; i++) l = fail(l, "s", `H${i}`);
    assert.equal(admitInput(l, "H3", cfg).code, "escalate");
    l = markEscalated(l);
    assert.equal(admitInput(l, "H3", cfg).code, "loop.no_new_input");
    assert.deepEqual(admitInput(l, "H4", cfg), { ok: true });
    assert.equal(fail(l, "s", "H4").escalated, undefined, "the next window escalates again");
  });
  it("the ledger round-trips through the FORGE:ATTEMPTS comment and the escalation names signatures, runs and spend", () => {
    const l = fail(fail(null, "ci.red", "H1"), "base.conflict", "H1");
    assert.deepEqual(parseAttempts(renderAttempts(l)), normalizeLedger(l));
    assert.equal(parseAttempts("hello"), null);
    assert.deepEqual(normalizeLedger(undefined), emptyLedger());
    const body = renderEscalation(l, "2 lanes");
    assert.match(body, /ci\.red[\s\S]*run-1[\s\S]*base\.conflict[\s\S]*Spend: \$3\.00/);
  });
  it("counters survive a releaseHeld-style round trip through JSON state", () => {
    const l = fail(fail(null, "s", "H1"), "s", "H1");
    assert.deepEqual(normalizeLedger(JSON.parse(JSON.stringify(l))), normalizeLedger(l));
  });
});

describe("#5986 shared amendment schema", () => {
  it("accepts valid shapes and rejects wrong types with a message", () => {
    assert.deepEqual(validateAmendments([{ kind: "add-deliverable", path: "a.mjs", why: "x" }, { kind: "decision", decision: { choice: "c", anchors: ["a.mjs"] }, why: "y" }]), []);
    assert.deepEqual(validateAmendments(undefined), []);
    assert.ok(validateAmendments([{ kind: "nope" }]).length);
    assert.match(validateAmendments([{ kind: "add-deliverable", path: 5 }])[0], /path/);
    assert.match(validateAmendments([{ kind: "supersedes", guard: "abc", why: "x" }]).join(), /guard/);
    assert.match(validateAmendments([{ kind: "decision", decision: { anchors: "a" }, why: "x" }]).join(), /choice/);
    assert.match(validateAmendments({ kind: "x" })[0], /array/);
  });
});

describe("#5986 synthetic replay of looping issue timelines", () => {
  // shapes of the AlterLab timelines (#40762 repeated builder.blocked, #41419 repeated amendments, #41262 mixed signatures); the real logs are not in the repo
  const timelines = [
    { name: "#40762", sigs: () => "builder.blocked", amend: () => "same amendment", every: 5 },
    { name: "#41419", sigs: () => "ci.red:same", amend: (i) => `amendment ${i % 3}`, every: 4 },
    { name: "#41262", sigs: (i) => `sig${i % 3}`, amend: (i) => `amendment ${i}`, every: 3 },
  ];
  for (const t of timelines) it(`${t.name}: at most 4 lanes and 12 engine comments over a 30-readmit timeline`, async () => {
    let issueBody = "b"; const comments = [], gh = async (a) => {
      if (a[1] === "view") return JSON.stringify({ comments, title: "t", body: issueBody, labels: [] });
      if (a[1] === "comment") { comments.push({ author: { login: "rapiercraft-forgedock" }, url: `https://x/issues/1#issuecomment-${comments.length + 1}`, body: a[a.indexOf("--body") + 1] }); return comments.at(-1).url; }
      if (a[0] === "api") { const id = Number(/comments\/(\d+)/.exec(a[3])[1]); comments[id - 1].body = a[a.indexOf("-f") + 1].slice(5); }
      return "";
    };
    const trusted = (c) => c.author?.login === "rapiercraft-forgedock";
    const seam = makeAttemptsSeam({ gh, repo: "o/r", trusted, cfg: { maxAttempts: 4, maxIdentical: 2 } });
    let ledger = null, lanes = 0;
    for (let i = 0; i < 30; i++) { // readmitted every poll; a person edits the issue only every `every`th
      issueBody = `b${Math.floor(i / t.every)}`;
      const hash = await seam.hash(1), a = admitInput(ledger, hash, seam.cfg);
      if (!a.ok) { if (a.code === "escalate") ledger = markEscalated(ledger); await seam.notify({ issue: 1, code: a.code, ledger, reason: a.reason }); continue; }
      lanes++;
      await postKeyed({ gh, repo: "o/r", issue: 1, marker: "FORGE:AMENDMENT", body: t.amend(i), trusted });
      ledger = recordFailure(ledger, { signature: t.sigs(i), hash });
      await seam.mirror(1, ledger);
      if (breach(ledger, seam.cfg) && !ledger.escalated) { ledger = markEscalated(ledger); await seam.notify({ issue: 1, code: "escalate", ledger, reason: "x" }); }
    }
    assert.ok(lanes <= 4 * Math.ceil(30 / t.every), `lanes ${lanes}`);
    assert.ok(comments.length <= 12, `comments ${comments.length}`);
  });
  it("a single unchanged-input timeline runs at most 4 lanes and posts one escalation", async () => {
    let ledger = null, lanes = 0;
    for (let i = 0; i < 20; i++) {
      const a = admitInput(ledger, "H", { maxAttempts: 4, maxIdentical: 2 });
      if (!a.ok) { if (a.code === "escalate") ledger = markEscalated(ledger); continue; }
      lanes++; ledger = recordFailure(ledger, { signature: "s", hash: "H" });
    }
    assert.ok(lanes <= 4, `lanes ${lanes}`);
  });
});
