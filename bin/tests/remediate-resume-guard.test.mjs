// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forge#3684: the remediate.md RESUME_AT_M7 path must fail closed (main-base hold,
// anchored approval match, head-commit selection, engine-park admission).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const gate = spec.indexOf("IS_DEPLOY_GATE=$(bash \"$GATE_SCRIPT\"");
    const resume = spec.indexOf('if [ "${RESUME_AT_M7:-false}" = "true" ]; then\n  HEAD_OID');
    assert.ok(gate > 0 && resume > 0, "markers present");
    assert.ok(gate < resume, "IS_DEPLOY_GATE must be defined before the resume block");
  });

  it("forge#3728: every fence that reads IS_DEPLOY_GATE defines it first, identically", () => {
    const def = "IS_DEPLOY_GATE=$(bash \"$GATE_SCRIPT\"";
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

describe("forge#3753 deploy-gate base never reads forge.yaml from the PR worktree", () => {
  const review = readFileSync(join(ROOT, "commands/review-pr.md"), "utf8");
  const SCRIPT = join(ROOT, "scripts/resolve-deploy-gate.sh");
  it("no PWD-relative forge.yaml read feeds a gate decision", () => {
    for (const [name, text] of [["remediate", spec], ["review-pr", review]]) {
      assert.ok(!/\$\{FORGE_CONFIG:-forge\.yaml\}/.test(text), `${name}: cwd-relative forge.yaml read`);
      assert.ok(!/!= "main"/.test(text), `${name}: literal-main comparison`);
      assert.ok(text.includes("default_branch"), `${name}: GitHub default_branch`);
    }
  });
  it("every gate fence calls the trusted resolver and fails closed when unresolved", () => {
    for (const [name, text] of [["remediate", spec], ["review-pr", review]]) {
      const fences = text.split("```bash").slice(1).map((f) => f.split("```")[0]);
      const users = fences.filter((f) => /resolve-deploy-gate\.sh/.test(f));
      assert.ok(users.length >= (name === "remediate" ? 5 : 1), name);
      for (const f of users) {
        assert.ok(/else (IS_DEPLOY_GATE|PARK_GATE|GUARD_GATE)=true; fi/.test(f), `${name}: fail-closed fallback`);
        assert.ok(!/\$PWD\/scripts\/resolve-deploy-gate/.test(f), `${name}: repo-relative script`);
        assert.ok(!/"\$\{CLAUDE_PLUGIN_ROOT:-\}"/.test(f), `${name}: CLAUDE_PLUGIN_ROOT is substituted text, never an env var`);
        if (name === "remediate") {
          assert.ok(f.includes("type forge_resolve >/dev/null") && f.includes("forge_resolve resolve-deploy-gate.sh"), `${name}: gate fence must use the forge_resolve locator stub`);
        } else {
          assert.ok(f.includes("# FORGE_ROOT bootstrap"), `${name}: gate fence must use the canonical FORGE_ROOT bootstrap`);
        }
      }
    }
  });
  it("resolver executes: worktree forge.yaml release vs main stays strict", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "bin/gh"), '#!/usr/bin/env bash\ncase "$*" in *"--jq .default_branch"*) echo "${GH_DEFAULT_STUB:-}";; *) exit 1;; esac\n', { mode: 0o755 });
      writeFileSync(join(dir, "forge.yaml"), "branches:\n  default: release\n");
      const run = (base, def) => String(spawnSync("bash", [SCRIPT, base, "o/r"], { cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GH_DEFAULT_STUB: def } }).stdout).trim();
      assert.equal(run("main", "main"), "true");
      assert.equal(run("release", "main"), "false");
      assert.equal(run("staging", "main"), "false");
      assert.equal(run("master", "master"), "true");
      assert.equal(run("staging", ""), "true");
      assert.equal(run("", "main"), "true");
      assert.equal(run("null", "main"), "true");
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
