// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conformanceResumePrompt } from "./prompts.mjs";
import { checkFailureTail, redactSecrets } from "./precheck.mjs";

describe("#6058 conformanceResumePrompt names skipped requirements", () => {
  it("lists each no-status id with its quote and asks for the work and a row; other failures follow", () => {
    const p = conformanceResumePrompt([
      { code: "conformance.unimplemented", kind: "requirement_no_status", reqId: "R4", quote: "the cap is 40 lines", detail: 'R4 reported "no status"' },
      { code: "conformance.unimplemented", kind: "requirement_no_status", reqId: "R5", quote: "secrets are redacted", detail: 'R5 reported "no status"' },
      { code: "conformance.unimplemented", kind: "validate_failed", detail: "validate V1 failed (exit 1)" },
    ], "local");
    assert.match(p, /no status row for R4, R5/); assert.match(p, /- R4: "the cap is 40 lines"/); assert.match(p, /- R5: "secrets are redacted"/);
    assert.match(p, /Also:\n- conformance\.unimplemented: validate V1 failed/);
    assert.doesNotMatch(p, /R4 reported/);
  });
  it("without a no-status failure the prompt is the generic one", () => {
    assert.match(conformanceResumePrompt([{ code: "conformance.unimplemented", kind: "requirement_unimplemented", detail: 'R1 reported "partial"' }]), /^The change does not conform/);
  });
});

describe("#6107 checkFailureTail", () => {
  it("names the check, keeps the last 40 lines and redacts secrets", () => {
    const out = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\nDB_PASSWORD=swordfish99\npostgres://u:pw12345@host/db";
    const t = checkFailureTail({ command: "npm test", rc: 2, output: out }, { name: "unit job" });
    assert.match(t, /Failing check unit job \(`npm test`\), exit 2, last 40 lines/);
    assert.match(t, /line 79/); assert.doesNotMatch(t, /line 10\b/);
    assert.doesNotMatch(t, /swordfish99|pw12345/);
    assert.equal(redactSecrets("token ghp_abcdefghijklmnopqrstuv"), "token [redacted]");
  });
});
