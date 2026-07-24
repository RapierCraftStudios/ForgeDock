import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getOpenCodeAdapterStatus,
  installOpenCodeAdapter,
  renderOpenCodeCommand,
  resolveOpenCodeConfigDir,
  shellPath,
  uninstallOpenCodeAdapter,
} from "../opencode-adapter.mjs";

const roots = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function command(description, install = "core") {
  return `---\ndescription: ${description}\ninstall: ${install}\n---\n\n# Workflow\n`;
}

function fixture() {
  const forgeHome = temp("fd-opencode-source-");
  const home = temp("fd-opencode-home-");
  mkdirSync(join(forgeHome, "commands", "work-on"), { recursive: true });
  writeFileSync(join(forgeHome, "commands", "work-on.md"), command("Run one issue"));
  writeFileSync(join(forgeHome, "commands", "cleanup.md"), command("Clean state", "extras"));
  writeFileSync(join(forgeHome, "commands", "internal.md"), command("Internal", "internal"));
  writeFileSync(join(forgeHome, "commands", "catalog.md"), "# No frontmatter\n");
  writeFileSync(join(forgeHome, "commands", "work-on", "build.md"), command("Nested phase"));
  return { forgeHome, home };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode adapter", () => {
  it("resolves OpenCode config paths without touching opencode.json", () => {
    assert.equal(
      resolveOpenCodeConfigDir({ home: "/home/test", env: {} }),
      join("/home/test", ".config", "opencode"),
    );
    assert.equal(
      resolveOpenCodeConfigDir({ home: "/ignored", env: { XDG_CONFIG_HOME: "/xdg" } }),
      join(resolve("/xdg"), "opencode"),
    );
    assert.equal(
      resolveOpenCodeConfigDir({ home: "/ignored", env: { OPENCODE_CONFIG_DIR: "/custom" } }),
      resolve("/custom"),
    );
  });

  it("uses OpenCode arguments and lazy nested-spec loading", () => {
    const output = renderOpenCodeCommand({
      description: "Run one issue",
      forgeHome: "C:\\Forge Dock",
      command: "work-on",
    });
    assert.match(output, /\$ARGUMENTS/);
    assert.doesNotMatch(output, /\{\{args\}\}/);
    assert.match(output, /do not preload sibling specs/i);
    assert.match(output, /C:\/Forge Dock\/commands\/work-on\.md/);
    assert.match(output, /OpenCode's `task` tool/);
    assert.equal(shellPath("C:\\Forge Dock\\commands", "win32"), "/c/Forge Dock/commands");
  });

  it("installs only top-level core entrypoints by default", async () => {
    const { forgeHome, home } = fixture();
    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    const config = join(home, ".config", "opencode");

    assert.equal(result.commandCount, 1);
    assert.ok(existsSync(join(config, "commands", "forge", "work-on.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "cleanup.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "internal.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "build.md")));
    assert.ok(existsSync(join(config, "plugins", "forgedock.js")));
    assert.ok(existsSync(join(config, "forgedock", "manifest.json")));
    assert.ok(!existsSync(join(config, "opencode.json")));

    const installedCommand = readFileSync(
      join(config, "commands", "forge", "work-on.md"),
      "utf8",
    );
    assert.match(installedCommand, /commands\/work-on\.md/);
    assert.doesNotMatch(installedCommand, /undefined\.md/);

    const plugin = readFileSync(join(config, "plugins", "forgedock.js"), "utf8");
    assert.match(plugin, /NATIVE_FORGE_HOME/);
    assert.match(plugin, /GIT_BASH_FORGE_HOME/);
    assert.match(plugin, /output\.env\.FORGE_HOME = shellForgeHome/);
    assert.match(plugin, /subagent_depth === undefined/);
    assert.doesNotMatch(plugin, /current < 2/);
    assert.match(plugin, /\/.*fd-opencode-source-/);
    assert.match(plugin, /Git.*bin.*bash\.exe/);
  });

  it("installs extras only when requested and prunes them on downgrade", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");

    const extras = await installOpenCodeAdapter({ forgeHome, home, env: {}, includeExtras: true });
    assert.equal(extras.commandCount, 2);
    assert.ok(existsSync(join(config, "commands", "forge", "cleanup.md")));

    const core = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(core.commandCount, 1);
    assert.equal(core.removed, 1);
    assert.ok(!existsSync(join(config, "commands", "forge", "cleanup.md")));
  });

  it("refuses to overwrite user-owned files", async () => {
    const { forgeHome, home } = fixture();
    const target = join(home, ".config", "opencode", "commands", "forge", "work-on.md");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "user command\n");

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /Refusing to overwrite user-owned OpenCode file/,
    );
    assert.equal(readFileSync(target, "utf8"), "user command\n");
  });

  it("preflights plugin collisions before writing commands", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const plugin = join(config, "plugins", "forgedock.js");
    mkdirSync(join(config, "plugins"), { recursive: true });
    writeFileSync(plugin, "export const UserPlugin = async () => ({})\n");

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /Refusing to overwrite user-owned OpenCode file/,
    );
    assert.ok(!existsSync(join(config, "commands", "forge", "work-on.md")));
    assert.equal(readFileSync(plugin, "utf8"), "export const UserPlugin = async () => ({})\n");
  });

  it("migrates only ForgeDock-managed legacy adapter entries", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      join(config, "opencode.json"),
      `${JSON.stringify({
        instructions: [legacyInstructions, "keep.md"],
        command: {
          "work-on": {
            description: "Run the ForgeDock full issue pipeline",
            template: `Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and run it`,
          },
          mine: { description: "User command", template: "Keep me" },
        },
        model: "test/model",
      }, null, 2)}\n`,
    );

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedInstructionsFile, true);
    assert.equal(result.migration.removedConfigEntries, 2);
    assert.ok(!existsSync(legacyInstructions));
    const migrated = JSON.parse(readFileSync(join(config, "opencode.json"), "utf8"));
    assert.deepEqual(migrated.instructions, ["keep.md"]);
    assert.equal(migrated.command["work-on"], undefined);
    assert.equal(migrated.command.mine.template, "Keep me");
    assert.equal(migrated.model, "test/model");
  });

  it("migrates JSONC configs before removing the managed instructions file", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed -->\nlegacy\n");
    writeFileSync(
      join(config, "opencode.json"),
      `{
        // Retained user setting
        "instructions": ["${legacyInstructions.replaceAll("\\", "\\\\")}"],
        "command": {
          "work-on": {
            "description": "Run the ForgeDock pipeline",
            "template": "Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md",
          },
        },
      }\n`,
    );

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedInstructionsFile, true);
    assert.equal(result.migration.removedConfigEntries, 2);
    assert.ok(!existsSync(legacyInstructions));
    const migrated = JSON.parse(readFileSync(join(config, "opencode.json"), "utf8"));
    assert.equal(migrated.instructions, undefined);
    assert.equal(migrated.command, undefined);
  });

  it("preserves legacy artifacts when JSONC migration cannot parse a config", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const configPath = join(config, "opencode.json");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed -->\nlegacy\n");
    const original = "{\n  // unterminated config\n  \"instructions\": [\n";
    writeFileSync(configPath, original);

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedInstructionsFile, false);
    assert.ok(existsSync(legacyInstructions));
    assert.equal(readFileSync(configPath, "utf8"), original);
  });

  it("preserves a user-owned legacy-named instructions file and reference", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "user-owned instructions\n");
    writeFileSync(
      join(config, "opencode.json"),
      `${JSON.stringify({ instructions: [legacyInstructions] }, null, 2)}\n`,
    );

    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.ok(existsSync(legacyInstructions));
    const migrated = JSON.parse(readFileSync(join(config, "opencode.json"), "utf8"));
    assert.deepEqual(migrated.instructions, [legacyInstructions]);
  });

  it("detects managed-file integrity drift", async () => {
    const { forgeHome, home } = fixture();
    const commandPath = join(home, ".config", "opencode", "commands", "forge", "work-on.md");
    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    writeFileSync(commandPath, `${readFileSync(commandPath, "utf8")}\nmodified\n`);

    const status = await getOpenCodeAdapterStatus({ home, env: {} });
    assert.equal(status.installed, true);
    assert.equal(status.healthy, false);
    assert.equal(status.integrity, "digest-mismatch");
  });

  it("reports malformed manifest file entries without crashing", async () => {
    const home = temp("fd-opencode-bad-manifest-");
    const manifestPath = join(home, ".config", "opencode", "forgedock", "manifest.json");
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ version: 1, files: [null], digest: "bad" })}\n`,
    );

    const status = await getOpenCodeAdapterStatus({ home, env: {} });
    assert.equal(status.installed, true);
    assert.equal(status.healthy, false);
    assert.equal(status.integrity, "invalid-manifest");
    const uninstall = await uninstallOpenCodeAdapter({ home, env: {} });
    assert.equal(uninstall.removed, 0);
  });

  it("reports health and uninstalls only managed files", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    const userFile = join(config, "commands", "mine.md");
    writeFileSync(userFile, "user command\n");

    const status = await getOpenCodeAdapterStatus({ home, env: {} });
    assert.equal(status.installed, true);
    assert.equal(status.healthy, true);

    const result = await uninstallOpenCodeAdapter({ home, env: {} });
    assert.equal(result.removed, 2);
    assert.ok(existsSync(userFile));
    assert.ok(!existsSync(join(config, "commands", "forge", "work-on.md")));
    assert.ok(!existsSync(join(config, "plugins", "forgedock.js")));
  });
});
