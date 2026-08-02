import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getOpenCodeAdapterStatus,
  installOpenCodeAdapter,
  renderOpenCodeCommand,
  renderOpenCodePlugin,
  renderOpenCodeSkill,
  normalizeOpenCodeSkillName,
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

function discoverOpenCodeSkills(config) {
  const root = join(config, "skills");
  const skills = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.name !== "SKILL.md") continue;
      const content = readFileSync(path, "utf8");
      const match = content.match(/^name:\s*(.+)$/m);
      if (match) skills.set(match[1].trim(), content);
    }
  };
  visit(root);
  return skills;
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
    assert.match(output, /DISPATCH_TOOL=task/);
    assert.match(output, /subagent_type: "general"\|"explore"/);
    assert.match(output, /genuinely absent.*FORGE:REVIEW_BLOCKED/s);
    assert.match(output, /top-level argument object shaped like/);
    assert.match(output, /general-purpose.*general.*codebase-explorer.*explore/s);
    assert.match(output, /Omitted `background` means foreground/i);
    assert.match(output, /child-session id/i);
    assert.match(output, /replace `needs-human` with `workflow:in-review`/);
    assert.equal(shellPath("C:\\Forge Dock\\commands", "win32"), "/c/Forge Dock/commands");
  });

  it("adds the compact preflight only to orchestration entrypoints", () => {
    const orchestrate = renderOpenCodeCommand({
      description: "Run orchestration",
      forgeHome: "/forge",
      command: "orchestrate",
    });
    assert.match(orchestrate, /orchestrate-preflight\.mjs/);
    assert.match(orchestrate, /dispatchNow/);
    assert.match(orchestrate, /requiresDeepPlan is false/);
    assert.match(orchestrate, /Pass raw GitHub issue-search URLs through unchanged/);
    assert.match(orchestrate, /configured-repository validation.*fail-closed diagnostics/s);
    assert.match(orchestrate, /do not load the full phase-3 or phase-4 files just to ask that question/i);

    const skill = renderOpenCodeSkill({
      description: "Run orchestration",
      forgeHome: "/forge",
      command: "orchestrate",
    });
    assert.match(skill, /node "\$FORGE_HOME\/bin\/orchestrate-preflight\.mjs"/);
    assert.match(skill, /task-result events/);
    assert.match(skill, /issue-search URL is a standing query.*after every ordinary task completion.*orchestration\.reresolve\.enabled.*orchestration\.reresolve\.max_rounds.*shared shouldReResolve policy.*re-run the same raw preflight input/s);
  });

  it("normalizes colon-qualified nested skill paths without changing other names", () => {
    const output = renderOpenCodeCommand({
      description: "Run one issue",
      forgeHome: "/forge",
      command: "work-on",
    });

    assert.match(output, /commands\/\$\{x\.replaceAll\(\":\", \"\/\"\)\}\.md/);
    assert.match(output, /native OpenCode skill named/);
    assert.match(output, /\$\{x\.replaceAll\(\":\", \"-\"\)\.replaceAll\(\"\/\", \"-\"\)\}/);
    assert.match(output, /Skill\(skill="x", args="y"\)/);

    for (const [skill, expected] of [
      ["work-on:close", "work-on/close"],
      ["work-on:build:context", "work-on/build/context"],
      ["review-pr", "review-pr"],
      ["work-on/build", "work-on/build"],
    ]) {
      assert.equal(skill.replaceAll(":", "/"), expected);
    }
    assert.equal(normalizeOpenCodeSkillName("work-on/investigate"), "work-on-investigate");
    assert.throws(
      () => normalizeOpenCodeSkillName(`${"a".repeat(65)}.md`),
      /exceeds 64 characters/,
    );
    const skillOutput = renderOpenCodeSkill({
      description: "Nested phase",
      forgeHome: "/forge",
      command: "work-on/build",
    });
    assert.match(skillOutput, /name: work-on-build/);
    assert.match(skillOutput, /DISPATCH_TOOL=task/);
    assert.match(skillOutput, /subagent_type: "general"\|"explore"/);
    assert.match(skillOutput, /native `task` is genuinely absent/);
    assert.match(skillOutput, /OpenCode sequential build dispatch/);
    assert.match(skillOutput, /Do not load either stage with the native `skill` tool/);
    assert.match(skillOutput, /background: false/);
    assert.match(skillOutput, /IMPLEMENT_RESULT/);
    assert.match(skillOutput, /VALIDATE_RESULT/);
  });

  it("keeps native review dispatch ahead of Claude availability checks", () => {
    const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
    for (const sourcePath of [
      "commands/review-pr.md",
      "commands/review-pr-staging.md",
      "commands/review-pr-agents.md",
    ]) {
      const source = readFileSync(join(root, sourcePath), "utf8");
      const nativeOverride = source.search(/OpenCode (Runtime )?Override|OpenCode override/);
      const hardStop = source.indexOf("Neither tool is available");
      assert.ok(nativeOverride >= 0, `${sourcePath} must document the native override`);
      assert.ok(hardStop < 0 || nativeOverride < hardStop, `${sourcePath} checks native dispatch before the hard stop`);
      assert.match(source, /DISPATCH_TOOL\s*[=:]\s*task/);
      assert.match(source, /subagent_type[^\n]+general/);
      assert.match(source, /subagent_type[^\n]+explore/);
      assert.match(source, /foreground|background: false/i);
      assert.doesNotMatch(source, /Use `background: true` for independent reviewers/);
    }
  });

  it("requires OpenCode review and remediation children to return joined results", () => {
    const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
    const review = readFileSync(join(root, "commands/work-on/review.md"), "utf8");
    const remediate = readFileSync(join(root, "commands/work-on/remediate.md"), "utf8");
    const execution = readFileSync(join(root, "commands/orchestrate/phase-4-execution.md"), "utf8");

    for (const [sourcePath, source] of [
      ["commands/work-on/review.md", review],
      ["commands/work-on/remediate.md", remediate],
    ]) {
      assert.match(source, /OpenCode joined-child contract/);
      assert.match(source, /background=false/);
      assert.match(source, /structured REVIEW_RESULT block/);
      assert.match(source, /Wait for (that task's completed|the completed child) result/);
      assert.match(source, /parseable `REVIEW_RESULT`/);
    }

    assert.match(execution, /Reconstruct the live map after compaction\/restart/);
    assert.match(execution, /OPENCODE_DISPATCH_MAP\["\$NUM"\]="\$TASK_ID"/);
    assert.match(execution, /until the terminal `FORGE:DISPATCH` record.*release capacity/s);
  });

  it("installs top-level commands and every eligible workflow as native skills", async () => {
    const { forgeHome, home } = fixture();
    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    const config = join(home, ".config", "opencode");

    assert.equal(result.commandCount, 1);
    assert.equal(result.skillCount, 2);
    assert.ok(existsSync(join(config, "commands", "forge", "work-on.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "cleanup.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "internal.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "build.md")));
    assert.ok(existsSync(join(config, "skills", "work-on", "SKILL.md")));
    assert.ok(existsSync(join(config, "skills", "work-on-build", "SKILL.md")));
    assert.ok(!existsSync(join(config, "skills", "cleanup", "SKILL.md")));
    assert.ok(!existsSync(join(config, "skills", "internal", "SKILL.md")));
    assert.ok(existsSync(join(config, "plugins", "forgedock.js")));
    assert.ok(existsSync(join(config, "forgedock", "manifest.json")));
    assert.ok(!existsSync(join(config, "opencode.json")));
    const manifest = JSON.parse(readFileSync(join(config, "forgedock", "manifest.json"), "utf8"));
    assert.equal(manifest.commandCount, 1);
    assert.equal(manifest.skillCount, 2);
    assert.ok(manifest.files.includes("skills/work-on/SKILL.md"));
    assert.ok(manifest.files.includes("skills/work-on-build/SKILL.md"));

    const installedCommand = readFileSync(
      join(config, "commands", "forge", "work-on.md"),
      "utf8",
    );
    assert.match(installedCommand, /commands\/work-on\.md/);
    assert.doesNotMatch(installedCommand, /undefined\.md/);

    const skills = discoverOpenCodeSkills(config);
    assert.deepEqual([...skills.keys()].sort(), ["work-on", "work-on-build"]);
    assert.match(skills.get("work-on-build"), /source: "work-on\/build"/);
    assert.match(skills.get("work-on-build"), /FORGE_OPENCODE_CAPABILITY_ERROR/);
    assert.match(skills.get("work-on-build"), /Do not invoke .*npx forgedock run-issue/);

    const plugin = readFileSync(join(config, "plugins", "forgedock.js"), "utf8");
    assert.match(plugin, /NATIVE_FORGE_HOME/);
    assert.match(plugin, /GIT_BASH_FORGE_HOME/);
    assert.match(plugin, /output\.env\.FORGE_HOME = shellForgeHome/);
    assert.match(plugin, /output\.env\.FORGE_RUNTIME = "opencode"/);
    assert.match(plugin, /subagent_depth === undefined/);
    assert.match(plugin, /subagent_depth = 2/);
    assert.match(plugin, /OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS/);
    assert.match(plugin, /config\.agent\.general\.permission\.task/);
    assert.match(plugin, /normalizeTaskArgs\(output\?\.args\)/);
    assert.doesNotMatch(plugin, /current < 2/);
    assert.match(plugin, /\/.*fd-opencode-source-/);
    assert.match(plugin, /Git.*bin.*bash\.exe/);
  });

  it("enforces the OpenCode fallback guard in the generated plugin", async () => {
    const { forgeHome, home } = fixture();
    const pluginPath = join(home, "forgedock-plugin.mjs");
    writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
    const plugin = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
    const hooks = await plugin.ForgeDockPlugin();
    const defaultConfig = {};
    await hooks.config(defaultConfig);
    assert.equal(defaultConfig.subagent_depth, 2);
    assert.equal(defaultConfig.agent.general.permission.task, "allow");

    const explicitConfig = {
      subagent_depth: 2,
      permission: { task: "deny" },
    };
    await hooks.config(explicitConfig);
    assert.equal(explicitConfig.subagent_depth, 2);
    assert.equal(explicitConfig.permission.task, "deny");

    const blocked = [
      "claude --print workflow",
      "forgedock run-issue 42 --lane staging",
      "npx --yes forgedock run-issue 42 --lane staging",
      "FORGE_RUNTIME=opencode opencode run --command forge/work-on 42",
      "echo ready && npx forgedock run-issue 42 --lane staging",
      "C:\\tools\\claude.exe --print workflow",
    ];

    for (const command of blocked) {
      await assert.rejects(
        hooks["tool.execute.before"]({ tool: "bash" }, { args: { command } }),
        (error) => error.code === "FORGE_OPENCODE_CAPABILITY_ERROR" &&
          error.message.startsWith("FORGE_OPENCODE_CAPABILITY_ERROR:"),
        command,
      );
    }

    await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "git status --short" } });
    await hooks["tool.execute.before"]({ tool: "read" }, { args: { command: "claude --print workflow" } });

    const shellOutput = { env: {} };
    await hooks["shell.env"]({}, shellOutput);
    assert.equal(shellOutput.env.FORGE_RUNTIME, "opencode");
  });

  it("requires and normalizes native task subagent types", async () => {
    const { forgeHome, home } = fixture();
    const pluginPath = join(home, "forgedock-task-plugin.mjs");
    writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
    const plugin = await import(`${pathToFileURL(pluginPath).href}?task-test=${Date.now()}`);
    const hooks = await plugin.ForgeDockPlugin();
    const dispatch = (args) => hooks["tool.execute.before"]({ tool: "task" }, { args });

    const implementation = { description: "implementation", prompt: "implement the fix", subagent_type: "general-purpose" };
    await dispatch(implementation);
    assert.equal(implementation.subagent_type, "general");
    assert.equal(implementation.background, false);

    const review = { description: "review", prompt: "review the change", subagent_type: "general", background: false };
    await dispatch(review);
    assert.equal(review.subagent_type, "general");
    assert.equal(review.background, false);

    const orchestration = { description: "orchestration", prompt: "dispatch an issue", subagent_type: "general", background: true };
    await dispatch(orchestration);
    assert.equal(orchestration.background, true);

    const discovery = { description: "discovery", prompt: "inspect callers", subagent_type: "codebase-explorer" };
    await dispatch(discovery);
    assert.equal(discovery.subagent_type, "explore");

    const missing = { description: "default", prompt: "use the safe default" };
    await dispatch(missing);
    assert.equal(missing.subagent_type, "general");
    assert.equal(missing.background, false);

    await assert.rejects(
      dispatch({ description: "invalid", prompt: "do not run", subagent_type: "unknown" }),
      (error) => error.code === "FORGE_OPENCODE_CAPABILITY_ERROR" &&
        error.message.includes("task subagent_type unknown is unsupported"),
    );
    await assert.rejects(
      dispatch(undefined),
      (error) => error.code === "FORGE_OPENCODE_CAPABILITY_ERROR" &&
        error.message.includes("task arguments are invalid"),
    );
  });

  it("preserves the explicit foreground opt-out", async () => {
    const { forgeHome, home } = fixture();
    const previous = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "false";
    try {
      const pluginPath = join(home, "forgedock-foreground-plugin.mjs");
      writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
      const plugin = await import(`${pathToFileURL(pluginPath).href}?foreground-test=${Date.now()}`);
      const hooks = await plugin.ForgeDockPlugin();
      const args = { description: "foreground", prompt: "run in degraded mode" };
      await hooks["tool.execute.before"]({ tool: "task" }, { args });
      assert.equal(args.subagent_type, "general");
      assert.equal(args.background, false);

      const explicitBackground = { description: "background", prompt: "must remain foreground", background: true };
      await hooks["tool.execute.before"]({ tool: "task" }, { args: explicitBackground });
      assert.equal(explicitBackground.background, false);

      const shellOutput = { env: {} };
      await hooks["shell.env"]({}, shellOutput);
      assert.equal(shellOutput.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "false");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previous;
    }
  });

  it("installs extras only when requested and prunes them on downgrade", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");

    const extras = await installOpenCodeAdapter({ forgeHome, home, env: {}, includeExtras: true });
    assert.equal(extras.commandCount, 2);
    assert.equal(extras.skillCount, 3);
    assert.ok(existsSync(join(config, "commands", "forge", "cleanup.md")));
    assert.ok(existsSync(join(config, "skills", "cleanup", "SKILL.md")));

    const core = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(core.commandCount, 1);
    assert.equal(core.skillCount, 2);
    assert.equal(core.removed, 2);
    assert.ok(!existsSync(join(config, "commands", "forge", "cleanup.md")));
    assert.ok(!existsSync(join(config, "skills", "cleanup", "SKILL.md")));
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

  it("refuses to overwrite a user-owned native skill", async () => {
    const { forgeHome, home } = fixture();
    const target = join(home, ".config", "opencode", "skills", "work-on", "SKILL.md");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "user skill\n");

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /Refusing to overwrite user-owned OpenCode file/,
    );
    assert.equal(readFileSync(target, "utf8"), "user skill\n");
    assert.ok(!existsSync(join(home, ".config", "opencode", "commands", "forge", "work-on.md")));
  });

  it("rejects normalized skill-name collisions before writing", async () => {
    const forgeHome = temp("fd-opencode-collision-source-");
    const home = temp("fd-opencode-collision-home-");
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a-b.md"), command("First"));
    writeFileSync(join(forgeHome, "commands", "a_b.md"), command("Second"));

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /OpenCode skill name collision: a-b maps both/,
    );
    assert.ok(!existsSync(join(home, ".config", "opencode", "commands")));
    assert.ok(!existsSync(join(home, ".config", "opencode", "skills")));
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

  it("refuses to write through symlinked managed directories", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const outside = temp("fd-opencode-symlink-target-");
    mkdirSync(config, { recursive: true });
    try {
      symlinkSync(outside, join(config, "skills"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) return;
      throw error;
    }

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /symlinked OpenCode path/,
    );
    assert.deepEqual(readdirSync(outside), []);
    assert.ok(!existsSync(join(config, "commands")));
  });

  it("rejects an active concurrent adapter operation", async () => {
    const { forgeHome, home } = fixture();
    const lockDir = join(home, ".config", "opencode", "forgedock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "install.lock"), "active\n");

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /Another OpenCode adapter operation is in progress/,
    );
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
            description: "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
            template: `Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and execute the pipeline for issue {{args}}.`,
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

  it("preserves customized legacy-named commands with ForgeDock-like content", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    mkdirSync(config, { recursive: true });
    const customCommand = {
      description: "Run the ForgeDock full issue pipeline with my confirmation step",
      template: `Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and ask for confirmation first`,
      customField: "keep this setting",
    };
    writeFileSync(
      join(config, "opencode.json"),
      `${JSON.stringify({ command: { "work-on": customCommand } }, null, 2)}\n`,
    );

    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    const migrated = JSON.parse(readFileSync(join(config, "opencode.json"), "utf8"));
    assert.deepEqual(migrated.command["work-on"], customCommand);
  });

  it("preserves two-key customized legacy-named commands", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    mkdirSync(config, { recursive: true });
    const customCommand = {
      description: "Run the ForgeDock full issue pipeline with my confirmation step",
      template: `Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and ask for confirmation first`,
    };
    const configPath = join(config, "opencode.json");
    const original = `${JSON.stringify({ command: { "work-on": customCommand } }, null, 2)}\n`;
    writeFileSync(configPath, original);

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedConfigEntries, 0);
    assert.equal(readFileSync(configPath, "utf8"), original);
  });

  it("preserves exact-looking legacy commands pointing at another absolute home", async () => {
    const { forgeHome, home } = fixture();
    const otherForgeHome = temp("fd-opencode-other-source-");
    const config = join(home, ".config", "opencode");
    mkdirSync(config, { recursive: true });
    const customCommand = {
      description: "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
      template: `Read ${otherForgeHome.replaceAll("\\", "/")}/commands/work-on.md and execute the pipeline for issue {{args}}.`,
    };
    const configPath = join(config, "opencode.json");
    const original = `${JSON.stringify({ command: { "work-on": customCommand } }, null, 2)}\n`;
    writeFileSync(configPath, original);

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedConfigEntries, 0);
    assert.equal(readFileSync(configPath, "utf8"), original);
  });

  it("preserves exact legacy commands without the managed instructions marker", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    mkdirSync(config, { recursive: true });
    const customCommand = {
      description: "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
      template: `Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and execute the pipeline for issue {{args}}.`,
    };
    const configPath = join(config, "opencode.json");
    const original = `${JSON.stringify({ command: { "work-on": customCommand } }, null, 2)}\n`;
    writeFileSync(configPath, original);

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedConfigEntries, 0);
    assert.equal(readFileSync(configPath, "utf8"), original);
  });

  it("preserves exact legacy commands with a malformed instructions marker", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    mkdirSync(config, { recursive: true });
    const malformedMarker = "<!-- ForgeDock managed by another tool -->\nuser content\n";
    writeFileSync(legacyInstructions, malformedMarker);
    const customCommand = {
      description: "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
      template: `Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and execute the pipeline for issue {{args}}.`,
    };
    const configPath = join(config, "opencode.json");
    const original = `${JSON.stringify({ command: { "work-on": customCommand } }, null, 2)}\n`;
    writeFileSync(configPath, original);

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedConfigEntries, 0);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(readFileSync(legacyInstructions, "utf8"), malformedMarker);
  });

  it("does not turn foreign mixed-separator paths into POSIX ForgeDock paths", async () => {
    if (process.platform === "win32") return;
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    mkdirSync(config, { recursive: true });
    const customCommand = {
      description: "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
      template: `Read ${forgeHome}\\commands/work-on.md and execute the pipeline for issue {{args}}.`,
    };
    const configPath = join(config, "opencode.json");
    const original = `${JSON.stringify({ command: { "work-on": customCommand } }, null, 2)}\n`;
    writeFileSync(configPath, original);

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedConfigEntries, 0);
    assert.equal(readFileSync(configPath, "utf8"), original);
  });

  it("migrates JSONC configs before removing the managed instructions file", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      join(config, "opencode.json"),
      `{
        // Retained user setting
        "instructions": ["${legacyInstructions.replaceAll("\\", "\\\\")}"],
        "command": {
          "work-on": {
            "description": "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
            "template": "Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and execute the pipeline for issue {{args}}.",
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

  it("does not rewrite opencode.jsonc during install or uninstall", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const configPath = join(config, "opencode.jsonc");
    mkdirSync(config, { recursive: true });
    const original = `{
      // User-owned JSONC config
      "model": "test/model",
      "command": {
        "work-on": {
          "description": "Run the ForgeDock pipeline",
          "template": "Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md",
        },
      },
    }\n`;
    writeFileSync(configPath, original);

    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(readFileSync(configPath, "utf8"), original);

    await uninstallOpenCodeAdapter({ home, env: {} });
    assert.equal(readFileSync(configPath, "utf8"), original);
  });

  it("preserves legacy artifacts when JSONC migration cannot parse a config", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const configPath = join(config, "opencode.json");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
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

  it("recognizes the sentinel-marked legacy adapter for generic update migration", async () => {
    const { home } = fixture();
    writeFileSync(
      join(home, ".opencode-forge.md"),
      "<!-- ForgeDock managed — do not remove this line -->\nlegacy adapter\n",
    );

    const status = await getOpenCodeAdapterStatus({ home, env: {} });
    assert.equal(status.installed, true);
    assert.equal(status.healthy, false);
    assert.equal(status.legacy, true);
    assert.equal(status.integrity, "legacy-adapter");
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

  it("does not inspect manifest entries outside the config directory", async () => {
    const home = temp("fd-opencode-status-home-");
    const outside = temp("fd-opencode-status-outside-");
    const config = join(home, ".config", "opencode");
    const outsideFile = join(outside, "managed.md");
    const rel = relative(config, outsideFile).replaceAll("\\", "/");
    mkdirSync(join(config, "forgedock"), { recursive: true });
    writeFileSync(outsideFile, "<!-- forgedock:managed-opencode-skill -->\n");
    writeFileSync(
      join(config, "forgedock", "manifest.json"),
      `${JSON.stringify({ version: 1, files: [rel], digest: "bad" })}\n`,
    );

    const status = await getOpenCodeAdapterStatus({ home, env: {} });
    assert.equal(status.healthy, false);
    assert.deepEqual(status.missing, [rel]);

    const uninstall = await uninstallOpenCodeAdapter({ home, env: {} });
    assert.equal(uninstall.removed, 0);
    assert.ok(existsSync(outsideFile));
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
    assert.equal(result.removed, 4);
    assert.ok(existsSync(userFile));
    assert.ok(!existsSync(join(config, "commands", "forge", "work-on.md")));
    assert.ok(!existsSync(join(config, "plugins", "forgedock.js")));
    assert.ok(!existsSync(join(config, "forgedock")));
  });

  it("preserves unmanifested files in the ForgeDock namespace", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    const userFile = join(config, "forgedock", "user-notes.txt");
    writeFileSync(userFile, "keep this file\n");

    await uninstallOpenCodeAdapter({ home, env: {} });

    assert.ok(existsSync(userFile));
    assert.ok(existsSync(join(config, "forgedock")));
  });
});
