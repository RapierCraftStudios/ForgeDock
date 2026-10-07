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

const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../..", "commands/review-pr.md"), "utf8");

test("title dedup excludes the PR's own issue", () => {
  assert.match(spec, /scripts\/issue-dedup\.sh "\$FINDING_TITLE_DEDUP" "\$GH_FLAG" \$\{MERGE_ISSUE:\+--exclude "\$MERGE_ISSUE"\}/);
});

test("line-range dedup skips the PR's own issue", () => {
  assert.match(spec, /select\(\.number != \$\{MERGE_ISSUE:-0\}\) \| select\(\.body \| test\(\\"\$\{FINDING_FILE\}\\"\)\)/);
});

test("/issue create forwards the exclusion", () => {
  assert.match(spec, /Skill\(skill="\{FORGE_SKILL_PREFIX\}issue", args="[^\n]*\$\{MERGE_ISSUE:\+--exclude \\"\$MERGE_ISSUE\\"\}"\)\)/);
});
