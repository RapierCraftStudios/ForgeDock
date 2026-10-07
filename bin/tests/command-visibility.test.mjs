// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps the `/` autocomplete menu to the commands an operator actually runs. Phase sub-skills
// (commands/<cmd>/**) are invoked by their parent via Skill(...) and declare `user-invocable: false`,
// which hides them from the menu without affecting Skill() invocation (verified on Claude Code 2.1.292).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), "../..", "commands");
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : n.endsWith(".md") ? [p] : [];
});
const frontmatter = (p) => (readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---\n/) || ["", ""])[1];
const hidden = (p) => /^user-invocable:\s*false\s*$/m.test(frontmatter(p));

test("every nested phase/sub-command is hidden from the / menu", () => {
  for (const f of walk(commandsDir)) {
    if (relative(commandsDir, f).includes("/")) assert.ok(hidden(f), `${relative(commandsDir, f)} must declare user-invocable: false`);
  }
});

test("operator entry points stay visible", () => {
  for (const name of ["orchestrate.md", "work-on.md", "review-pr.md", "quality-gate.md", "issue.md", "pipeline-health.md"]) {
    assert.ok(!hidden(join(commandsDir, name)), `${name} is an operator command and must stay in the / menu`);
  }
});
