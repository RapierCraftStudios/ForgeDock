// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forge#3684: the remediate.md RESUME_AT_M7 path must fail closed (main-base hold,
// anchored approval match, head-commit selection, engine-park admission).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spec = readFileSync(join(ROOT, "commands/work-on/remediate.md"), "utf8");

describe("forge#3684 remediate.md resume guard", () => {
  it("has no commits[-1] and no unanchored APPROVED: match", () => {
    assert.ok(!spec.includes("commits[-1]"));
    assert.ok(!spec.includes('test("APPROVED:")'));
    assert.ok(spec.includes('test("^APPROVED:")'));
  });

  it("selects the head commit by headRefOid", () => {
    assert.match(spec, /select\(\.oid == \$head\)/);
  });

  it("computes IS_DEPLOY_GATE before the resume substitution", () => {
    const gate = spec.indexOf("IS_DEPLOY_GATE=false; else IS_DEPLOY_GATE=true");
    const resume = spec.indexOf('if [ "${RESUME_AT_M7:-false}" = "true" ]; then\n  HEAD_OID');
    assert.ok(gate > 0 && resume > 0, "markers present");
    assert.ok(gate < resume, "IS_DEPLOY_GATE must be defined before the resume block");
    assert.equal(spec.split("IS_DEPLOY_GATE=false; else IS_DEPLOY_GATE=true").length - 1, 1, "single definition");
  });

  it("forces GATE_PASSED=false and BAR_MET=false on resume with a deploy-gate base", () => {
    assert.match(spec, /if \[ "\$IS_DEPLOY_GATE" = "true" \]; then GATE_PASSED=false/);
    assert.match(
      spec,
      /if \[ "\$\{RESUME_AT_M7:-false\}" = "true" \]; then BAR_MET=false\n\s+else \{ \[ "\$\{APPROVED_COUNT/,
    );
  });

  it("requires engine-park evidence for admission", () => {
    assert.match(spec, /for the remediation auto-land bar/);
    assert.match(spec, /RESUME_AT_M7=false\s+# BLOCKED/);
    assert.match(spec, /engine-parked/);
  });
});
