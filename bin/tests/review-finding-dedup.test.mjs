// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Field test (#3169): a security finding about the PR's own fix was deduped against the very issue
// the PR closes, so it ended up tracked nowhere. Every dedup pass in review-pr Phase 6C must exclude
// MERGE_ISSUE from its candidate set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const spec = readFileSync(join(root, "commands/review-pr.md"), "utf8");
// forge#3841: the 6C dedup passes (title dedup, line-range check) run in `review-finalize.sh file-prepare`; the spec keeps the filing call.
const finalize = readFileSync(join(root, "scripts/review-finalize.sh"), "utf8");

test("title dedup excludes the PR's own issue", () => {
  assert.match(finalize, /bash "\$DEDUP_SCRIPT" "\$ISSUE_TITLE" "-R \$REPO" \$\{MERGE_ISSUE:\+--exclude "\$MERGE_ISSUE"\}/);
});

test("line-range dedup skips the PR's own issue", () => {
  assert.match(finalize, /SELF="\$\{MERGE_ISSUE:-0\}"/);
  assert.match(finalize, /select\(\.number != \$self\) \| select\(\(\.body \/\/ ""\) \| contains\(\$file\)\)/);
});

test("/issue create forwards the exclusion", () => {
  assert.match(spec, /Skill\(skill="\{FORGE_SKILL_PREFIX\}issue", args="[^\n]*--exclude \\"\{MERGE_ISSUE\}\\"/);
});
