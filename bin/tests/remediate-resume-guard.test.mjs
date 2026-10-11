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
    assert.ok(spec.includes('capture("^APPROVED: commit '));
  });

  it("forge#3726: approval is bound to headRefOid by SHA, never by committedDate", () => {
    assert.ok(!spec.includes("HEAD_COMMITTED"));
    assert.ok(!spec.includes("committedDate") || /never to author-controlled committedDate|commit dates are author-controlled/.test(spec));
    assert.ok(!/created_at\s*>/.test(spec), "no timestamp freshness compare");
    assert.match(spec, /headRefOid/);
    assert.match(spec, /APPROVED: commit \(\?<s>\[0-9a-f\]\{7,40\}\)/);
    assert.match(spec, /startswith\(\$s\)/);
    assert.match(spec, /Reviewed-SHA: /);
    assert.match(spec, /\.commit_id \/\/ \$head\) == \$head/);
  });

  it("forge#3726: resume reads PR reviews and issue comments and fails closed on empty head", () => {
    assert.match(spec, /pulls\/\{PR_NUMBER\}\/reviews/);
    assert.match(spec, /issues\/\{PR_NUMBER\}\/comments/);
    assert.match(spec, /if \[ -n "\$HEAD_OID" \]; then/);
    assert.match(spec, /RESUME_APPROVED_N=0\n/);
  });

  it("forge#3726: the resume merge is pinned to the approved head", () => {
    assert.match(spec, /GATED_HEAD" != "\$RESUME_APPROVED_HEAD"/);
    assert.match(spec, /CI_GATE_RC=4/);
  });

  it("forge#3726: park evidence must name the PR being merged (fixed string)", () => {
    assert.match(spec, /PARK_PR_MARK="PR #\{PR_NUMBER\} was previously escalated"/);
    assert.match(spec, /grep -qF "\$PARK_PR_MARK"/);
  });

  it("computes IS_DEPLOY_GATE before the resume substitution", () => {
    const gate = spec.indexOf("IS_DEPLOY_GATE=false; else IS_DEPLOY_GATE=true");
    const resume = spec.indexOf('if [ "${RESUME_AT_M7:-false}" = "true" ]; then\n  HEAD_OID');
    assert.ok(gate > 0 && resume > 0, "markers present");
    assert.ok(gate < resume, "IS_DEPLOY_GATE must be defined before the resume block");
  });

  it("forge#3728: every fence that reads IS_DEPLOY_GATE defines it first, identically", () => {
    const def = "IS_DEPLOY_GATE=false; else IS_DEPLOY_GATE=true";
    const fences = spec.split("```bash").slice(1).map((f) => f.split("```")[0]);
    const readers = fences.filter((f) => /\$\{?IS_DEPLOY_GATE/.test(f));
    assert.ok(readers.length >= 3, "resume, bar and M8 fences read the flag");
    for (const f of readers) {
      if (f.includes("Phase M8") || !f.includes("RESUME_AT_M7") && !f.includes("BAR_MET")) continue;
      const d = f.indexOf(def);
      assert.ok(d >= 0, "fence must define IS_DEPLOY_GATE before reading it");
      assert.ok(d < f.search(/\$\{?IS_DEPLOY_GATE/), "definition precedes first read");
    }
  });

  it("forge#3728: no IS_DEPLOY_GATE read lacks the :-true fail-closed default", () => {
    assert.ok(!/"\$IS_DEPLOY_GATE"/.test(spec), "undefaulted read");
    assert.ok(!/\$IS_DEPLOY_GATE\b/.test(spec), "bare $IS_DEPLOY_GATE read");
    assert.ok(spec.includes('"${IS_DEPLOY_GATE:-true}" = "true"'));
  });

  it("forces GATE_PASSED=false and BAR_MET=false on resume with a deploy-gate base", () => {
    assert.match(spec, /if \[ "\$\{IS_DEPLOY_GATE:-true\}" = "true" \]; then GATE_PASSED=false/);
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
