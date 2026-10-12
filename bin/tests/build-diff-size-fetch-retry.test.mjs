import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const build = readFileSync(join(repoRoot, "commands/work-on/build.md"), "utf8");
const start = build.indexOf("## Phase B5.5");
const measure = build.indexOf("**Step 2 — measure.**", start);
const end = build.indexOf("**Step 3", measure);
const step1 = build.slice(measure, end);

test("B5.5 section is found", () => {
  assert.ok(start >= 0 && measure > start && end > measure);
});

test("base fetch is retried with 10s/30s/60s backoff and status captured", () => {
  assert.match(step1, /for _delay in 0 10 30 60/);
  assert.match(step1, /FETCH_OK=1/);
  assert.match(step1, /echo "FETCH_OK=\$\{FETCH_OK\}"/);
  assert.doesNotMatch(step1, /fetch origin[^\n]*\|\| true/);
});

test("failed fetch classifies as github-unavailable, conditioned on FETCH_OK=0", () => {
  assert.match(
    step1,
    /`FETCH_OK=0`[^\n]*github-unavailable: could not fetch origin\/\{PR_BASE\} for scope measurement/,
  );
});

test("genuine script failure still blocks fail-closed, conditioned on FETCH_OK=1", () => {
  assert.match(step1, /`FETCH_OK=1`[^\n]*\n?[^\n]*scope-check-unavailable: diff-size\.sh failed \(rc=<N>\)/);
  assert.match(step1, /do NOT treat an unmeasurable diff as in plan/i);
});
