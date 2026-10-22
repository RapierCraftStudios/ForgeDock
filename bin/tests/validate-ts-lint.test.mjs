// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** #4381: validate runs verification.commands.typescript.lint with the same output and timeout handling as typecheck. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./_tmp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPEC = fs.readFileSync(path.join(ROOT, "commands/work-on/build/validate.md"), "utf8");
const HAS_YQ = spawnSync("yq", ["--version"]).status === 0;
const TMP = tmpDir("validate-ts-lint-");
let n = 0;

/** The fenced bash block that follows `marker` in the spec. */
function block(marker) {
  const i = SPEC.indexOf(marker);
  assert.ok(i >= 0, `marker ${marker} not in validate.md`);
  const m = SPEC.slice(i).match(/```bash\n([\s\S]*?)```/);
  return m[1];
}
const RUNNER = block("Run after quality gate passes.");
const TS_BLOCK = block("**TypeScript**:");
const PY_BLOCK = block("**Python**:");

/** Run the TypeScript block in a throwaway repo whose forge.yaml declares `commands`; returns {out, vars}. */
function runTs(commands, env = {}) {
  const r = path.join(TMP, `repo${n++}`);
  fs.mkdirSync(r, { recursive: true });
  execFileSync("git", ["init", "-q", r]);
  const yaml = Object.entries(commands).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}\n`).join("");
  fs.writeFileSync(path.join(r, "forge.yaml"), `verification:\n  commands:\n    typescript:\n${yaml || "      format: \"\"\n"}`);
  const script = `${RUNNER}\n${TS_BLOCK.replaceAll("{WORKTREE_PATH}", r)}\necho "TS_LINT_EXIT=$TS_LINT_EXIT"\necho "SKIPPED_CHECKS=$SKIPPED_CHECKS"\n`;
  const p = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  const out = p.stdout + p.stderr;
  const vars = Object.fromEntries([...out.matchAll(/^(TS_LINT_EXIT|SKIPPED_CHECKS)=(.*)$/gm)].map((m) => [m[1], m[2]]));
  return { out, vars };
}

test("typescript.lint configured: validate runs it, prints its output and propagates the exit", { skip: !HAS_YQ && "yq not installed" }, () => {
  const ok = runTs({ typecheck: "true", lint: "echo LINT-RAN" });
  assert.match(ok.out, /LINT-RAN/);
  assert.equal(ok.vars.TS_LINT_EXIT, "0");
  assert.doesNotMatch(ok.vars.SKIPPED_CHECKS, /typescript\.lint/);
  const bad = runTs({ typecheck: "true", lint: "echo LINT-ERR; exit 3" });
  assert.match(bad.out, /LINT-ERR/);
  assert.equal(bad.vars.TS_LINT_EXIT, "3");
});

test("typescript.lint is bounded by the verification timeout exactly like typecheck", { skip: !HAS_YQ && "yq not installed" }, () => {
  const { out, vars } = runTs({ typecheck: "sleep 5", lint: "sleep 5" }, { FORGEDOCK_VERIFICATION_TIMEOUT_SECONDS: "1" });
  assert.match(out, /VERIFY-TIMEOUT \| HIGH \| typescript\.typecheck \| timed out after 1s/);
  assert.match(out, /VERIFY-TIMEOUT \| HIGH \| typescript\.lint \| timed out after 1s/);
  assert.equal(vars.TS_LINT_EXIT, "124");
});

test("typescript.lint absent: SKIPPED line and SKIPPED_CHECKS entry, as for the other TS steps", { skip: !HAS_YQ && "yq not installed" }, () => {
  const { out, vars } = runTs({ typecheck: "true" });
  assert.match(out, /SKIPPED — typescript\.lint not configured in verification\.commands/);
  assert.match(vars.SKIPPED_CHECKS, /typescript\.lint/);
  assert.equal(vars.TS_LINT_EXIT, "0");
});

test("the Python block is unchanged: it reads no python.lint slot", () => {
  assert.doesNotMatch(PY_BLOCK, /python\.lint/);
  assert.match(PY_BLOCK, /\.verification\.commands\.python\.format/);
});
