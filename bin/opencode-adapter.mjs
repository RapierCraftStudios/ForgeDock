// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseInstallTier } from "./journey.mjs";

const COMMAND_SENTINEL = "<!-- forgedock:managed-opencode-command -->";
const PLUGIN_SENTINEL = "// forgedock:managed-opencode-plugin";
const LEGACY_SENTINEL = "<!-- ForgeDock managed";
const MANIFEST_VERSION = 1;

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function stripJsonc(raw) {
  let result = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      result += ch;
      i++;
      while (i < raw.length) {
        const stringChar = raw[i];
        result += stringChar;
        if (stringChar === "\\" && i + 1 < raw.length) {
          i++;
          result += raw[i];
        } else if (stringChar === '"') {
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i + 1 < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i + 1 < raw.length) i += 2;
      continue;
    }
    if (ch === ",") {
      let next = i + 1;
      while (/[\s]/.test(raw[next] || "")) next++;
      if (raw[next] === "}" || raw[next] === "]") {
        i++;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

export function shellPath(path, platform = process.platform) {
  const portable = portablePath(path);
  if (platform !== "win32") return portable;
  const drive = portable.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : portable;
}

function yamlString(value) {
  return JSON.stringify(value.replace(/[\r\n]+/g, " ").trim());
}

function parseDescription(content) {
  const frontmatter = content.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return "";
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^description:\s*(.*)$/);
    if (!match) continue;
    return match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return "";
}

function isLegacyCommandDefinition(name, definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return false;
  const keys = Object.keys(definition).sort();
  return (
    keys.length === 2 &&
    keys[0] === "description" &&
    keys[1] === "template" &&
    typeof definition.template === "string" &&
    definition.template.includes(`/commands/${name}.md`) &&
    String(definition.description || "").includes("ForgeDock")
  );
}

export function resolveOpenCodeConfigDir({ home, env = process.env } = {}) {
  const resolvedHome = home || env.HOME || env.USERPROFILE || homedir();
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), "opencode");
  return join(resolvedHome, ".config", "opencode");
}

export function renderOpenCodeCommand({ description, forgeHome, command }) {
  const specPath = portablePath(join(forgeHome, "commands", `${command}.md`));
  const commandsPath = portablePath(join(forgeHome, "commands"));
  return `---
description: ${yamlString(`ForgeDock: ${description}`)}
agent: build
---
${COMMAND_SENTINEL}

Run the authoritative ForgeDock workflow at \`${specPath}\` with these exact arguments:

$ARGUMENTS

Use \`read\` to load that spec, then execute it. Keep loading token-efficient: do not preload sibling specs, catalogs, adapters, or documentation.

OpenCode runtime mapping:

- \`Skill(skill="x", args="y")\` means lazily read \`${commandsPath}/\${x.replaceAll(":", "/")}.md\` and execute that workflow in the current context with the exact arguments. Colon separators become slash separators; existing slash separators remain unchanged. This matches Claude Code Skill's in-conversation loading; it is not a reason to spawn a subagent.
- \`Task(...)\` or a permitted \`Agent(...)\` means use OpenCode's \`task\` tool. Preserve requested isolation and parallelism, use \`general\` for implementation/review and \`explore\` for read-only discovery, and resume by task ID when requested. If background tasks are unavailable, launch independent foreground tasks concurrently where possible and use the workflow's GitHub-label polling fallback; never inline a required isolated review.
- Map Claude tool names to the corresponding OpenCode tools. Do not skip a step merely because its source uses Claude-style invocation syntax.
- OpenCode injects \`FORGE_HOME\` into shell commands through the ForgeDock plugin. GitHub labels, FORGE annotations, worktree isolation, and terminal-state rules remain unchanged.
- If a Claude-version, Claude-transcript, or Claude-cache rule has no OpenCode equivalent, ignore only that runtime-specific optimization and preserve the workflow invariant it was intended to protect.
`;
}

export function renderOpenCodePlugin(forgeHome) {
  const gitBashHome = shellPath(forgeHome, "win32");
  return `${PLUGIN_SENTINEL}
import { existsSync } from "node:fs"
import { join } from "node:path"

const NATIVE_FORGE_HOME = ${JSON.stringify(forgeHome)}
const GIT_BASH_FORGE_HOME = ${JSON.stringify(gitBashHome)}
let shellForgeHome = NATIVE_FORGE_HOME

export const ForgeDockPlugin = async () => ({
  config: async (config) => {
    if (config.subagent_depth === undefined) config.subagent_depth = 2
    if (process.platform === "win32" && !config.shell) {
      const candidates = [
        process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
      ].filter(Boolean)
      const gitBash = candidates.find((candidate) => existsSync(candidate))
      if (gitBash) config.shell = gitBash
    }
    if (/bash(?:\.exe)?$/i.test(String(config.shell || ""))) {
      shellForgeHome = GIT_BASH_FORGE_HOME
    }
  },
  "shell.env": async (_input, output) => {
    output.env.FORGE_HOME = shellForgeHome
    output.env.FORGE_RUNTIME = "opencode"
  },
})
`;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.forgedock.tmp-${process.pid}`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readManifest(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value?.version === MANIFEST_VERSION &&
      Array.isArray(value.files) &&
      value.files.every((file) => typeof file === "string") &&
      typeof value.digest === "string"
    ) return value;
  } catch {
    // A missing or malformed manifest means there are no trusted owned files.
  }
  return null;
}

function digestFiles(files) {
  return createHash("sha256")
    .update(
      [...files]
        .sort((a, b) => a.rel.localeCompare(b.rel))
        .map((item) => `${item.rel}\0${item.content}`)
        .join("\0"),
    )
    .digest("hex");
}

function pathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function isManagedFile(path) {
  try {
    const content = await readFile(path, "utf8");
    return content.includes(COMMAND_SENTINEL) || content.includes(PLUGIN_SENTINEL);
  } catch {
    return false;
  }
}

async function removeOwnedFiles(configDir, files) {
  let removed = 0;
  for (const rel of files) {
    const path = join(configDir, rel);
    if (!pathInside(configDir, path) || !(await isManagedFile(path))) continue;
    await unlink(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    removed++;
  }
  return removed;
}

async function discoverEntrypoints(forgeHome, includeExtras) {
  const commandsDir = join(forgeHome, "commands");
  const entries = await readdir(commandsDir, { withFileTypes: true });
  const commands = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const source = join(commandsDir, entry.name);
    const tier = parseInstallTier(source);
    if (tier === "internal" || (tier === "extras" && !includeExtras)) continue;
    const content = await readFile(source, "utf8");
    const description = parseDescription(content);
    if (!description) continue;
    commands.push({
      name: entry.name.slice(0, -3),
      description,
      tier,
    });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function migrateLegacyAdapter({ configDir, home }) {
  const resolvedHome = home || process.env.HOME || process.env.USERPROFILE || homedir();
  const legacyInstructions = join(resolvedHome, ".opencode-forge.md");
  const result = { removedInstructionsFile: false, removedConfigEntries: 0, warnings: [] };
  let legacyInstructionsOwned = false;
  try {
    const content = await readFile(legacyInstructions, "utf8");
    if (content.includes(LEGACY_SENTINEL)) {
      legacyInstructionsOwned = true;
    }
  } catch (error) {
    if (error.code !== "ENOENT") result.warnings.push(`Could not inspect ${legacyInstructions}: ${error.message}`);
  }

  const configPaths = new Set([
    join(resolvedHome, ".config", "opencode", "opencode.json"),
    join(configDir, "opencode.json"),
  ]);
  const legacyCommands = new Set(["work-on", "review-pr", "quality-gate", "orchestrate"]);
  const staged = [];
  let parseFailed = false;
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    let config;
    try {
      config = JSON.parse(stripJsonc(await readFile(configPath, "utf8")));
    } catch (error) {
      result.warnings.push(`Could not migrate legacy entries in ${configPath}: ${error.message}`);
      parseFailed = true;
      continue;
    }

    let changed = false;
    if (legacyInstructionsOwned && Array.isArray(config.instructions)) {
      const before = config.instructions.length;
      config.instructions = config.instructions.filter((item) => {
        if (typeof item !== "string") return true;
        return portablePath(resolve(item)) !== portablePath(resolve(legacyInstructions));
      });
      const removed = before - config.instructions.length;
      result.removedConfigEntries += removed;
      changed ||= removed > 0;
      if (config.instructions.length === 0) delete config.instructions;
    }
    if (config.command && typeof config.command === "object" && !Array.isArray(config.command)) {
      for (const name of legacyCommands) {
        const definition = config.command[name];
        if (isLegacyCommandDefinition(name, definition)) {
          delete config.command[name];
          result.removedConfigEntries++;
          changed = true;
        }
      }
      if (Object.keys(config.command).length === 0) delete config.command;
    }
    if (changed) {
      staged.push({
        path: configPath,
        original: await readFile(configPath, "utf8"),
        content: `${JSON.stringify(config, null, 2)}\n`,
      });
    }
  }
  if (parseFailed) return result;
  const written = [];
  try {
    for (const item of staged) {
      await atomicWrite(item.path, item.content);
      written.push(item);
    }
  } catch (error) {
    for (const item of written) await atomicWrite(item.path, item.original).catch(() => {});
    result.warnings.push(`Could not write legacy migration: ${error.message}`);
    return result;
  }
  if (legacyInstructionsOwned) {
    await unlink(legacyInstructions);
    result.removedInstructionsFile = true;
  }
  return result;
}

export async function installOpenCodeAdapter({
  forgeHome,
  home,
  env = process.env,
  includeExtras = false,
} = {}) {
  if (!forgeHome) throw new Error("forgeHome is required");
  if (!existsSync(join(forgeHome, "commands"))) {
    throw new Error(`ForgeDock commands directory not found: ${join(forgeHome, "commands")}`);
  }

  const configDir = resolveOpenCodeConfigDir({ home, env });
  const manifestPath = join(configDir, "forgedock", "manifest.json");
  const previous = (await readManifest(manifestPath)) || { files: [] };
  const commands = await discoverEntrypoints(forgeHome, includeExtras);
  const rendered = [];

  for (const command of commands) {
    const rel = portablePath(join("commands", "forge", `${command.name}.md`));
    const content = renderOpenCodeCommand({
      command: command.name,
      description: command.description,
      forgeHome,
    });
    rendered.push({ rel, content });
  }

  const pluginRel = portablePath(join("plugins", "forgedock.js"));
  const pluginContent = renderOpenCodePlugin(forgeHome);
  rendered.push({ rel: pluginRel, content: pluginContent });

  // Preflight every collision before the first write so a rejected install
  // cannot leave unmanifested command files behind.
  for (const item of rendered) {
    const path = join(configDir, item.rel);
    if (existsSync(path) && !(await isManagedFile(path))) {
      throw new Error(`Refusing to overwrite user-owned OpenCode file: ${path}`);
    }
  }
  for (const item of rendered) await atomicWrite(join(configDir, item.rel), item.content);

  const nextFiles = rendered.map((item) => item.rel).sort();
  const stale = previous.files.filter((file) => !nextFiles.includes(file));
  const removed = await removeOwnedFiles(configDir, stale);
  const digest = digestFiles(rendered);
  const manifest = {
    version: MANIFEST_VERSION,
    forgeHome,
    includeExtras,
    commandCount: commands.length,
    files: nextFiles,
    digest,
  };
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const migration = await migrateLegacyAdapter({ configDir, home });

  return { configDir, manifestPath, commandCount: commands.length, removed, digest, migration };
}

export async function getOpenCodeAdapterStatus({ home, env = process.env } = {}) {
  const configDir = resolveOpenCodeConfigDir({ home, env });
  const manifestPath = join(configDir, "forgedock", "manifest.json");
  if (!existsSync(manifestPath)) return { installed: false, healthy: false, configDir, missing: [] };
  const manifest = await readManifest(manifestPath);
  if (!manifest) {
    return { installed: true, healthy: false, configDir, missing: [], integrity: "invalid-manifest" };
  }
  const missing = [];
  const current = [];
  for (const rel of manifest.files) {
    const path = join(configDir, rel);
    if (!existsSync(path) || !(await isManagedFile(path))) {
      missing.push(rel);
      continue;
    }
    current.push({ rel, content: await readFile(path, "utf8") });
  }
  const integrity = missing.length === 0 && digestFiles(current) === manifest.digest;
  return {
    installed: true,
    healthy: missing.length === 0 && integrity,
    configDir,
    manifest,
    missing,
    integrity: integrity ? "valid" : "digest-mismatch",
  };
}

export async function uninstallOpenCodeAdapter({ home, env = process.env } = {}) {
  const configDir = resolveOpenCodeConfigDir({ home, env });
  const manifestPath = join(configDir, "forgedock", "manifest.json");
  const manifest = (await readManifest(manifestPath)) || { files: [] };
  const removed = await removeOwnedFiles(configDir, manifest.files);
  await unlink(manifestPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rmdir(join(configDir, "forgedock")).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
  const migration = await migrateLegacyAdapter({ configDir, home });
  return { configDir, removed, migration };
}
