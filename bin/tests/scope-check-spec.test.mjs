// forge#3862: the post-build scope check replaces the size gate. These tests pin the spec contracts the
// pieces share: no post-build route to decompose, and the architect's PLANNED_FILES format being exactly what
// build B5.5 parses and scripts/diff-size.sh consumes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const build = read("commands/work-on/build.md");
const architect = read("commands/work-on/build/architect.md");

test("no post-build route to decompose remains in build.md, work-on.md or decompose.md", () => {
  for (const f of ["commands/work-on/build.md", "commands/work-on.md", "commands/work-on/decompose.md"]) {
    const t = read(f);
    assert.doesNotMatch(t, /NEEDS_DECOMPOSE/, f);
    assert.doesNotMatch(t, /forge\/wip\//, f);
  }
});

test("investigate.md has no line-count decomposition rule", () => {
  const t = read("commands/work-on/investigate.md");
  assert.doesNotMatch(t, /GATE_THRESHOLD|ESTIMATE_FACTOR|batch_seam_min|build\.diff_size/);
  assert.match(t, /separable/i);
});

test("B5.5 keeps SIZE_OVERRIDE handling and the FORGE:DIFF_SIZE record with diff_lines", () => {
  const b55 = build.slice(build.indexOf("## Phase B5.5"), build.indexOf("## Output"));
  assert.match(b55, /FORGE:SIZE_OVERRIDE/);
  assert.match(b55, /^diff_lines: \$\{DIFF_LINES\}$/m);
  for (const r of ["OK", "EXTENDED_REVIEW", "SCOPE_FLAGGED", "OVERRIDDEN"]) assert.ok(b55.includes(`\`${r}\``), r);
});

test("architect's Scope Baseline is parsed by the exact awk/sed in build B5.5", () => {
  assert.match(architect, /^PLANNED_FILES:$/m);
  assert.match(architect, /^ESTIMATED_DIFF_LINES: \{N\}$/m);
  const awk = /awk '(\/\^PLANNED_FILES:[^']*)'/.exec(build);
  assert.ok(awk, "build.md must carry the PLANNED_FILES awk");
  const body = "## Plan\n\n### Scope Baseline\nPLANNED_FILES:\n- a/b.md\n* `c/d.sh`\n- e/\n\nESTIMATED_DIFF_LINES: 321\n\n### Risk\n- not a file\n";
  const dir = mkdtempSync(join(tmpdir(), "scope-"));
  const plan = join(dir, "plan");
  const out = spawnSync("awk", [awk[1]], { input: body, encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "- a/b.md\n* `c/d.sh`\n- e/\n");
  writeFileSync(plan, out.stdout);
  const est = spawnSync("sed", ["-n", "s/^ESTIMATED_DIFF_LINES: *\\([0-9][0-9]*\\) *$/\\1/p"], { input: body, encoding: "utf8" });
  assert.equal(est.stdout.trim(), "321");
  // The skip marker's empty list parses to nothing (no plan baseline).
  const skip = spawnSync("awk", [awk[1]], { input: "### Scope Baseline\nPLANNED_FILES:\n\n<!-- FORGE:ARCHITECT:COMPLETE -->\n", encoding: "utf8" });
  assert.equal(skip.stdout, "");
});
