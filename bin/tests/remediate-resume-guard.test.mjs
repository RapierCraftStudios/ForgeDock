// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forge#3684: the remediate.md RESUME_AT_M7 path must fail closed (main-base hold,
// anchored approval match, head-commit selection, engine-park admission).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    assert.match(spec, /GATED_HEAD" != "\$APPROVED_HEAD"/);
    assert.ok(!spec.includes('if [ "${RESUME_AT_M7:-false}" = "true" ] && [ "$CI_GATE_RC" -eq 0 ]'), "guard must not be resume-only");
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

describe("forge#3722 deploy-gate base resolves branches.default", () => {
  const review = readFileSync(join(ROOT, "commands/review-pr.md"), "utf8");
  const RES = "yq '.branches.default // \"main\"'";
  it("no literal-main base comparison remains in either spec", () => {
    assert.ok(!/!= "main"/.test(spec), "remediate.md");
    assert.ok(!/!= "main"/.test(review), "review-pr.md");
    assert.ok(spec.includes("branches.default"));
  });
  it("every fence comparing a base to DEFAULT_BRANCH resolves it first", () => {
    for (const [name, text] of [["remediate", spec], ["review-pr", review]]) {
      const fences = text.split("```bash").slice(1).map((f) => f.split("```")[0]);
      const users = fences.filter((f) => /!= "\$DEFAULT_BRANCH"/.test(f));
      assert.ok(users.length >= 1, name);
      for (const f of users) {
        const r = f.indexOf(RES);
        assert.ok(r >= 0 && r < f.indexOf('!= "$DEFAULT_BRANCH"'), `${name}: resolver precedes comparison`);
      }
    }
  });
  it("derivation executes correctly for main/master/production/empty/null", () => {
    const line = spec.match(/^\s*(if \[ -n "\$LIVE_BASE_REF" \][^\n]*)$/m)[1];
    const run = (base, cfg) => {
      const script = `DEFAULT_BRANCH="${cfg}"; DEFAULT_BRANCH="\${DEFAULT_BRANCH:-main}"; LIVE_BASE_REF="${base}"; ${line}; echo $IS_DEPLOY_GATE`;
      return String(spawnSync("bash", ["-c", script]).stdout).trim();
    };
    assert.equal(run("main", "main"), "true");
    assert.equal(run("master", "master"), "true");
    assert.equal(run("production", "production"), "true");
    assert.equal(run("staging", "master"), "false");
    assert.equal(run("", "master"), "true");
    assert.equal(run("null", "master"), "true");
    assert.equal(run("master", ""), "false");
    assert.equal(run("main", ""), "true");
  });
});

describe("forge#3738 resume approval filter executes against fixtures", () => {
  const m = spec.match(/_JQ='([\s\S]*?)'\n/);
  const HEAD = "a".repeat(40);
  const run = (items) => {
    const prog = m[1];
    const out = spawnSync("jq", ["-s", "--arg", "head", HEAD, prog], { input: items.map((p) => JSON.stringify(p)).join("\n") });
    return Number(String(out.stdout).trim());
  };
  const bot = (body, extra = {}) => ({ user: { type: "Bot" }, author_association: "CONTRIBUTOR", body, ...extra });
  it("reviewer-agent comment with only a Reviewed-SHA line is not approval", () => {
    assert.equal(run([[bot(`<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: ${HEAD}\n\nHIGH finding`)]]), 0);
  });
  it("APPROVED: body with Reviewed-SHA line at head is approval", () => {
    assert.equal(run([[bot(`APPROVED: all good\nReviewed-SHA: ${HEAD}\n`)]]), 1);
  });
  it("APPROVED: commit <sha> prefix is approval; wrong sha or untrusted author is not", () => {
    assert.equal(run([[bot(`APPROVED: commit ${HEAD.slice(0, 7)} ok`)]]), 1);
    assert.equal(run([[bot("APPROVED: commit bbbbbbb ok")]]), 0);
    assert.equal(run([[{ user: { type: "User" }, author_association: "NONE", body: `APPROVED: commit ${HEAD.slice(0, 7)}` }]]), 0);
  });
});
