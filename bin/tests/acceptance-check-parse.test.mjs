// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the ACCEPTANCE_CHECK field-extraction lines exactly as written in build.md B6.5.
// Field test (#3167): a quote-bounded `[^"]*` extraction truncated matcher="return \"$HELD\""
// to `return \`, so a correct change failed the gate even after a repair round.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const build = readFileSync(join(root, "commands/work-on/build.md"), "utf8");
const extraction = build
  .split("\n")
  .filter((l) => /^ {2}(TARGET|MATCHER|PHASE)=\$\(|^ {2}\[ -z "\$(TARGET|MATCHER)" \]|^ {2}\[ "\$PHASE" = "review" \] \|\|/.test(l))
  .join("\n");

function parse(checkLine) {
  const script = `check_line="$1"\n${extraction}\nprintf '%s\\n%s\\n%s\\n' "$TARGET" "$MATCHER" "$PHASE"`;
  const [target, matcher, phase] = execFileSync("bash", ["-c", script, "x", checkLine], { encoding: "utf8" }).split("\n");
  return { target, matcher, phase };
}

test("extraction lines are present in build.md", () => {
  assert.ok(extraction.includes("TARGET=") && extraction.includes("MATCHER="));
});

test("escaped quotes inside a quoted matcher are kept and unescaped", () => {
  const r = parse('ACCEPTANCE_CHECK: id=ac-3 type=contains target="commands/x.md" matcher="return \\"$HELD\\"" description=hold');
  assert.equal(r.target, "commands/x.md");
  assert.equal(r.matcher, 'return "$HELD"');
});

test("single-quoted regex and escaped quotes inside a target", () => {
  assert.equal(parse("ACCEPTANCE_CHECK: id=ac-4 type=command target=\"grep -qE '(>= ?2|2\\+)' f.md\" matcher=\"exit_0\" description=c").target, "grep -qE '(>= ?2|2\\+)' f.md");
  assert.equal(parse('ACCEPTANCE_CHECK: id=ac-5 type=command target="grep -qF \\"a b\\" f.md" matcher="exit_0" description=c').target, 'grep -qF "a b" f.md');
});

test("unquoted fields still parse", () => {
  const r = parse("ACCEPTANCE_CHECK: id=ac-6 type=exists target=commands/x.md matcher=none description=y");
  assert.equal(r.target, "commands/x.md");
  assert.equal(r.matcher, "none");
});

// malformed-check (#3694): detector lines are extracted from build.md B6.5 and run verbatim.
const staticDetector = build
  .split("\n")
  .filter((l) => /^ {2}MALFORMED=""|^ {2}\{ \[ "\$TYPE" = "command" \]/.test(l))
  .join("\n");
const rcDetector = build
  .split("\n")
  .filter((l) => /^ {8}\[ "\$RC" -ge 2 \] && case/.test(l))
  .slice(0, 1)
  .join("\n");

function classify(target, type = "command") {
  const script = `TYPE="$1"; TARGET="$2"\n${staticDetector}\nif [ -z "$MALFORMED" ]; then ERR=$(eval "$TARGET" 2>&1 >/dev/null); RC=$?\n${rcDetector}\nfi\nprintf '%s' "$MALFORMED"`;
  return execFileSync("bash", ["-c", script, "x", type, target], { encoding: "utf8", cwd: root });
}

test("malformed-check detector lines are present in build.md", () => {
  assert.ok(staticDetector.includes("bash -n") && rcDetector.includes("grep usage error"));
});

test("malformed-check: #3621 ac-3 shape (over-escaped backslashes) is malformed", () => {
  const line = String.raw`ACCEPTANCE_CHECK: id=ac-3 type=command target="grep -qE 'breaker\\\\\|\\*' commands/orchestrate/phase-4-execution.md" matcher="exit_0" description=d`;
  const { target } = parse(line);
  assert.match(classify(target), /backslashes/);
});

test("malformed-check: #3723 shape (pattern starting with - read as an option, grep exit 2) is malformed", () => {
  assert.match(classify(String.raw`grep -qE "-z .\$DOMAIN_FILES_API" commands/review-pr.md`), /usage error/);
  assert.match(classify("grep -qE '--no-such-flag' commands/work-on/build.md"), /usage error/);
});

test("malformed-check: a missing operand file (grep exit 2) is a real failure, not malformed (SEC-1)", () => {
  assert.equal(classify("grep -qF -e 'x' commands/work-on/no-such-file-xyzzy.md"), "");
});

test("acceptance gate never posts PASSED with zero verified checks (SEC-2)", () => {
  assert.ok(build.includes('"$VERIFIED_COUNT" -eq 0') && build.includes("VERIFIED_COUNT=$((VERIFIED_COUNT+1))"));
});

test("malformed-check: unbalanced quotes are malformed", () => {
  assert.match(classify("grep -qF 'abc commands/work-on/build.md"), /syntax error/);
});

test("malformed-check: valid targets are not flagged, genuine exit 1 stays a failure", () => {
  assert.equal(classify("grep -qF -e 'malformed-check' commands/work-on/build.md"), "");
  assert.equal(classify("grep -qF -e 'no-such-string-xyzzy' commands/work-on/build.md"), "");
  assert.equal(classify("commands/work-on/build.md", "exists"), "");
});

// phase tag (#3793): deferral of review-phase checks.
test("phase=review is parsed and does not disturb target/matcher/description", () => {
  const r = parse('ACCEPTANCE_CHECK: id=ac-7 type=command target="gh pr view --json body --jq .body" matcher="time-to-clear|P95" phase=review description=PR body has distribution');
  assert.equal(r.phase, "review");
  assert.equal(r.target, "gh pr view --json body --jq .body");
  assert.equal(r.matcher, "time-to-clear|P95");
});

test("absent, unknown, or free-text phase= resolves to build (fail closed)", () => {
  assert.equal(parse('ACCEPTANCE_CHECK: id=ac-1 type=exists target="a.md" matcher="none" description=d').phase, "build");
  assert.equal(parse('ACCEPTANCE_CHECK: id=ac-1 type=exists target="a.md" matcher="none" phase=reviw description=d').phase, "build");
  assert.equal(parse('ACCEPTANCE_CHECK: id=ac-1 type=exists target="a.md" matcher="none" description=x phase=review y').phase, "build");
  assert.equal(parse('ACCEPTANCE_CHECK: id=ac-1 type=command target="echo phase=review" matcher="exit_0" description=d').phase, "build");
  assert.equal(parse("ACCEPTANCE_CHECK: id=ac-6 type=exists target=a.md matcher=none phase=review description=y").phase, "review");
});

test("build.md defers review checks and the legacy 'no pull requests found' result", () => {
  assert.ok(build.includes('"$PHASE" = "review"') && build.includes("DEFERRED (review)"));
  assert.ok(build.includes("no pull requests found") && build.includes('"$DEFERRED_COUNT" -eq 0'));
});

test("review.md R2.5 evaluates deferred checks with its own marker and the same phase extraction", () => {
  const review = readFileSync(join(root, "commands/work-on/review.md"), "utf8");
  assert.ok(review.includes("## Phase R2.5") && review.includes("FORGE:ACCEPTANCE_GATE_REVIEW:FAILED"));
  assert.ok(!review.includes("FORGE:ACCEPTANCE_GATE -->") && !review.includes("FORGE:ACCEPTANCE_GATE:"));
  const phaseLine = build.split("\n").find((l) => /^ {2}PHASE=\$\(/.test(l));
  assert.ok(review.includes(phaseLine));
});
