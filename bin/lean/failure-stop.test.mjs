// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repeatSignature, countIdentical, isResetDecision, shouldPark, summaryComment } from "./failure-stop.mjs";
import { repeatCounted } from "./admit.mjs";
import { OUTCOME_CODES, RECOVERABLE_CODES, classifyNeedsHuman, parkedLabel } from "../engine/outcome-codes.mjs";

const D1 = "R3 unimplemented at 1e0c3e45 (cost $1.2345, 12 turns) 2026-11-25T10:00:00Z";
const D2 = "R3   unimplemented at 0703a2d8 (cost $9.99, 40 turns) 2026-11-26T11:11:11Z";
const nh = (sig) => ({ body: `<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\nx\n\nsig=${sig}\n\n_cost $1_` });

describe("identical-failure stop (#5979)", () => {
  it("the signature is stable across shas, costs and timestamps and differs across codes and details", () => {
    assert.equal(repeatSignature("conformance.omission", D1), repeatSignature("conformance.omission", D2));
    assert.notEqual(repeatSignature("conformance.omission", D1), repeatSignature("ci.red", D1));
    assert.notEqual(repeatSignature("ci.red", "lint failed"), repeatSignature("ci.red", "tests failed"));
  });
  it("the 2nd identical failure parks, the 1st does not", () => {
    const sig = repeatSignature("ci.red", "boom");
    assert.equal(shouldPark(countIdentical([], sig) + 1), false);
    assert.equal(shouldPark(countIdentical([nh(sig)], sig) + 1), true);
    assert.equal(shouldPark(countIdentical([nh("ffffffffffff")], sig) + 1), false);
  });
  it("an untrusted comment or one without the marker does not count; a PARKED summary does", () => {
    const sig = "abcabcabcabc";
    assert.equal(countIdentical([nh(sig)], sig, () => false), 0);
    assert.equal(countIdentical([{ body: `sig=${sig}` }], sig), 0);
    assert.equal(countIdentical([{ body: `<!-- FORGE:PARKED -->\nsig=${sig}` }], sig), 1);
  });
  it("#6122 a FORGE:DECISION newer than the last park resets the repeat count; one before it does not; the engine's own premise note never does", () => {
    const sig = repeatSignature("builder.blocked", "R4 manual");
    const dec = { body: `<!-- FORGE:DECISION {"requirement":"R4","disposition":"post-deploy","quote":"x"} -->` };
    const premise = { body: "<!-- FORGE:DECISION -->\n## Decision: no needs-human\nx" };
    assert.equal(isResetDecision(dec.body), true);
    assert.equal(isResetDecision(premise.body), false);
    assert.equal(shouldPark(countIdentical([nh(sig), dec], sig) + 1), false, "decision after the park: the next failure is a first");
    assert.equal(shouldPark(countIdentical([dec, nh(sig)], sig) + 1), true, "decision before the park does not clear it");
    assert.equal(shouldPark(countIdentical([nh(sig), premise], sig) + 1), true);
    assert.equal(shouldPark(countIdentical([nh(sig), dec, nh(sig)], sig) + 1), true, "an identical failure after the decision still parks");
    assert.equal(countIdentical([nh(sig), dec], sig, () => false), 0);
    assert.equal(shouldPark(countIdentical([nh(sig), dec], sig, (c) => c !== dec) + 1), true, "an untrusted decision does not reset");
  });
  it("the summary names the attempts, the failure and what would unblock it", () => {
    const s = summaryComment({ attempts: 2, code: "ci.red", detail: "boom", unblock: "decide X", sig: "abcabcabcabc" });
    assert.match(s, /2 lane runs/);
    assert.match(s, /`ci\.red`/);
    assert.match(s, /boom/);
    assert.match(s, /To unblock\*\*: decide X/);
    assert.match(s, /sig=abcabcabcabc/);
  });
  it("failure.repeated is parked, never recoverable", () => {
    assert.equal(RECOVERABLE_CODES.includes(OUTCOME_CODES.FAILURE_REPEATED), false);
    const row = { outcome: "needs-human", code: OUTCOME_CODES.FAILURE_REPEATED };
    assert.equal(classifyNeedsHuman(row), "terminal");
    assert.equal(classifyNeedsHuman(row, { parked: true }), "parked");
    assert.equal(parkedLabel(OUTCOME_CODES.FAILURE_REPEATED), "parked:failure.repeated");
  });
  it("#6243 a repeated identical engine error or timeout parks (the lean.mjs gate); a repeated quota or rate limit does not", () => {
    for (const code of [OUTCOME_CODES.ENGINE_ERROR, OUTCOME_CODES.CLI_TIMEOUT, OUTCOME_CODES.CLI_IDLE, OUTCOME_CODES.BACKEND_CLI_FAILED, OUTCOME_CODES.RUN_INTERRUPTED]) {
      const sig = repeatSignature(code, "boom");
      const identical = repeatCounted(code) ? countIdentical([nh(sig)], sig) + 1 : 1;
      assert.equal(shouldPark(identical), true, code);
    }
    for (const code of [OUTCOME_CODES.QUOTA_EXHAUSTED, OUTCOME_CODES.RATE_LIMITED, OUTCOME_CODES.NET_TRANSIENT]) {
      const sig = repeatSignature(code, "boom");
      const identical = repeatCounted(code) ? countIdentical([nh(sig)], sig) + 1 : 1;
      assert.equal(shouldPark(identical), false, code);
    }
  });
});
