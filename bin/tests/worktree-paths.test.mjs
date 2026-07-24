import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const specs = [
  readFileSync(join(repoRoot, "commands/work-on.md"), "utf8"),
  readFileSync(join(repoRoot, "commands/work-on/build.md"), "utf8"),
];

test("worktree specs select a runtime-specific root", () => {
  for (const spec of specs) {
    assert.match(spec, /WORKTREE_ROOT=.*\.claude\/worktrees/);
    assert.match(spec, /FORGE_RUNTIME:-\}\" = \"opencode\"/);
    assert.match(spec, /\.opencode\/worktrees/);
    assert.match(spec, /FORGE_RUNTIME:-\}\" = \"codex\"/);
    assert.match(spec, /\.codex\/worktrees/);
    assert.match(spec, /WORKTREE_PATH=.*\$\{WORKTREE_ROOT\}/);
  }
});
