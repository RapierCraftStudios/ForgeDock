// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stagingVerdict, ciNotGreen } from "./review-staging.mjs";

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

describe("ciNotGreen: no checks reported yet", () => {
  const mk = (required) => ({
    cwd: ".",
    run: async () => ({ code: 1, stdout: "", stderr: "no checks reported on the 'x' branch" }),
    gh: async (args) => {
      if (String(args.join(" ")).includes("required_status_checks") && !args.includes("--paginate")) return JSON.stringify({ contexts: required });
      return "";
    },
  });
  const c = { ghRepo: "o/r", defaultBranch: "main", extraRequiredChecks: [] };
  it("is pending (not green) when required checks are not registered yet", async () => {
    const st = await ciNotGreen(mk(["build"]), c, 1, {});
    assert.deepEqual(st?.pending, ["build"]);
  });
  it("stays green when no checks are required", async () => {
    assert.equal(await ciNotGreen(mk([]), c, 1, {}), null);
  });
});
