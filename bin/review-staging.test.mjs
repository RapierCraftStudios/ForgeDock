// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stagingVerdict } from "./review-staging.mjs";

const ok = { ciFailing: 0, testGateInvalid: false, confirmedCritical: 0, confirmedHigh: 0 };

describe("stagingVerdict feature acceptance (#5336)", () => {
  it("approves without an acceptance block (no epic: unchanged)", () => {
    assert.equal(stagingVerdict(ok).verdict, "APPROVE FOR DEPLOY");
  });
  it("a red/never-run journey or a SKIP test gate on an epic milestone is BLOCK DEPLOY", () => {
    const v = stagingVerdict({ ...ok, acceptanceBlocked: "Test Gate SKIP (verification.integration_tests not configured) on a milestone with an epic" });
    assert.equal(v.verdict, "BLOCK DEPLOY");
    assert.match(v.why, /feature acceptance blocked: Test Gate SKIP/);
  });
});
