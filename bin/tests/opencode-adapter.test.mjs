import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, win32 } from "node:path";
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

function legacyCommand(name, forgeHome) {
  const contracts = {
    "work-on": {
      description: "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
      suffix: " and execute the pipeline for issue {{args}}.",
    },
    "review-pr": {
      description: "Run the ForgeDock PR review pipeline",
      suffix: " and execute the PR review for PR {{args}}.",
    },
    "quality-gate": {
      description: "Run ForgeDock pre-commit quality checks",
      suffix: " and run all quality gate checks.",
    },
    orchestrate: {
      description: "Run ForgeDock parallel multi-issue orchestration",
      suffix: " and orchestrate the issues: {{args}}.",
    },
  };
  return {
    description: contracts[name].description,
    template: `Read ${forgeHome.replaceAll("\\", "/")}/commands/${name}.md${contracts[name].suffix}`,
  };
}

function discoverOpenCodeSkills(config) {
  const root = join(config, "skills");
  const skills = new Map();
  if (!existsSync(root)) return skills;
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

function addNativeRuntime(forgeHome) {
  mkdirSync(join(forgeHome, "bin", "opencode"), { recursive: true });
  mkdirSync(join(forgeHome, "runtimes", "opencode", "work-on"), { recursive: true });
  writeFileSync(
    join(forgeHome, "bin", "opencode", "control.mjs"),
    `export async function runNativeWorkOn({ onSession }) {
      await onSession({ sessionID: "native-test-session", phase: "investigate", directory: "/repo" });
      return { status: "dry-run", issue: 1, repo: "acme/repo", sessions: [], totalPromptBytes: 1, mutations: [] };
    }
    export function formatNativeWorkOnResult(result) { return "work-on " + result.status; }
    `,
  );
  writeFileSync(
    join(forgeHome, "bin", "opencode", "orchestrator.mjs"),
    `export async function runNativeOrchestrate({ onSession }) {
      await onSession({ sessionID: "native-batch-session", phase: "investigate", directory: "/repo", issue: 2 });
      return { status: "dry-run", batchId: "batch-test", repo: "acme/repo", mutations: [] };
    }
    export function formatNativeOrchestrateResult(result) { return "orchestrate " + result.status; }
    `,
  );
  writeFileSync(
    join(forgeHome, "bin", "opencode", "github-auth.mjs"),
    `export const githubAuthRecovery = {
      shellOverrides() { return { GH_TOKEN: "", GITHUB_TOKEN: "" }; }
    };
    `,
  );
  writeFileSync(join(forgeHome, "runtimes", "opencode", "work-on", "common.md"), "native runtime\n");
}

function addPluginStub(home) {
  const moduleDir = join(home, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "package.json"), `${JSON.stringify({ type: "module", exports: "./index.js" })}\n`);
  writeFileSync(
    join(moduleDir, "index.js"),
    "export function tool(definition) { return definition; }\ntool.schema = { string() { return { type: 'string' }; } };\n",
  );
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
  addNativeRuntime(forgeHome);
  addPluginStub(home);
  return { forgeHome, home };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode adapter", () => {
  it("rejects a native source missing the GitHub authentication runtime", async () => {
    const { forgeHome, home } = fixture();
    rmSync(join(forgeHome, "bin", "opencode", "github-auth.mjs"));

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /OpenCode native runtime is incomplete/,
    );
  });

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
    assert.equal(
      resolveOpenCodeConfigDir({ home: "/home/test", env: { OPENCODE_CONFIG: "/custom/opencode.json" } }),
      join("/home/test", ".config", "opencode"),
    );
  });

  it("routes work-on directly to the native controller without loading Claude control prose", () => {
    const output = renderOpenCodeCommand({
      description: "Run one issue",
      forgeHome: "C:\\Forge Dock",
      command: "work-on",
    });
    assert.doesNotMatch(output, /\$ARGUMENTS/);
    assert.match(output, /FORGEDOCK_MANAGED_NATIVE_ARGUMENTS_WORK_ON/);
    assert.doesNotMatch(output, /\{\{args\}\}/);
    assert.match(output, /forge_work_on/);
    assert.match(output, /exactly once/);
    assert.match(output, /Do not read `commands\/work-on\.md`/);
    assert.doesNotMatch(output, /C:\/Forge Dock\/commands\/work-on\.md/);
    assert.doesNotMatch(output, /subagent_type|background=true|DISPATCH_TOOL/);
    assert.ok(Buffer.byteLength(output) < 1_500, "native entry command must remain compact");
    assert.equal(shellPath("C:\\Forge Dock\\commands"), "C:/Forge Dock/commands");
    assert.equal(shellPath("\\\\server\\share\\Forge Dock"), "//server/share/Forge Dock");
  });

  it("injects exact native command arguments through the generated plugin hook", async () => {
    const { forgeHome, home } = fixture();
    const pluginPath = join(home, "forgedock-command-hook-plugin.mjs");
    writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
    const plugin = await import(`${pathToFileURL(pluginPath).href}?command-hook-test=${Date.now()}`);
    const hooks = await plugin.ForgeDockPlugin({ client: {}, platform: "linux" });
    const begin = "<<<FORGEDOCK_RAW_ARGUMENTS_BEGIN>>>";
    const end = "<<<FORGEDOCK_RAW_ARGUMENTS_END>>>";
    const rawArguments = [
      '42 --title "quoted value"',
      String.raw`C:\repo\feature`,
      "line one\nline two",
      "$&",
      "$$",
      "$`",
      "$'",
      end,
    ].join("|");
    const nativeMarkers = new Set();

    for (const commandName of ["work-on", "orchestrate"]) {
      const template = renderOpenCodeCommand({
        description: "Native command",
        forgeHome: "/forge",
        command: commandName,
      });
      assert.doesNotMatch(template, /```json|argument object|\{\s*"arguments"\s*:/i);
      assert.doesNotMatch(template, /\$ARGUMENTS/);
      assert.ok(Buffer.byteLength(template) < 1_500);
      const marker = template.match(/<<<FORGEDOCK_MANAGED_NATIVE_ARGUMENTS_[A-Z_]+_[0-9A-F]+>>>/)?.[0];
      assert.ok(marker);
      nativeMarkers.add(marker);
      const untouchedPart = { type: "tool", tool: "example", state: { status: "pending" } };
      const output = {
        parts: [
          { type: "text", text: template },
          { type: "text", text: `duplicate:${marker}` },
          untouchedPart,
        ],
      };
      await hooks["command.execute.before"](
        { command: `forge/${commandName}`, sessionID: "command-test", arguments: rawArguments },
        output,
      );
      const rendered = output.parts[0].text;
      const payloadStart = rendered.indexOf(`${begin}\n`) + begin.length + 1;
      const payloadEnd = rendered.lastIndexOf(`\n${end}`);
      assert.ok(payloadStart >= begin.length + 1);
      assert.ok(payloadEnd >= payloadStart);
      assert.equal(rendered.slice(payloadStart, payloadEnd), rawArguments);
      assert.equal(output.parts[1].text, `duplicate:${rawArguments}`);
      assert.equal(output.parts[2], untouchedPart);

      for (const [command, text] of [
        ["forge/review-pr", template],
        ["toString", String({}.toString)],
        ["__proto__", String(Object.getPrototypeOf({}))],
      ]) {
        const unrelated = { parts: [{ type: "text", text }] };
        await hooks["command.execute.before"](
          { command, sessionID: "command-test", arguments: rawArguments },
          unrelated,
        );
        assert.equal(unrelated.parts[0].text, text);
      }
    }
    assert.equal(nativeMarkers.size, 2);
  });

  it("keeps native Windows imports and emits cross-shell paths for shell environments", () => {
    const forgeHome = "C:\\Forge Dock";
    const output = renderOpenCodePlugin(forgeHome);

    assert.ok(output.includes(`const NATIVE_FORGE_HOME = ${JSON.stringify(forgeHome)}`));
    assert.ok(output.includes('const SHELL_FORGE_HOME = "C:/Forge Dock"'));
    assert.match(output, /pathToFileURL\(join\(NATIVE_FORGE_HOME, "bin", "opencode", "control\.mjs"\)\)/);
    assert.match(output, /output\.env\.FORGE_HOME = SHELL_FORGE_HOME/);
    assert.doesNotMatch(output, /output\.env\.FORGE_HOME = NATIVE_FORGE_HOME/);
  });

  it("selects an installed Git Bash on Windows without overriding an explicit shell", async () => {
    const { forgeHome, home } = fixture();
    const pluginPath = join(home, "forgedock-shell-plugin.mjs");
    writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
    const plugin = await import(`${pathToFileURL(pluginPath).href}?shell-test=${Date.now()}`);
    const programFilesBash = win32.join("C:\\Program Files", "Git", "bin", "bash.exe");
    const localBash = win32.join("C:\\Users\\test\\AppData\\Local", "Programs", "Git", "bin", "bash.exe");
    const probes = [];
    const hooks = await plugin.ForgeDockPlugin({
      client: {},
      platform: "win32",
      environment: {
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
      fileExists: (candidate) => {
        probes.push(candidate);
        return candidate === localBash;
      },
    });

    const detected = {};
    await hooks.config(detected);
    assert.equal(detected.shell, localBash);
    assert.deepEqual(probes, [programFilesBash, localBash]);

    const explicit = { shell: "powershell.exe" };
    await hooks.config(explicit);
    assert.equal(explicit.shell, "powershell.exe");
    assert.deepEqual(probes, [programFilesBash, localBash]);

    const nonWindowsHooks = await plugin.ForgeDockPlugin({
      client: {},
      platform: "linux",
      environment: { ProgramFiles: "C:\\Program Files" },
      fileExists: () => true,
    });
    const nonWindows = {};
    await nonWindowsHooks.config(nonWindows);
    assert.deepEqual(nonWindows, {});
  });

  it("routes orchestration directly to the deterministic native scheduler", () => {
    const orchestrate = renderOpenCodeCommand({
      description: "Run orchestration",
      forgeHome: "/forge",
      command: "orchestrate",
    });
    assert.match(orchestrate, /forge_orchestrate/);
    assert.doesNotMatch(orchestrate, /spawns sub-agents/);
    assert.match(orchestrate, /confirmation-required/);
    assert.match(orchestrate, /Do not read .*commands\/orchestrate\.md/s);
    assert.doesNotMatch(orchestrate, /orchestrate-preflight\.mjs|background=true|task-result/);
    assert.ok(Buffer.byteLength(orchestrate) < 1_500);

    const skill = renderOpenCodeSkill({
      description: "Run orchestration",
      forgeHome: "/forge",
      command: "orchestrate",
    });
    assert.match(skill, /node "\$FORGE_HOME\/bin\/orchestrate-preflight\.mjs"/);
    assert.match(skill, /task-result events/);
  });

  it("keeps skill normalization for non-native workflows", () => {
    const output = renderOpenCodeCommand({
      description: "Review one PR",
      forgeHome: "/forge",
      command: "review-pr",
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
    assert.match(skillOutput, /Skill\(skill="work-on".*forge_work_on/s);
    assert.match(skillOutput, /Skill\(skill="orchestrate".*forge_orchestrate/s);
    assert.match(skillOutput, /Never lazily read `commands\/work-on\.md` or `commands\/orchestrate\.md`/);
    assert.match(skillOutput, /Any other `Skill\(skill="x", args="y"\)` means lazily read/);
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

  it("installs native control commands without main-workflow skills", async () => {
    const { forgeHome, home } = fixture();
    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    const config = join(home, ".config", "opencode");

    assert.equal(result.commandCount, 1);
    assert.equal(result.skillCount, 0);
    assert.ok(existsSync(join(config, "commands", "forge", "work-on.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "cleanup.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "internal.md")));
    assert.ok(!existsSync(join(config, "commands", "forge", "build.md")));
    assert.ok(!existsSync(join(config, "skills", "work-on", "SKILL.md")));
    assert.ok(!existsSync(join(config, "skills", "work-on-build", "SKILL.md")));
    assert.ok(!existsSync(join(config, "skills", "cleanup", "SKILL.md")));
    assert.ok(!existsSync(join(config, "skills", "internal", "SKILL.md")));
    assert.ok(existsSync(join(config, "plugins", "forgedock.js")));
    assert.ok(existsSync(join(config, "forgedock", "manifest.json")));
    assert.ok(!existsSync(join(config, "opencode.json")));
    const manifest = JSON.parse(readFileSync(join(config, "forgedock", "manifest.json"), "utf8"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.commandCount, 1);
    assert.equal(manifest.skillCount, 0);
    assert.ok(!manifest.files.some((file) => file.startsWith("skills/work-on")));

    const installedCommand = readFileSync(
      join(config, "commands", "forge", "work-on.md"),
      "utf8",
    );
    assert.match(installedCommand, /forge_work_on/);
    assert.match(installedCommand, /Do not read `commands\/work-on\.md`/);
    assert.doesNotMatch(installedCommand, /undefined\.md/);

    const skills = discoverOpenCodeSkills(config);
    assert.deepEqual([...skills.keys()], []);

    const plugin = readFileSync(join(config, "plugins", "forgedock.js"), "utf8");
    assert.match(plugin, /NATIVE_FORGE_HOME/);
    assert.match(plugin, /SHELL_FORGE_HOME/);
    assert.match(plugin, /GITHUB_AUTH_MODULE_URL/);
    assert.match(plugin, /forge_work_on: tool/);
    assert.match(plugin, /forge_orchestrate: tool/);
    assert.match(plugin, /nativeSessions\.has\(input\.sessionID\)/);
    assert.match(plugin, /output\.env\.FORGE_HOME = SHELL_FORGE_HOME/);
    assert.match(plugin, /output\.env\.FORGE_RUNTIME = "opencode"/);
    assert.match(plugin, /githubAuthRecovery\.shellOverrides/);
    assert.match(plugin, /OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS/);
    assert.doesNotMatch(plugin, /subagent_depth|config\.agent\.general|background subagents.*true/i);
    assert.ok(plugin.includes(JSON.stringify(forgeHome)));
  });

  it("injects workflow env broadly while scoping worker-only restrictions", async () => {
    const { forgeHome, home } = fixture();
    const pluginPath = join(home, "forgedock-plugin.mjs");
    writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
    const plugin = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
    const hooks = await plugin.ForgeDockPlugin({ client: {} });
    assert.equal(typeof hooks.config, "function");
    const metadata = [];
    await hooks.tool.forge_work_on.execute(
      { arguments: "1 --dry-run" },
      {
        directory: "/repo",
        abort: new AbortController().signal,
        metadata: (value) => metadata.push(value),
      },
    );
    assert.ok(metadata.length > 0);

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
        hooks["tool.execute.before"]({ tool: "bash", sessionID: "native-test-session" }, { args: { command } }),
        (error) => error.code === "FORGE_OPENCODE_CAPABILITY_ERROR" &&
          error.message.startsWith("FORGE_OPENCODE_CAPABILITY_ERROR:"),
        command,
      );
    }

    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "native-test-session" }, { args: { command: "git status --short" } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "unrelated" }, { args: { command: "claude --print workflow" } });

    const shellOutput = { env: {} };
    await hooks["shell.env"]({ sessionID: "native-test-session" }, shellOutput);
    assert.equal(shellOutput.env.FORGE_HOME, shellPath(forgeHome));
    assert.equal(shellOutput.env.FORGE_RUNTIME, "opencode");
    assert.equal(shellOutput.env.GH_TOKEN, "");
    assert.equal(shellOutput.env.GITHUB_TOKEN, "");
    assert.equal(shellOutput.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "false");
    const ordinaryShell = { env: {} };
    await hooks["shell.env"]({ sessionID: "ordinary-session" }, ordinaryShell);
    assert.deepEqual(ordinaryShell.env, {
      FORGE_HOME: shellPath(forgeHome),
      FORGE_RUNTIME: "opencode",
    });
  });

  it("denies recursive controllers and subagents inside native workers", async () => {
    const { forgeHome, home } = fixture();
    const pluginPath = join(home, "forgedock-task-plugin.mjs");
    writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
    const plugin = await import(`${pathToFileURL(pluginPath).href}?task-test=${Date.now()}`);
    const hooks = await plugin.ForgeDockPlugin({ client: {} });
    await hooks.tool.forge_work_on.execute(
      { arguments: "1 --dry-run" },
      { directory: "/repo", abort: new AbortController().signal, metadata: () => {} },
    );
    for (const toolName of ["task", "skill", "forge_work_on", "forge_orchestrate"]) {
      await assert.rejects(
        hooks["tool.execute.before"]({ tool: toolName, sessionID: "native-test-session" }, { args: {} }),
        (error) => error.code === "FORGE_OPENCODE_CAPABILITY_ERROR" && error.message.includes(toolName),
      );
    }
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "ordinary-session" }, { args: { background: true } });
  });

  it("does not mutate process-global background or agent settings", async () => {
    const { forgeHome, home } = fixture();
    const previous = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true";
    try {
      const pluginPath = join(home, "forgedock-foreground-plugin.mjs");
      writeFileSync(pluginPath, renderOpenCodePlugin(forgeHome));
      const plugin = await import(`${pathToFileURL(pluginPath).href}?foreground-test=${Date.now()}`);
      const hooks = await plugin.ForgeDockPlugin({ client: {}, platform: "linux" });
      assert.equal(typeof hooks.config, "function");
      const config = {};
      await hooks.config(config);
      assert.deepEqual(config, {});
      assert.equal(process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "true");
      const shellOutput = { env: {} };
      await hooks["shell.env"]({ sessionID: "ordinary-session" }, shellOutput);
      assert.deepEqual(shellOutput.env, {
        FORGE_HOME: shellPath(forgeHome),
        FORGE_RUNTIME: "opencode",
      });
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
    assert.equal(extras.skillCount, 1);
    assert.ok(existsSync(join(config, "commands", "forge", "cleanup.md")));
    assert.ok(existsSync(join(config, "skills", "cleanup", "SKILL.md")));

    const core = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(core.commandCount, 1);
    assert.equal(core.skillCount, 0);
    assert.equal(core.removed, 2);
    assert.ok(!existsSync(join(config, "commands", "forge", "cleanup.md")));
    assert.ok(!existsSync(join(config, "skills", "cleanup", "SKILL.md")));
  });

  it("routes native controllers from every installed non-native skill wrapper", async () => {
    const { forgeHome, home } = fixture();
    writeFileSync(join(forgeHome, "commands", "review-pr.md"), command("Review one PR"));
    const config = join(home, ".config", "opencode");

    await installOpenCodeAdapter({ forgeHome, home, env: {}, includeExtras: true });

    const skills = discoverOpenCodeSkills(config);
    assert.deepEqual([...skills.keys()].sort(), ["cleanup", "review-pr"]);
    for (const content of skills.values()) {
      assert.match(content, /Skill\(skill="work-on".*forge_work_on/s);
      assert.match(content, /Skill\(skill="orchestrate".*forge_orchestrate/s);
      assert.match(content, /Never lazily read `commands\/work-on\.md` or `commands\/orchestrate\.md`/);
      assert.match(content, /Any other `Skill\(skill="x", args="y"\)` means lazily read/);
    }
  });

  it("upgrades a v1 manifest and prunes the old main-workflow skill wrappers", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const staleSkill = join(config, "skills", "work-on", "SKILL.md");
    const manifestPath = join(config, "forgedock", "manifest.json");
    mkdirSync(join(staleSkill, ".."), { recursive: true });
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(staleSkill, "<!-- forgedock:managed-opencode-skill -->\nold wrapper\n");
    writeFileSync(manifestPath, `${JSON.stringify({
      version: 1,
      files: ["skills/work-on/SKILL.md"],
      digest: "legacy",
      includeExtras: false,
    })}\n`);

    await installOpenCodeAdapter({ forgeHome, home, env: {} });

    assert.ok(!existsSync(staleSkill));
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, 2);
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

  it("preserves a user-owned legacy work-on skill because the native controller no longer owns that path", async () => {
    const { forgeHome, home } = fixture();
    const target = join(home, ".config", "opencode", "skills", "work-on", "SKILL.md");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "user skill\n");

    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(readFileSync(target, "utf8"), "user skill\n");
    assert.ok(existsSync(join(home, ".config", "opencode", "commands", "forge", "work-on.md")));
  });

  it("rejects normalized skill-name collisions before writing", async () => {
    const forgeHome = temp("fd-opencode-collision-source-");
    const home = temp("fd-opencode-collision-home-");
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a-b.md"), command("First"));
    writeFileSync(join(forgeHome, "commands", "a_b.md"), command("Second"));
    addNativeRuntime(forgeHome);

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
      symlinkSync(outside, join(config, "commands"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) return;
      throw error;
    }

    await assert.rejects(
      installOpenCodeAdapter({ forgeHome, home, env: {} }),
      /symlinked OpenCode path/,
    );
    assert.deepEqual(readdirSync(outside), []);
    assert.ok(!existsSync(join(config, "plugins")));
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

  it("treats OPENCODE_CONFIG_DIR as additive during install and uninstall", async () => {
    const { forgeHome, home } = fixture();
    const selectedConfig = temp("fd-opencode-config-dir-");
    const env = { OPENCODE_CONFIG_DIR: selectedConfig, HOME: home };
    const defaultConfig = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    mkdirSync(defaultConfig, { recursive: true });
    const legacyConfig = {
      instructions: [legacyInstructions],
      command: { "work-on": legacyCommand("work-on", forgeHome) },
    };
    const defaultOriginal = `${JSON.stringify({ ...legacyConfig, model: "keep/default" }, null, 2)}\n`;
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(join(defaultConfig, "opencode.json"), defaultOriginal);
    writeFileSync(join(selectedConfig, "opencode.json"), `${JSON.stringify(legacyConfig, null, 2)}\n`);

    const result = await installOpenCodeAdapter({ forgeHome, env });

    assert.equal(result.configDir, resolve(selectedConfig));
    assert.equal(result.migration.removedConfigEntries, 2);
    assert.equal(result.migration.removedInstructionsFile, false);
    assert.ok(existsSync(legacyInstructions));
    assert.equal(readFileSync(join(defaultConfig, "opencode.json"), "utf8"), defaultOriginal);
    assert.deepEqual(JSON.parse(readFileSync(join(selectedConfig, "opencode.json"), "utf8")), {});

    writeFileSync(join(selectedConfig, "opencode.json"), `${JSON.stringify(legacyConfig, null, 2)}\n`);
    const uninstall = await uninstallOpenCodeAdapter({ env });
    assert.equal(uninstall.migration.removedInstructionsFile, false);
    assert.equal(uninstall.migration.removedConfigEntries, 2);
    assert.ok(existsSync(legacyInstructions));
    assert.deepEqual(JSON.parse(readFileSync(join(selectedConfig, "opencode.json"), "utf8")), {});
    assert.equal(readFileSync(join(defaultConfig, "opencode.json"), "utf8"), defaultOriginal);
  });

  it("treats XDG_CONFIG_HOME/opencode as primary for status and uninstall", async () => {
    const { forgeHome, home } = fixture();
    const xdg = temp("fd-opencode-xdg-primary-");
    const config = join(xdg, "opencode");
    const configPath = join(config, "opencode.json");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const env = { HOME: home, XDG_CONFIG_HOME: xdg };
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        instructions: [legacyInstructions],
        command: { "work-on": legacyCommand("work-on", forgeHome) },
      }, null, 2)}\n`,
    );

    const status = await getOpenCodeAdapterStatus({ env });
    assert.equal(status.configDir, config);
    assert.equal(status.legacy, true);
    assert.equal(status.integrity, "legacy-adapter");

    const result = await uninstallOpenCodeAdapter({ env });

    assert.equal(result.migration.removedConfigEntries, 2);
    assert.equal(result.migration.removedInstructionsFile, true);
    assert.ok(!existsSync(legacyInstructions));
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {});
    const after = await getOpenCodeAdapterStatus({ env });
    assert.equal(after.installed, false);
  });

  it("preserves the global sentinel when OPENCODE_CONFIG adds a custom file", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const configPath = join(config, "opencode.json");
    const additiveConfig = join(temp("fd-opencode-additive-file-"), "custom.json");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const env = { HOME: home, OPENCODE_CONFIG: additiveConfig };
    const additiveOriginal = `${JSON.stringify({ instructions: [legacyInstructions], model: "keep/custom" }, null, 2)}\n`;
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        instructions: [legacyInstructions],
        command: { "work-on": legacyCommand("work-on", forgeHome) },
      }, null, 2)}\n`,
    );
    writeFileSync(additiveConfig, additiveOriginal);

    const result = await installOpenCodeAdapter({ forgeHome, env });

    assert.equal(result.configDir, config);
    assert.equal(result.migration.removedConfigEntries, 2);
    assert.equal(result.migration.removedInstructionsFile, false);
    assert.ok(existsSync(legacyInstructions));
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {});
    assert.equal(readFileSync(additiveConfig, "utf8"), additiveOriginal);
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

  it("migrates exact forward-slash UNC commands against a native UNC manifest home", async () => {
    if (process.platform !== "win32") return;
    const { home } = fixture();
    const config = join(home, ".config", "opencode");
    const configPath = join(config, "opencode.json");
    const manifestPath = join(config, "forgedock", "manifest.json");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const nativeUncHome = "\\\\server\\share\\forgedock";
    const forwardUncHome = "//server/share/forgedock";
    const customizedReview = {
      description: "Run the ForgeDock PR review pipeline",
      template: `Read ${forwardUncHome}/commands/review-pr.md after asking for approval.`,
    };
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        instructions: [legacyInstructions],
        command: {
          "work-on": legacyCommand("work-on", forwardUncHome),
          "review-pr": customizedReview,
        },
      }, null, 2)}\n`,
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ version: 2, forgeHome: nativeUncHome, files: [], digest: "empty" })}\n`,
    );

    const result = await uninstallOpenCodeAdapter({ home, env: {} });

    assert.equal(result.migration.removedConfigEntries, 2);
    const migrated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(migrated.instructions, undefined);
    assert.equal(migrated.command["work-on"], undefined);
    assert.deepEqual(migrated.command["review-pr"], customizedReview);
  });

  it("keeps POSIX double-slash legacy homes case-sensitive", async () => {
    if (process.platform === "win32") return;
    const { home } = fixture();
    const config = join(home, ".config", "opencode");
    const configPath = join(config, "opencode.json");
    const manifestPath = join(config, "forgedock", "manifest.json");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const manifestHome = "//Server/share/forgedock";
    const commandDefinition = legacyCommand("work-on", "//server/share/forgedock");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        instructions: [legacyInstructions],
        command: { "work-on": commandDefinition },
      }, null, 2)}\n`,
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ version: 2, forgeHome: manifestHome, files: [], digest: "empty" })}\n`,
    );

    const result = await uninstallOpenCodeAdapter({ home, env: {} });

    assert.equal(result.migration.removedConfigEntries, 1);
    const migrated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(migrated.instructions, undefined);
    assert.deepEqual(migrated.command["work-on"], commandDefinition);
  });

  it("directly uninstalls only sentinel-owned exact legacy entries without a manifest", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const configPath = join(config, "opencode.json");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const customizedOrchestrate = {
      description: "Run ForgeDock parallel multi-issue orchestration",
      template: "Ask for my approval before orchestrating anything",
    };
    mkdirSync(config, { recursive: true });
    writeFileSync(
      legacyInstructions,
      "<!-- ForgeDock managed — do not remove this line -->\nFORGE_HOME=/untrusted/content/must-not-be-inferred\n",
    );
    writeFileSync(
      configPath,
      `${JSON.stringify({
        instructions: [legacyInstructions, "keep.md"],
        command: {
          "work-on": legacyCommand("work-on", forgeHome),
          "review-pr": legacyCommand("review-pr", forgeHome),
          "quality-gate": legacyCommand("quality-gate", forgeHome),
          orchestrate: customizedOrchestrate,
          mine: { description: "User command", template: "Keep me" },
        },
      }, null, 2)}\n`,
    );

    const result = await uninstallOpenCodeAdapter({ home, env: {} });

    assert.equal(result.removed, 0);
    assert.equal(result.migration.removedInstructionsFile, true);
    assert.equal(result.migration.removedConfigEntries, 4);
    assert.ok(!existsSync(legacyInstructions));
    const migrated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(migrated.instructions, ["keep.md"]);
    assert.equal(migrated.command["work-on"], undefined);
    assert.equal(migrated.command["review-pr"], undefined);
    assert.equal(migrated.command["quality-gate"], undefined);
    assert.deepEqual(migrated.command.orchestrate, customizedOrchestrate);
    assert.equal(migrated.command.mine.template, "Keep me");
  });

  it("surgically migrates JSONC while preserving comments, formatting, and mode", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const configPath = join(config, "opencode.json");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      configPath,
      `{
        // Retained user setting
        "model": "test/model", // keep this exact formatting
        "instructions": ["${legacyInstructions.replaceAll("\\", "\\\\")}"],
        "command": {
          // Retained custom command
          "mine": { "description": "User command", "template": "Keep me" },
          "work-on": {
            "description": "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
            "template": "Read ${forgeHome.replaceAll("\\", "/")}/commands/work-on.md and execute the pipeline for issue {{args}}.",
          },
        },
      }\n`,
    );
    if (process.platform !== "win32") chmodSync(configPath, 0o640);
    const originalMode = statSync(configPath).mode & 0o777;

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });
    assert.equal(result.migration.removedInstructionsFile, true);
    assert.equal(result.migration.removedConfigEntries, 2);
    assert.ok(!existsSync(legacyInstructions));
    const migrated = readFileSync(configPath, "utf8");
    assert.match(migrated, /        \/\/ Retained user setting/);
    assert.match(migrated, /"model": "test\/model",? \/\/ keep this exact formatting/);
    assert.match(migrated, /        \/\/ Retained custom command/);
    assert.match(migrated, /"mine": \{ "description": "User command", "template": "Keep me" \},/);
    assert.doesNotMatch(migrated, /"instructions"\s*:/);
    assert.doesNotMatch(migrated, /\.opencode-forge\.md/);
    assert.doesNotMatch(migrated, /"work-on"\s*:/);
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, originalMode);
  });

  it("creates migration temp files with the original restrictive mode", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const configPath = join(config, "opencode.json");
    const legacyInstructions = join(home, ".opencode-forge.md");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        instructions: [legacyInstructions],
        command: { "work-on": legacyCommand("work-on", forgeHome) },
      })}\n`,
    );
    if (process.platform !== "win32") chmodSync(configPath, 0o600);
    const originalMode = statSync(configPath).mode & 0o7777;
    const observedOptions = [];
    const originalWriteFile = fs.promises.writeFile;
    fs.promises.writeFile = async (path, content, options) => {
      if (String(path).includes("opencode.json.forgedock.tmp-")) observedOptions.push(options);
      return originalWriteFile(path, content, options);
    };
    syncBuiltinESMExports();
    try {
      await installOpenCodeAdapter({ forgeHome, home, env: {} });
    } finally {
      fs.promises.writeFile = originalWriteFile;
      syncBuiltinESMExports();
    }

    assert.equal(observedOptions.length, 1);
    assert.equal(observedOptions[0].flag, "wx");
    assert.equal(observedOptions[0].mode, originalMode);
  });

  it("preserves comments inside legacy containers after their managed entries are removed", async () => {
    const { forgeHome, home } = fixture();
    const config = join(home, ".config", "opencode");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const configPath = join(config, "opencode.json");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    writeFileSync(
      configPath,
      `{
  "instructions" /* Keep this instructions key comment */:
  // Keep this instructions value comment
  [
    // Keep this user note about future instructions
    "${legacyInstructions.replaceAll("\\", "\\\\")}",
  ],
  "command"
  /* Keep this command key comment */:
  // Keep this command value comment
  {
    // Keep this user note about future commands
    "work-on": ${JSON.stringify(legacyCommand("work-on", forgeHome))},
  },
}\n`,
    );

    const result = await installOpenCodeAdapter({ forgeHome, home, env: {} });

    assert.equal(result.migration.removedConfigEntries, 2);
    const migrated = readFileSync(configPath, "utf8");
    assert.match(migrated, /Keep this user note about future instructions/);
    assert.match(migrated, /Keep this user note about future commands/);
    assert.match(migrated, /Keep this instructions key comment/);
    assert.match(migrated, /Keep this instructions value comment/);
    assert.match(migrated, /Keep this command key comment/);
    assert.match(migrated, /Keep this command value comment/);
    assert.doesNotMatch(migrated, /"instructions"\s*:|"command"\s*:/);
    assert.doesNotMatch(migrated, /\.opencode-forge\.md|"work-on"\s*:/);
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

  it("preserves global legacy instructions when the selected default config path is unsafe", async () => {
    const { home } = fixture();
    const config = join(home, ".config", "opencode");
    const configPath = join(config, "opencode.json");
    const legacyInstructions = join(home, ".opencode-forge.md");
    const missingTarget = join(temp("fd-opencode-missing-config-"), "missing.json");
    mkdirSync(config, { recursive: true });
    writeFileSync(legacyInstructions, "<!-- ForgeDock managed — do not remove this line -->\nlegacy\n");
    try {
      symlinkSync(missingTarget, configPath, "file");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) return;
      throw error;
    }

    const result = await uninstallOpenCodeAdapter({ home, env: {} });

    assert.equal(result.migration.removedInstructionsFile, false);
    assert.ok(existsSync(legacyInstructions));
    assert.match(result.migration.warnings.join("\n"), /Could not safely inspect legacy entries/);
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

  it("reports a structurally valid v1 manifest as upgrade-required", async () => {
    const { forgeHome, home } = fixture();
    const manifestPath = join(home, ".config", "opencode", "forgedock", "manifest.json");
    await installOpenCodeAdapter({ forgeHome, home, env: {} });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const status = await getOpenCodeAdapterStatus({ home, env: {} });

    assert.equal(status.installed, true);
    assert.equal(status.healthy, false);
    assert.equal(status.integrity, "upgrade-required");
    assert.equal(status.manifest.version, 1);
    assert.deepEqual(status.missing, []);
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
      `${JSON.stringify({ version: 2, files: [rel], digest: "bad" })}\n`,
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
    assert.equal(result.removed, 2);
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
