import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const commandsDir = fileURLToPath(new URL("../../commands/", import.meta.url));

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

  it("resolver covers every runtime's install layout", () => {
    const t = readFileSync(join(commandsDir, "work-on.md"), "utf8");
    for (const re of [/forgedock:work-on:build/, /forge-work-on-build/, /`work-on:build`/, /work-on-build/, /FORGE_RUNTIME/, /nesting separator/i]) {
      assert.match(t, re);
    }
  });
});

// Install-layout checks: the names each installer actually registers must equal the names the resolver produces.
const nested = [];
for (const f of walk(commandsDir)) {
  const rel = f.slice(commandsDir.length, -3);
  if (rel.includes("/") && !rel.startsWith("review-pr-agents")) nested.push(rel);
}
const repoRoot = new URL("../../", import.meta.url).pathname;

describe("install layouts register the names the resolver produces", () => {
  it("has nested commands to test", () => {
    assert.ok(nested.includes("work-on/build"));
  });

  it("install.sh keeps commands/<a>/<b>.md as ~/.claude/commands/<a>/<b>.md (Claude names it <a>:<b>)", () => {
    const sh = readFileSync(join(repoRoot, "install.sh"), "utf8");
    assert.ok(sh.includes('rel="${cmd#"$FORGE_HOME/commands/"}"'));
    assert.match(sh, /mkdir -p/);
  });

  it("install-codex.sh maps nested paths to forge-<a>-<b>", () => {
    const sh = readFileSync(join(repoRoot, "install-codex.sh"), "utf8");
    assert.ok(sh.includes('name="${name//\\//-}"'));
    assert.match(sh, /printf 'forge-%s'/);
    for (const rel of nested) {
      const expected = `forge-${rel.replace(/\//g, "-")}`;
      assert.match(expected, /^forge-[a-z0-9.-]+$/);
    }
  });

  it("OpenCode adapter maps nested paths to <a>-<b>", async () => {
    const { normalizeOpenCodeSkillName } = await import("../opencode-adapter.mjs");
    assert.equal(normalizeOpenCodeSkillName("work-on/build.md"), "work-on-build");
    assert.equal(normalizeOpenCodeSkillName("work-on/build/validate.md"), "work-on-build-validate");
    assert.equal(normalizeOpenCodeSkillName("work-on.md"), "work-on");
  });

  it("repo-local Codex work-on override uses the forge- prefix", () => {
    const t = readFileSync(join(repoRoot, ".agents/skills/work-on/SKILL.md"), "utf8");
    assert.match(t, /forge-work-on-build/);
  });
});
