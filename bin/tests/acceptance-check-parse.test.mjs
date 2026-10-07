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
  .filter((l) => /^ {2}(TARGET|MATCHER)=\$\(|^ {2}\[ -z "\$(TARGET|MATCHER)" \]/.test(l))
  .join("\n");

function parse(checkLine) {
  const script = `check_line="$1"\n${extraction}\nprintf '%s\\n%s\\n' "$TARGET" "$MATCHER"`;
  const [target, matcher] = execFileSync("bash", ["-c", script, "x", checkLine], { encoding: "utf8" }).split("\n");
  return { target, matcher };
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
