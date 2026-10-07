import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const commandsDir = new URL("../../commands/", import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

// A ForgeDock Skill call whose target is a bare (unprefixed) command name. Such calls fail under the plugin install,
// where the skills register as `forgedock:<name>`.
// Every command defined under commands/ (top-level files) is a ForgeDock skill.
const names = readdirSync(commandsDir)
  .filter((n) => n.endsWith(".md"))
  .map((n) => n.slice(0, -3));
const BARE = new RegExp(
  `Skill\\(\\s*(?:skill\\s*[:=]\\s*)?["'](?:${names.join("|")})(?:[/:][a-z-]+)*["']`,
);

describe("ForgeDock skill namespace resolution", () => {
  it("has no bare Skill(...) call to a ForgeDock phase skill in commands/", () => {
    const offenders = [];
    for (const f of walk(commandsDir)) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (BARE.test(line)) offenders.push(`${f.slice(commandsDir.length)}:${i + 1}`);
        });
    }
    assert.deepEqual(offenders, [], "use Skill(skill=\"{FORGE_SKILL_PREFIX}<name>\") instead");
  });

  it("documents the resolver and the hard-error rule in work-on.md", () => {
    const t = readFileSync(join(commandsDir, "work-on.md"), "utf8");
    assert.match(t, /### Skill Name Resolution/);
    assert.match(t, /FORGE_SKILL_NAMESPACE/);
    assert.match(t, /HARD ERROR/);
    assert.match(t, /NEVER fall back to running the phase inline/);
  });

  it("carries the hard-error rule in every 4A work-on dispatch template copy", () => {
    const t = readFileSync(join(commandsDir, "orchestrate/phase-4-execution.md"), "utf8");
    const mandatory = t.match(/You MUST use the Skill tool to invoke '\{FORGE_SKILL_PREFIX\}work-on'/g) ?? [];
    const hardErr = t.match(/HARD ERROR: STOP and report 'skill not found: \{FORGE_SKILL_PREFIX\}work-on'/g) ?? [];
    assert.ok(mandatory.length >= 2);
    assert.equal(hardErr.length, mandatory.length);
  });

  it("every file using the prefix either defines or points at the resolver", () => {
    for (const f of walk(commandsDir)) {
      const t = readFileSync(f, "utf8");
      if (!t.includes("{FORGE_SKILL_PREFIX}")) continue;
      assert.match(t, /Skill Name Resolution/, f);
    }
  });
});
