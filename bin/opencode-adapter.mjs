// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { findMarkdownFiles } from "./journey.mjs";

const COMMAND_SENTINEL = "<!-- forgedock:managed-opencode-command -->";
const SKILL_SENTINEL = "<!-- forgedock:managed-opencode-skill -->";
const PLUGIN_SENTINEL = "// forgedock:managed-opencode-plugin";
const LEGACY_SENTINEL = "<!-- ForgeDock managed — do not remove this line -->";
const MANIFEST_VERSION = 2;
const SUPPORTED_MANIFEST_VERSIONS = new Set([1, MANIFEST_VERSION]);
const NATIVE_CONTROL_COMMANDS = new Set(["work-on", "orchestrate"]);
const NATIVE_ARGUMENT_MARKERS = {
  "work-on": "<<<FORGEDOCK_MANAGED_NATIVE_ARGUMENTS_WORK_ON_7A4D2C91>>>",
  orchestrate: "<<<FORGEDOCK_MANAGED_NATIVE_ARGUMENTS_ORCHESTRATE_5E8B3F60>>>",
};
const ADAPTER_LOCK_STALE_AGE_MS = 30_000;
const ADAPTER_LOCK_HEARTBEAT_MS = 10_000;
const ADAPTER_LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 150];
const LEGACY_COMMAND_CONTRACTS = {
  "work-on": {
    description: "Run the ForgeDock full issue pipeline (investigate \u2192 build \u2192 review \u2192 merge)",
    templateSuffix: " and execute the pipeline for issue {{args}}.",
  },
  "review-pr": {
    description: "Run the ForgeDock PR review pipeline",
    templateSuffix: " and execute the PR review for PR {{args}}.",
  },
  "quality-gate": {
    description: "Run ForgeDock pre-commit quality checks",
    templateSuffix: " and run all quality gate checks.",
  },
  orchestrate: {
    description: "Run ForgeDock parallel multi-issue orchestration",
    templateSuffix: " and orchestrate the issues: {{args}}.",
  },
};

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function legacyPathFlavor(path) {
  if (typeof path !== "string") return null;
  const windowsDrive = /^[A-Za-z]:[/\\]/.test(path);
  const windowsUnc = /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(path);
  if ((windowsDrive || (process.platform === "win32" && windowsUnc)) && win32.isAbsolute(path)) return "win32";
  if (posix.isAbsolute(path)) return "posix";
  if (win32.isAbsolute(path)) return "win32";
  return null;
}

function normalizeLegacyPath(path, flavor) {
  const pathFlavor = flavor || legacyPathFlavor(path);
  if (!pathFlavor) return null;
  const pathApi = pathFlavor === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(path)) return null;

  let normalized = pathApi.normalize(path);
  if (pathFlavor === "win32") {
    normalized = portablePath(normalized).toLowerCase();
  }
  if (normalized !== "/" && !/^[a-z]:\/$/i.test(normalized)) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return normalized;
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
      while (next < raw.length) {
        if (/\s/.test(raw[next])) {
          next++;
          continue;
        }
        if (raw[next] === "/" && raw[next + 1] === "/") {
          while (next < raw.length && raw[next] !== "\n") next++;
          continue;
        }
        if (raw[next] === "/" && raw[next + 1] === "*") {
          const end = raw.indexOf("*/", next + 2);
          next = end < 0 ? raw.length : end + 2;
          continue;
        }
        break;
      }
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

function parseJsoncAst(raw) {
  let offset = 0;

  const fail = (message) => {
    throw new Error(`${message} at offset ${offset}`);
  };
  const skipTrivia = () => {
    while (offset < raw.length) {
      if (/\s/.test(raw[offset])) {
        offset++;
        continue;
      }
      if (raw[offset] === "/" && raw[offset + 1] === "/") {
        offset += 2;
        while (offset < raw.length && raw[offset] !== "\n") offset++;
        continue;
      }
      if (raw[offset] === "/" && raw[offset + 1] === "*") {
        const end = raw.indexOf("*/", offset + 2);
        if (end < 0) fail("Unterminated block comment");
        offset = end + 2;
        continue;
      }
      break;
    }
  };
  const parseString = () => {
    const start = offset;
    if (raw[offset] !== '"') fail("Expected JSON string");
    offset++;
    while (offset < raw.length) {
      if (raw[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (raw[offset] === '"') {
        offset++;
        const source = raw.slice(start, offset);
        let value;
        try {
          value = JSON.parse(source);
        } catch (error) {
          throw new Error(`Invalid JSON string at offset ${start}: ${error.message}`);
        }
        return { type: "string", start, end: offset, value };
      }
      offset++;
    }
    fail("Unterminated JSON string");
  };
  const parseEntries = (type, closing) => {
    const entries = [];
    const keys = new Set();
    skipTrivia();
    if (raw[offset] === closing) {
      offset++;
      return entries;
    }
    while (offset < raw.length) {
      skipTrivia();
      let key;
      let start = offset;
      if (type === "object") {
        const keyNode = parseString();
        key = keyNode.value;
        start = keyNode.start;
        if (keys.has(key)) throw new Error(`Duplicate JSONC property ${JSON.stringify(key)} at offset ${start}`);
        keys.add(key);
        skipTrivia();
        if (raw[offset] !== ":") fail("Expected colon after JSON property");
        offset++;
      }
      const value = parseValue();
      const entry = { key, start, end: value.end, value, comma: null };
      entries.push(entry);
      skipTrivia();
      if (raw[offset] === ",") {
        entry.comma = offset;
        offset++;
        skipTrivia();
        if (raw[offset] === closing) {
          offset++;
          return entries;
        }
        continue;
      }
      if (raw[offset] !== closing) fail(`Expected comma or ${closing}`);
      offset++;
      return entries;
    }
    fail(`Unterminated JSON ${type}`);
  };
  const parseValue = () => {
    skipTrivia();
    const start = offset;
    if (raw[offset] === "{") {
      offset++;
      const entries = parseEntries("object", "}");
      return { type: "object", start, end: offset, entries };
    }
    if (raw[offset] === "[") {
      offset++;
      const entries = parseEntries("array", "]");
      return { type: "array", start, end: offset, entries };
    }
    if (raw[offset] === '"') return parseString();
    for (const token of ["true", "false", "null"]) {
      if (raw.startsWith(token, offset)) {
        offset += token.length;
        return { type: "literal", start, end: offset };
      }
    }
    const number = raw.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      offset += number[0].length;
      return { type: "number", start, end: offset };
    }
    fail("Expected JSON value");
  };

  const root = parseValue();
  skipTrivia();
  if (offset !== raw.length) fail("Unexpected content after JSON document");
  return root;
}

function objectEntryIndex(node, key) {
  if (node?.type !== "object") return -1;
  return node.entries.findIndex((entry) => entry.key === key);
}

function removalEditsForEntries(node, removedIndexes) {
  const edits = [];
  const hasTrailingComma = node.entries.length > 0 && node.entries.at(-1).comma !== null;
  for (let index = 0; index < node.entries.length; index++) {
    const entry = node.entries[index];
    const removed = removedIndexes.has(index);
    if (removed) edits.push({ start: entry.start, end: entry.end });
    if (entry.comma === null) continue;
    const retainedAfter = node.entries.some((_, later) => later > index && !removedIndexes.has(later));
    const originalTrailingComma = index === node.entries.length - 1;
    if (removed || (!retainedAfter && !originalTrailingComma && !hasTrailingComma)) {
      edits.push({ start: entry.comma, end: entry.comma + 1 });
    }
  }
  return edits;
}

function applyJsoncRemovalEdits(raw, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 0; index < ordered.length; index++) {
    const edit = ordered[index];
    if (edit.start < 0 || edit.end < edit.start || edit.end > raw.length) {
      throw new Error("Unsafe JSONC edit range");
    }
    if (index > 0 && edit.start < ordered[index - 1].end) {
      throw new Error("Overlapping JSONC edit ranges");
    }
  }
  let edited = raw;
  for (const edit of ordered.reverse()) {
    edited = edited.slice(0, edit.start) + (edit.replacement || "") + edited.slice(edit.end);
  }
  return edited;
}

function standaloneJsoncComments(raw, property) {
  const comments = [];
  let offset = property.start;
  const end = property.end;
  while (offset < end) {
    if (raw[offset] === '"') {
      offset++;
      while (offset < end) {
        if (raw[offset] === "\\") offset += 2;
        else if (raw[offset] === '"') {
          offset++;
          break;
        } else offset++;
      }
      continue;
    }
    if (raw[offset] === "/" && raw[offset + 1] === "/") {
      const start = offset;
      while (offset < end && raw[offset] !== "\n" && raw[offset] !== "\r") offset++;
      comments.push(raw.slice(start, offset));
      continue;
    }
    if (raw[offset] === "/" && raw[offset + 1] === "*") {
      const start = offset;
      const close = raw.indexOf("*/", offset + 2);
      if (close < 0 || close + 2 > end) throw new Error("Could not relocate unterminated JSONC comment");
      offset = close + 2;
      comments.push(raw.slice(start, offset));
      continue;
    }
    offset++;
  }
  if (comments.length === 0) return "";
  const lineStart = raw.lastIndexOf("\n", property.start - 1) + 1;
  const prefix = raw.slice(lineStart, property.start);
  const indentation = /^[\t ]*$/.test(prefix) ? prefix : "";
  return `${comments.join(`\n${indentation}`)}\n${indentation}`;
}

export function shellPath(path) {
  return portablePath(path);
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

/**
 * Map a source workflow path to OpenCode's native skill-name contract.
 * OpenCode skill names cannot contain path separators, so nested source paths
 * use a stable hyphen separator (for example, work-on/investigate).
 */
export function normalizeOpenCodeSkillName(command) {
  const name = portablePath(command)
    .replace(/\.md$/i, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-")
    .replace(/-{2,}/g, "-");
  if (!name) throw new Error(`Cannot register empty OpenCode skill name for workflow: ${command}`);
  if (name.length > 64) {
    throw new Error(`OpenCode skill name exceeds 64 characters for workflow: ${command}`);
  }
  return name;
}

function parseLegacyCommandDefinition(name, definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return null;
  const keys = Object.keys(definition).sort();
  const contract = LEGACY_COMMAND_CONTRACTS[name];
  if (
    !contract ||
    keys.length !== 2 ||
    keys[0] !== "description" ||
    keys[1] !== "template" ||
    definition.description !== contract.description ||
    typeof definition.template !== "string"
  ) return null;

  const template = portablePath(definition.template);
  const suffix = `/commands/${name}.md${contract.templateSuffix}`;
  if (!template.startsWith("Read ") || !template.endsWith(suffix)) return null;
  const templateHome = definition.template.slice("Read ".length, -suffix.length);
  const pathFlavor = legacyPathFlavor(templateHome);
  if (!pathFlavor) return null;
  const rawSuffix = definition.template.slice(-suffix.length);
  if (portablePath(rawSuffix) !== suffix || (pathFlavor === "posix" && rawSuffix !== suffix)) return null;
  const normalizedHome = normalizeLegacyPath(templateHome, pathFlavor);
  if (!normalizedHome) return null;
  return { home: templateHome, flavor: pathFlavor, normalizedHome };
}

function isLegacyCommandDefinition(name, definition, forgeHome) {
  const parsed = parseLegacyCommandDefinition(name, definition);
  const pathFlavor = legacyPathFlavor(forgeHome);
  if (!parsed || !pathFlavor || parsed.flavor !== pathFlavor) return false;
  return parsed.normalizedHome === normalizeLegacyPath(forgeHome, pathFlavor);
}

function inferLegacyForgeHome(command) {
  const candidates = new Map();
  for (const name of Object.keys(LEGACY_COMMAND_CONTRACTS)) {
    const parsed = parseLegacyCommandDefinition(name, command?.[name]);
    if (parsed) candidates.set(`${parsed.flavor}:${parsed.normalizedHome}`, parsed.home);
  }
  if (candidates.size !== 1) return { forgeHome: null, ambiguous: candidates.size > 1 };
  return { forgeHome: candidates.values().next().value, ambiguous: false };
}

function isLegacyInstructionsReference(value, legacyInstructions) {
  if (typeof value !== "string") return false;
  const pathFlavor = legacyPathFlavor(legacyInstructions);
  if (!pathFlavor || legacyPathFlavor(value) !== pathFlavor) return false;
  return normalizeLegacyPath(value, pathFlavor) === normalizeLegacyPath(legacyInstructions, pathFlavor);
}

function resolveOpenCodePrimaryConfigDir({ home, env = process.env } = {}) {
  const resolvedHome = home || env.HOME || env.USERPROFILE || homedir();
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), "opencode");
  return join(resolvedHome, ".config", "opencode");
}

export function resolveOpenCodeConfigDir({ home, env = process.env } = {}) {
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR);
  return resolveOpenCodePrimaryConfigDir({ home, env });
}

function openCodeReviewDispatchContract() {
  return [
    "OpenCode review-dispatch override:",
    "Before applying the workflow's Claude-specific Task/Agent availability check, treat an OpenCode runtime marker (`FORGE_RUNTIME=opencode`, `OPENCODE_SESSION_ID`, `OPENCODE_PID`, or `OPENCODE`) as native capability context and set `DISPATCH_TOOL=task`.",
    "Do not enter the `Neither tool is available` branch solely because Claude's literal `Task` and `Agent` names are absent. Every native task call must use `{ description: \"...\", prompt: \"...\", subagent_type: \"general\"|\"explore\", background }`; use `general` for implementation/review and `explore` for read-only discovery.",
    "Native tasks are foreground by default. Review, quality, remediation, and any other load-bearing child must await its completed task result and propagate its structured `*_RESULT` block before the parent continues. A progress message is not a result. `background: true` is reserved for the Phase 4 OpenCode ready-issue dispatcher, which persists the returned child-session id before handling its completion event.",
    "For a `work-on/remediate` task, preserve the remediation state transition: after FIXABLE classification, replace `needs-human` with `workflow:in-review`; restore `needs-human` only for a fresh block or an UNFIXABLE policy escalation. Never retain both labels during automated remediation or re-review.",
    "If lowercase native `task` is genuinely absent from the current tool registry, post `FORGE:REVIEW_BLOCKED` and stop; never replace the required isolated review with inline work or another controller.",
  ].join("\n");
}

function openCodeOrchestrateContract(forgeHome) {
  const preflightPath = portablePath(join(forgeHome, "bin", "orchestrate-preflight.mjs"));
  return [
    "OpenCode orchestration fast path:",
    `Before reading config.md, the authoritative workflow, or any phase file, run node "$FORGE_HOME/bin/orchestrate-preflight.mjs" --repo "$GH_REPO" --args "$ARGUMENTS" from the target repository and parse its JSON output. The installed implementation is ${preflightPath}. The helper resolves the repository from forge.yaml when GH_REPO is empty.`,
    "The preflight is deterministic and only handles issue resolution, eligibility filtering, explicit dependencies, scoped issue-body file overlap, database serialization, and the initial ready queue.",
    "When supported is true, requiresDeepPlan is false, and confirmed is true, launch dispatchNow immediately with native task calls using the exact work-on skill contract. Without explicit --auto or --confirm, present the compact plan and ask for one confirmation; after the user confirms, launch the plan's ready queue without re-reading the large phase files. Do not load the full phase-3 or phase-4 files just to ask that question.",
    "If requiresDeepPlan is true, the input is unsupported, preflight fails, or a task completion needs recovery, continue from the authoritative shared phase files. The fast path never closes, deduplicates, or edits issue bodies.",
    "Treat queued as deferred by the concurrency cap and use task-result events to dispatch the next ready issue. Keep the full shared workflow's labels, annotations, leases, and terminal-state rules.",
  ].join("\n");
}

function openCodeBuildStageContract(forgeHome) {
  const implementPath = portablePath(join(forgeHome, "commands", "work-on", "build", "implement.md"));
  const validatePath = portablePath(join(forgeHome, "commands", "work-on", "build", "validate.md"));
  return [
    "OpenCode sequential build dispatch:",
    "The B5 and B6 calls in the authoritative workflow are serialized control-flow boundaries. Do not load either stage with the native `skill` tool: that tool only injects instructions and does not return a child-session result to this dispatcher.",
    "For B5, call native `task` with `subagent_type: \"general\"` and `background: false`. Its prompt must load and execute `" + implementPath + "` with the exact build arguments, stage changes, and return only `IMPLEMENT_RESULT`. Wait for the completed task result before continuing.",
    "Parse `IMPLEMENT_RESULT` from the completed B5 task. Continue to B6 only for `COMPLETE` or `ALREADY_DONE`; preserve the workflow's existing terminal handling for every other status.",
    "For B6, call native `task` with `subagent_type: \"general\"` and `background: false`. Its prompt must load and execute `" + validatePath + "` with the worktree and B5 changed-file list, then return only `VALIDATE_RESULT`. Wait for completion before the acceptance gate.",
    "Foreground is the native default for every load-bearing child. Only the Phase 4 OpenCode ready-issue dispatcher uses `background: true`.",
  ].join("\n");
}

export function renderOpenCodeCommand({ description, forgeHome, command }) {
  if (NATIVE_CONTROL_COMMANDS.has(command)) {
    const toolName = command === "work-on" ? "forge_work_on" : "forge_orchestrate";
    const argumentMarker = NATIVE_ARGUMENT_MARKERS[command];
    const nativeDescription = command === "work-on"
      ? "Run one issue through the deterministic OpenCode-native ForgeDock pipeline"
      : "Plan and run deterministic OpenCode-native multi-issue orchestration";
    return [
      "---",
      `description: ${yamlString(`ForgeDock: ${nativeDescription}`)}`,
      "agent: build",
      "---",
      COMMAND_SENTINEL,
      "",
      `Call the native \`${toolName}\` tool exactly once. Set its \`arguments\` string to the exact raw text in the delimited payload below.`,
      "",
      "The payload starts after the next delimiter line and ends before the final delimiter line in this command. Exclude both delimiter lines.",
      "Do not parse, quote, unquote, escape, unescape, normalize, trim, or split the payload.",
      "",
      "<<<FORGEDOCK_RAW_ARGUMENTS_BEGIN>>>",
      argumentMarker,
      "<<<FORGEDOCK_RAW_ARGUMENTS_END>>>",
      "",
      "Do not read `commands/work-on.md`, `commands/orchestrate.md`, or any orchestration phase file.",
      "Do not use `task`, `skill`, Bash, `forgedock run-issue`, or `opencode run` as a substitute.",
      "The native tool owns phase selection, isolated sessions, retries, dependencies, and durable recovery.",
      command === "orchestrate"
        ? "If the tool reports `confirmation-required`, present its plan and authorization command, then stop. Never infer confirmation from conversational context."
        : "Return the native tool's terminal summary without starting another pipeline controller.",
    ].join("\n") + "\n";
  }
  const specPath = portablePath(join(forgeHome, "commands", `${command}.md`));
  const commandsPath = portablePath(join(forgeHome, "commands"));
  const nativeSkillExpression = '${x.replaceAll(":", "-").replaceAll("/", "-")}';
  const isOrchestrate = command === "orchestrate";
  return [
    "---",
    `description: ${yamlString(`ForgeDock: ${description}`)}`,
    "agent: build",
    "---",
    COMMAND_SENTINEL,
    "",
    (isOrchestrate
      ? "Run the OpenCode preflight before loading the authoritative ForgeDock workflow at `" + specPath + "` with these exact arguments:"
      : "Run the authoritative ForgeDock workflow at `" + specPath + "` with these exact arguments:"),
    "",
    "$ARGUMENTS",
    "",
    ...(isOrchestrate
      ? ["Do not use `read` to load the authoritative spec yet. Run the deterministic preflight first; only load the shared spec if the preflight requires the full workflow.", "", openCodeOrchestrateContract(forgeHome)]
      : ["Use `read` to load that spec, then execute it. Keep loading token-efficient: do not preload sibling specs, catalogs, adapters, or documentation."]),
    "",
    "OpenCode runtime mapping:",
    "",
    "- `Skill(skill=\"work-on\", args=\"y\")` and `Skill(skill=\"orchestrate\", args=\"y\")` route to the native `forge_work_on` and `forge_orchestrate` tools. Other `Skill(skill=\"x\", args=\"y\")` calls use the registered native OpenCode skill named `" + nativeSkillExpression + "` in the current context with the exact arguments. Their authoritative source is `" + commandsPath + "/${x.replaceAll(\":\", \"/\")}.md`. If the native skill or source is unavailable, stop with `FORGE_OPENCODE_CAPABILITY_ERROR` and an actionable path; never invoke `forgedock run-issue`, `npx forgedock run-issue`, or recursive `opencode run` as a fallback.",
    "- `Task(...)` or a permitted `Agent(...)` means use OpenCode's `task` tool with a top-level argument object shaped like `{ description: \"...\", prompt: \"...\", subagent_type: \"general\"|\"explore\", background }`. `subagent_type` is mandatory: map Claude `general-purpose` to `general` for implementation/review and `codebase-explorer` to `explore` for read-only discovery. If the source omits a type, set `subagent_type: \"general\"` before calling the tool; never emit a call containing only `description` and `prompt`. Omitted `background` means foreground and the parent must await the result. Set `background: true` only for Phase 4 OpenCode ready-issue dispatch after persisting its returned child-session id. Unsupported types must stop with `FORGE_OPENCODE_CAPABILITY_ERROR`. Preserve requested isolation and parallelism, and never inline a required isolated review.",
    openCodeReviewDispatchContract(),
    "- Map Claude tool names to the corresponding OpenCode tools. Do not skip a step merely because its source uses Claude-style invocation syntax.",
    "- OpenCode injects `FORGE_HOME` into shell commands through the ForgeDock plugin. GitHub labels, FORGE annotations, worktree isolation, and terminal-state rules remain unchanged.",
    "- If a Claude-version, Claude-transcript, or Claude-cache rule has no OpenCode equivalent, ignore only that runtime-specific optimization and preserve the workflow invariant it was intended to protect.",
  ].join("\n") + "\n";
}

export function renderOpenCodeSkill({ description, forgeHome, command }) {
  const specPath = portablePath(join(forgeHome, "commands", `${command}.md`));
  const commandsPath = portablePath(join(forgeHome, "commands"));
  const name = normalizeOpenCodeSkillName(command);
  const isOrchestrate = command === "orchestrate";
  return `---
name: ${name}
description: ${yamlString(`ForgeDock: ${description}`)}
compatibility: opencode
metadata:
  forgedock: "managed"
  source: ${yamlString(command)}
---
${SKILL_SENTINEL}

${isOrchestrate
  ? `Run the deterministic OpenCode preflight before loading the authoritative ForgeDock workflow at \`${specPath}\` in the current context.`
  : `Load and execute the authoritative ForgeDock workflow at \`${specPath}\` in the current context.`}

The parent workflow's exact arguments are already present in the current context. Preserve them; do not invent new arguments or launch a second controller. Keep loading token-efficient: ${isOrchestrate ? "do not read the shared orchestrate spec until preflight routes to the full workflow." : "read only this workflow and the next spec explicitly reached by its dispatcher."}

${command === "orchestrate" ? `${openCodeOrchestrateContract(forgeHome)}\n\n` : ""}${command === "work-on/build" ? `${openCodeBuildStageContract(forgeHome)}\n\n` : ""}${openCodeReviewDispatchContract()}

If the workflow source or a required native capability is unavailable, stop and report exactly:
\`FORGE_OPENCODE_CAPABILITY_ERROR\`: ForgeDock workflow \`${command}\` is unavailable at \`${specPath}\`.
Do not invoke \`forgedock run-issue\`, \`npx forgedock run-issue\`, or recursive \`opencode run\` to recover.
OpenCode runtime mapping:

- \`Skill(skill="work-on", args="y")\` means call native \`forge_work_on\` exactly once with its \`arguments\` string set to the exact raw \`y\` text. \`Skill(skill="orchestrate", args="y")\` means the same for native \`forge_orchestrate\`. Never lazily read \`commands/work-on.md\` or \`commands/orchestrate.md\` for either call, and do not parse, quote, or normalize \`y\`.
- Any other \`Skill(skill="x", args="y")\` means lazily read \`${commandsPath}/\${x.replaceAll(":", "/")}.md\` and execute that workflow in the current context with the exact arguments. Colon separators become slash separators; existing slash separators remain unchanged. This matches Claude Code Skill's in-conversation loading; it is not a reason to spawn a subagent.
- \`Task(...)\` or a permitted \`Agent(...)\` means use OpenCode's \`task\` tool with \`{ description, prompt, subagent_type, background }\`. Translate \`general-purpose\` to \`general\` and \`codebase-explorer\` to \`explore\`; never omit \`subagent_type\`. Omitted \`background\` is foreground and must be awaited. Only Phase 4 OpenCode ready-issue dispatch sets \`background: true\`; it persists the returned child-session id, then processes each later \`state="completed"\` or \`state="error"\` event independently.
- Map Claude tool names to the corresponding OpenCode tools. Do not skip a step merely because its source uses Claude-style invocation syntax.
- OpenCode injects \`FORGE_HOME\` into shell commands through the ForgeDock plugin. GitHub labels, FORGE annotations, worktree isolation, and terminal-state rules remain unchanged.
- If a Claude-version, Claude-transcript, or Claude-cache rule has no OpenCode equivalent, ignore only that runtime-specific optimization and preserve the workflow invariant it was intended to protect.
`;
}

export function renderOpenCodePlugin(forgeHome) {
  const shellForgeHome = shellPath(forgeHome);
  const runtimeGuard = String.raw`
const FORGE_OPENCODE_CAPABILITY_ERROR = "FORGE_OPENCODE_CAPABILITY_ERROR"

function commandPattern(executable, subcommand) {
  const assignments = "(?:(?:[A-Za-z_][A-Za-z0-9_]*)=(?:\"[^\"]*\"|'[^']*'|[^\\s;&|]+)\\s+)*"
  const wrappers = "(?:(?:env|command|exec)\\s+)*"
  const npx = "(?:npx(?:\\s+--[^\\s;&|]+)*\\s+)?"
  const path = "(?:(?:[^\\s;&|/\\\\]+[/\\\\])+)?"
  const suffix = subcommand ? "\\s+" + subcommand + "(?:\\s|$)" : "(?:\\s|$)"
  return new RegExp("(?:^|[;&|]\\s*)" + assignments + wrappers + npx + path + executable + "(?:\\.cmd|\\.exe)?" + suffix, "i")
}

function blockedOperation(command) {
  const normalized = String(command || "").replace(/\\r?\\n/g, " ")
  if (commandPattern("claude", "").test(normalized)) return "claude"
  if (commandPattern("forgedock", "run-issue").test(normalized)) return "forgedock run-issue"
  if (commandPattern("opencode", "run").test(normalized)) return "opencode run"
  return ""
}

function capabilityError(operation) {
  const error = new Error(FORGE_OPENCODE_CAPABILITY_ERROR + ": " + operation + " is unavailable in an OpenCode-native ForgeDock worker.")
  error.code = FORGE_OPENCODE_CAPABILITY_ERROR
  return error
}
`;
  return `${PLUGIN_SENTINEL}
import { existsSync } from "node:fs"
import { join, win32 } from "node:path"
import { pathToFileURL } from "node:url"
import { tool } from "@opencode-ai/plugin"

const NATIVE_FORGE_HOME = ${JSON.stringify(forgeHome)}
const SHELL_FORGE_HOME = ${JSON.stringify(shellForgeHome)}
const NATIVE_ARGUMENT_MARKERS = {
  "forge/work-on": ${JSON.stringify(NATIVE_ARGUMENT_MARKERS["work-on"])},
  "forge/orchestrate": ${JSON.stringify(NATIVE_ARGUMENT_MARKERS.orchestrate)},
}
const CONTROL_MODULE_URL = pathToFileURL(join(NATIVE_FORGE_HOME, "bin", "opencode", "control.mjs")).href
const ORCHESTRATOR_MODULE_URL = pathToFileURL(join(NATIVE_FORGE_HOME, "bin", "opencode", "orchestrator.mjs")).href
const nativeSessions = new Set()
let controlModule
let orchestratorModule
${runtimeGuard}

function compactMetadata(result) {
  return {
    status: result.status,
    issue: result.issue,
    batchId: result.batchId,
    repo: result.repo,
    terminalReason: result.terminalReason,
  }
}

export const ForgeDockPlugin = async ({
  client,
  platform = process.platform,
  environment = process.env,
  fileExists = existsSync,
}) => ({
  config: async (config) => {
    if (platform !== "win32" || config.shell !== undefined) return
    const candidates = [
      environment.ProgramFiles && win32.join(environment.ProgramFiles, "Git", "bin", "bash.exe"),
      environment.LOCALAPPDATA && win32.join(environment.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    ].filter(Boolean)
    const gitBash = candidates.find((candidate) => fileExists(candidate))
    if (gitBash) config.shell = gitBash
  },
  "command.execute.before": async (input, output) => {
    if (!Object.hasOwn(NATIVE_ARGUMENT_MARKERS, input.command)) return
    const marker = NATIVE_ARGUMENT_MARKERS[input.command]
    for (const part of output.parts) {
      if (part?.type === "text" && typeof part.text === "string") {
        part.text = part.text.replaceAll(marker, () => input.arguments)
      }
    }
  },
  tool: {
    forge_work_on: tool({
      description: "Run one issue through ForgeDock's deterministic OpenCode-native pipeline.",
      args: { arguments: tool.schema.string() },
      execute: async ({ arguments: args }, context) => {
        context.metadata({ title: "ForgeDock: resolving issue" })
        controlModule ||= import(CONTROL_MODULE_URL)
        const control = await controlModule
        const result = await control.runNativeWorkOn({
          client,
          cwd: context.directory,
          arguments: args,
          signal: context.abort,
          onSession: ({ sessionID }) => nativeSessions.add(sessionID),
          onProgress: (event) => context.metadata({
            title: event.phase ? "ForgeDock: " + event.phase : "ForgeDock: work-on",
            metadata: { event: event.event, phase: event.phase },
          }),
        })
        return {
          title: "ForgeDock work-on: " + result.status,
          output: control.formatNativeWorkOnResult(result),
          metadata: compactMetadata(result),
        }
      },
    }),
    forge_orchestrate: tool({
      description: "Plan and run ForgeDock's deterministic OpenCode-native multi-issue scheduler.",
      args: { arguments: tool.schema.string() },
      execute: async ({ arguments: args }, context) => {
        context.metadata({ title: "ForgeDock: compiling batch" })
        orchestratorModule ||= import(ORCHESTRATOR_MODULE_URL)
        const orchestrator = await orchestratorModule
        const result = await orchestrator.runNativeOrchestrate({
          client,
          cwd: context.directory,
          arguments: args,
          signal: context.abort,
          onSession: ({ sessionID }) => nativeSessions.add(sessionID),
          onProgress: (event) => context.metadata({
            title: event.issue
              ? "ForgeDock: #" + event.issue + (event.phase ? " " + event.phase : "")
              : "ForgeDock: orchestrate",
            metadata: { event: event.event, issue: event.issue, phase: event.phase },
          }),
        })
        return {
          title: "ForgeDock orchestrate: " + result.status,
          output: orchestrator.formatNativeOrchestrateResult(result),
          metadata: compactMetadata(result),
        }
      },
    }),
  },
  "tool.execute.before": async (input, output) => {
    if (!nativeSessions.has(input.sessionID)) return
    if (input.tool === "forge_work_on" || input.tool === "forge_orchestrate" || input.tool === "task" || input.tool === "skill") {
      throw capabilityError(input.tool)
    }
    if (input.tool !== "bash") return
    const operation = blockedOperation(output?.args?.command)
    if (operation) throw capabilityError(operation)
  },
  "shell.env": async (input, output) => {
    output.env.FORGE_HOME = SHELL_FORGE_HOME
    output.env.FORGE_RUNTIME = "opencode"
    if (nativeSessions.has(input.sessionID)) {
      output.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "false"
    }
  },
})
`;
}

function pathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertSafePath(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!pathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`Refusing to access path outside OpenCode config directory: ${candidate}`);
  }

  let current = resolvedCandidate;
  while (true) {
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing to access symlinked OpenCode path: ${current}`);
    }
    if (current === resolvedRoot) return;
    const parent = dirname(current);
    if (parent === current || !pathInside(resolvedRoot, parent)) {
      throw new Error(`Refusing to access path outside OpenCode config directory: ${candidate}`);
    }
    current = parent;
  }
}

async function isSafePath(root, candidate) {
  try {
    await assertSafePath(root, candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveSafePath(root, candidate, { createParent = false } = {}) {
  await assertSafePath(root, candidate);
  if (createParent) await mkdir(dirname(candidate), { recursive: true });
  await assertSafePath(root, candidate);

  let resolvedRoot;
  let resolvedParent;
  try {
    resolvedRoot = await realpath(resolve(root));
    resolvedParent = await realpath(dirname(candidate));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!pathInside(resolvedRoot, resolvedParent)) {
    throw new Error(`Refusing to access symlinked OpenCode path: ${dirname(candidate)}`);
  }

  const safeCandidate = join(resolvedParent, basename(candidate));
  let stat;
  try {
    stat = await lstat(safeCandidate);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to access symlinked OpenCode path: ${safeCandidate}`);
  }
  return { path: safeCandidate, root: resolvedRoot };
}

async function tryResolveSafePath(root, candidate) {
  try {
    return await resolveSafePath(root, candidate);
  } catch {
    return null;
  }
}

async function acquireAdapterLock(configDir) {
  const lockPath = join(configDir, "forgedock", "install.lock");
  const safeLock = await resolveSafePath(configDir, lockPath, { createParent: true });
  if (!safeLock) throw new Error(`Unable to resolve safe OpenCode lock path: ${lockPath}`);

  for (let attempt = 0; attempt <= ADAPTER_LOCK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return { handle: await open(safeLock.path, "wx"), path: safeLock.path };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let reclaimed = false;
      try {
        const stat = await lstat(safeLock.path);
        if (Date.now() - stat.mtimeMs >= ADAPTER_LOCK_STALE_AGE_MS) {
          const current = await lstat(safeLock.path);
          if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) {
            await unlink(safeLock.path);
            reclaimed = true;
          }
        }
      } catch {
        // The lock may have been released or replaced between checks.
      }
      if (reclaimed) continue;
      if (attempt === ADAPTER_LOCK_RETRY_DELAYS_MS.length) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, ADAPTER_LOCK_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw new Error("Another OpenCode adapter operation is in progress; try again shortly");
}

async function withAdapterLock(configDir, operation) {
  const lock = await acquireAdapterLock(configDir);
  const heartbeat = setInterval(() => {
    lock.handle.utimes(new Date(), new Date()).catch(() => {});
  }, ADAPTER_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await lock.handle.close().catch(() => {});
    await unlink(lock.path).catch(() => {});
    await rmdir(dirname(lock.path)).catch(() => {});
  }
}

async function atomicWrite(path, content, root, { preserveMode = false } = {}) {
  const safe = root ? await resolveSafePath(root, path, { createParent: true }) : null;
  if (root && !safe) throw new Error(`Unable to resolve safe OpenCode path: ${path}`);
  const target = safe?.path || path;
  if (!root) await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.forgedock.tmp-${process.pid}-${randomUUID()}`;
  try {
    let mode;
    if (preserveMode) {
      try {
        mode = (await lstat(target)).mode & 0o7777;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await writeFile(tmp, content, { encoding: "utf8", flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readManifest(path, root) {
  let target = path;
  if (root) {
    try {
      const safe = await resolveSafePath(root, path);
      if (!safe) return null;
      target = safe.path;
    } catch {
      return null;
    }
  }
  try {
    const raw = await readRegularFile(target);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (
      SUPPORTED_MANIFEST_VERSIONS.has(value?.version) &&
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

async function readRegularFile(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function hasManagedSentinel(content) {
  return content.includes(COMMAND_SENTINEL) || content.includes(SKILL_SENTINEL) || content.includes(PLUGIN_SENTINEL);
}

async function isManagedFile(path) {
  const content = await readRegularFile(path);
  return content !== null && hasManagedSentinel(content);
}

async function removeEmptyParentDirs(configDir, filePath) {
  const root = resolve(configDir);
  let directory = dirname(filePath);
  while (resolve(directory) !== root && pathInside(root, directory)) {
    await rmdir(directory).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    });
    directory = dirname(directory);
  }
}

async function removeOwnedFiles(configDir, files) {
  let removed = 0;
  for (const rel of files) {
    const path = join(configDir, rel);
    const safe = await tryResolveSafePath(configDir, path);
    if (!safe || !(await isManagedFile(safe.path))) continue;
    await unlink(safe.path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await removeEmptyParentDirs(safe.root, safe.path);
    removed++;
  }
  return removed;
}

async function discoverEntrypoints(forgeHome, includeExtras) {
  const commandsDir = join(forgeHome, "commands");
  const sources = await findMarkdownFiles(commandsDir, { includeExtras });
  const commands = [];
  const skillNames = new Map();
  for (const source of sources) {
    const sourcePath = portablePath(relative(commandsDir, source)).replace(/\.md$/i, "");
    const content = await readFile(source, "utf8");
    const description = parseDescription(content);
    if (!description) continue;
    const nativeName = normalizeOpenCodeSkillName(sourcePath);
    const existing = skillNames.get(nativeName);
    if (existing && existing !== sourcePath) {
      throw new Error(
        `OpenCode skill name collision: ${nativeName} maps both ${existing} and ${sourcePath}`,
      );
    }
    skillNames.set(nativeName, sourcePath);
    commands.push({
      name: sourcePath,
      nativeName,
      description,
      topLevel: !sourcePath.includes("/"),
    });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function editLegacyConfigJsonc(raw, { legacyInstructions, forgeHome }) {
  const config = JSON.parse(stripJsonc(raw));
  const ast = parseJsoncAst(raw);
  if (!config || typeof config !== "object" || Array.isArray(config) || ast.type !== "object") {
    return { content: raw, removed: 0, ambiguousHome: false };
  }

  let effectiveForgeHome = forgeHome;
  let ambiguousHome = false;
  if (
    !effectiveForgeHome &&
    config.command &&
    typeof config.command === "object" &&
    !Array.isArray(config.command)
  ) {
    const inferred = inferLegacyForgeHome(config.command);
    effectiveForgeHome = inferred.forgeHome;
    ambiguousHome = inferred.ambiguous;
  }

  const edits = [];
  const removedRootProperties = new Map();
  let removed = 0;

  if (Array.isArray(config.instructions)) {
    const removedInstructions = new Set();
    for (let index = 0; index < config.instructions.length; index++) {
      if (isLegacyInstructionsReference(config.instructions[index], legacyInstructions)) {
        removedInstructions.add(index);
      }
    }
    if (removedInstructions.size > 0) {
      const propertyIndex = objectEntryIndex(ast, "instructions");
      const property = ast.entries[propertyIndex];
      if (propertyIndex < 0 || property.value.type !== "array" ||
          property.value.entries.length !== config.instructions.length) {
        throw new Error("Could not establish the JSONC instructions edit range");
      }
      config.instructions = config.instructions.filter((_, index) => !removedInstructions.has(index));
      removed += removedInstructions.size;
      if (config.instructions.length === 0) {
        delete config.instructions;
        removedRootProperties.set(
          propertyIndex,
          standaloneJsoncComments(raw, property),
        );
      } else {
        edits.push(...removalEditsForEntries(property.value, removedInstructions));
      }
    }
  }

  if (
    effectiveForgeHome &&
    config.command &&
    typeof config.command === "object" &&
    !Array.isArray(config.command)
  ) {
    const removedNames = new Set();
    for (const name of Object.keys(LEGACY_COMMAND_CONTRACTS)) {
      if (isLegacyCommandDefinition(name, config.command[name], effectiveForgeHome)) {
        removedNames.add(name);
      }
    }
    if (removedNames.size > 0) {
      const propertyIndex = objectEntryIndex(ast, "command");
      const property = ast.entries[propertyIndex];
      if (propertyIndex < 0 || property.value.type !== "object") {
        throw new Error("Could not establish the JSONC command edit range");
      }
      const removedCommands = new Set();
      for (const name of removedNames) {
        const commandIndex = objectEntryIndex(property.value, name);
        if (commandIndex < 0) throw new Error(`Could not establish the JSONC ${name} edit range`);
        removedCommands.add(commandIndex);
        delete config.command[name];
      }
      removed += removedNames.size;
      if (Object.keys(config.command).length === 0) {
        delete config.command;
        removedRootProperties.set(
          propertyIndex,
          standaloneJsoncComments(raw, property),
        );
      } else {
        edits.push(...removalEditsForEntries(property.value, removedCommands));
      }
    }
  }

  const rootEdits = removalEditsForEntries(ast, new Set(removedRootProperties.keys()));
  for (const edit of rootEdits) {
    const propertyIndex = ast.entries.findIndex(
      (property) => property.start === edit.start && property.end === edit.end,
    );
    if (removedRootProperties.has(propertyIndex)) {
      edit.replacement = removedRootProperties.get(propertyIndex);
    }
  }
  edits.push(...rootEdits);

  const content = applyJsoncRemovalEdits(raw, edits);
  const editedConfig = JSON.parse(stripJsonc(content));
  parseJsoncAst(content);
  if (JSON.stringify(editedConfig) !== JSON.stringify(config)) {
    throw new Error("Surgical JSONC edit changed unrelated configuration");
  }
  return { content, removed, ambiguousHome };
}

async function migrateLegacyAdapter({ configDir, home, env = process.env, forgeHome }) {
  const resolvedHome = home || env.HOME || env.USERPROFILE || homedir();
  const primaryConfigDir = resolveOpenCodePrimaryConfigDir({ home: resolvedHome, env });
  const mayRemoveGlobalInstructions =
    !env.OPENCODE_CONFIG_DIR &&
    !env.OPENCODE_CONFIG &&
    relative(resolve(primaryConfigDir), resolve(configDir)) === "";
  const legacyInstructions = join(resolvedHome, ".opencode-forge.md");
  const result = { removedInstructionsFile: false, removedConfigEntries: 0, warnings: [] };
  const safeLegacyInstructions = await tryResolveSafePath(dirname(legacyInstructions), legacyInstructions);
  let legacyInstructionsOwned = false;
  if (safeLegacyInstructions) {
    try {
      const content = await readRegularFile(safeLegacyInstructions.path);
      if (content?.split(/\r?\n/).some((line) => line.trim() === LEGACY_SENTINEL)) {
        legacyInstructionsOwned = true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") result.warnings.push(`Could not inspect ${legacyInstructions}: ${error.message}`);
    }
  }
  if (!legacyInstructionsOwned) return result;

  const configPath = join(configDir, "opencode.json");
  const safeConfig = await tryResolveSafePath(configDir, configPath);
  if (!safeConfig) {
    result.warnings.push(`Could not safely inspect legacy entries in ${configPath}`);
    return result;
  }
  if (existsSync(safeConfig.path)) {
    try {
      const original = await readFile(safeConfig.path, "utf8");
      const edited = editLegacyConfigJsonc(original, { legacyInstructions, forgeHome });
      if (edited.ambiguousHome) {
        result.warnings.push(
          `Could not infer one legacy ForgeDock home from exact command templates in ${safeConfig.path}; preserving command entries`,
        );
      }
      if (edited.removed > 0) {
        await atomicWrite(safeConfig.path, edited.content, configDir, { preserveMode: true });
        result.removedConfigEntries = edited.removed;
      }
    } catch (error) {
      result.warnings.push(`Could not surgically migrate legacy entries in ${safeConfig.path}: ${error.message}`);
      return result;
    }
  }
  if (legacyInstructionsOwned && safeLegacyInstructions && mayRemoveGlobalInstructions) {
    try {
      await unlink(safeLegacyInstructions.path);
      result.removedInstructionsFile = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        result.warnings.push(`Could not remove legacy instructions file ${legacyInstructions}: ${error.message}`);
      }
    }
  }
  return result;
}

async function snapshotAdapterFiles(configDir, files) {
  const snapshots = new Map();
  for (const rel of files) {
    const path = join(configDir, rel);
    const safe = await tryResolveSafePath(configDir, path);
    const content = safe ? await readRegularFile(safe.path) : null;
    snapshots.set(rel, content !== null && hasManagedSentinel(content) ? content : null);
  }
  return snapshots;
}

async function restoreAdapterState({ configDir, manifestPath, files, manifestContent }) {
  for (const [rel, content] of files) {
    const path = join(configDir, rel);
    if (content !== null) {
      await atomicWrite(path, content, configDir).catch(() => {});
      continue;
    }
    const safe = await tryResolveSafePath(configDir, path);
    if (!safe || !(await isManagedFile(safe.path))) continue;
    await unlink(safe.path).catch(() => {});
    await removeEmptyParentDirs(safe.root, safe.path).catch(() => {});
  }

  if (manifestContent !== null) {
    await atomicWrite(manifestPath, manifestContent, configDir).catch(() => {});
  } else {
    const safeManifest = await tryResolveSafePath(configDir, manifestPath);
    if (safeManifest) await unlink(safeManifest.path).catch(() => {});
  }
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
  if (!existsSync(join(forgeHome, "bin", "opencode", "control.mjs")) ||
      !existsSync(join(forgeHome, "runtimes", "opencode", "work-on", "common.md"))) {
    throw new Error(`ForgeDock OpenCode native runtime is incomplete under: ${forgeHome}`);
  }

  const configDir = resolveOpenCodeConfigDir({ home, env });
  const manifestPath = join(configDir, "forgedock", "manifest.json");
  return withAdapterLock(configDir, () => installOpenCodeAdapterLocked({
    forgeHome,
    home,
    env,
    includeExtras,
    configDir,
    manifestPath,
  }));
}

async function installOpenCodeAdapterLocked({ forgeHome, home, env, includeExtras, configDir, manifestPath }) {
  const previous = (await readManifest(manifestPath, configDir)) || { files: [] };
  const workflows = await discoverEntrypoints(forgeHome, includeExtras);
  const commands = workflows.filter((workflow) => workflow.topLevel);
  const skills = workflows.filter((workflow) =>
    workflow.name !== "work-on" && !workflow.name.startsWith("work-on/") &&
    workflow.name !== "orchestrate" && !workflow.name.startsWith("orchestrate/"));
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

  for (const workflow of skills) {
    const rel = portablePath(join("skills", workflow.nativeName, "SKILL.md"));
    const content = renderOpenCodeSkill({
      command: workflow.name,
      description: workflow.description,
      forgeHome,
    });
    rendered.push({ rel, content });
  }

  const pluginRel = portablePath(join("plugins", "forgedock.js"));
  const pluginContent = renderOpenCodePlugin(forgeHome);
  rendered.push({ rel: pluginRel, content: pluginContent });

  await assertSafePath(configDir, manifestPath);
  // Preflight every collision before the first write so a rejected install
  // cannot leave unmanifested command files behind.
  for (const item of rendered) {
    const path = join(configDir, item.rel);
    await assertSafePath(configDir, path);
    const safe = await tryResolveSafePath(configDir, path);
    if (safe && existsSync(safe.path) && !(await isManagedFile(safe.path))) {
      throw new Error(`Refusing to overwrite user-owned OpenCode file: ${safe.path}`);
    }
  }
  const nextFiles = rendered.map((item) => item.rel).sort();
  const trackedFiles = [...new Set([...previous.files, ...nextFiles])];
  const snapshots = await snapshotAdapterFiles(configDir, trackedFiles);
  const safeManifest = await tryResolveSafePath(configDir, manifestPath);
  const previousManifestContent = safeManifest ? await readRegularFile(safeManifest.path) : null;
  let removed;
  let digest;
  let migration;
  try {
    for (const item of rendered) {
      await atomicWrite(join(configDir, item.rel), item.content, configDir);
    }

    const stale = previous.files.filter((file) => !nextFiles.includes(file));
    removed = await removeOwnedFiles(configDir, stale);
    digest = digestFiles(rendered);
    const manifest = {
      version: MANIFEST_VERSION,
      forgeHome,
      includeExtras,
      commandCount: commands.length,
      skillCount: skills.length,
      files: nextFiles,
      digest,
    };
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, configDir);
    migration = await migrateLegacyAdapter({ configDir, home, env, forgeHome });
  } catch (error) {
    await restoreAdapterState({
      configDir,
      manifestPath,
      files: snapshots,
      manifestContent: previousManifestContent,
    });
    throw error;
  }

  return {
    configDir,
    manifestPath,
    commandCount: commands.length,
    skillCount: skills.length,
    removed,
    digest,
    migration,
  };
}

export async function getOpenCodeAdapterStatus({ home, env = process.env } = {}) {
  const configDir = resolveOpenCodeConfigDir({ home, env });
  const manifestPath = join(configDir, "forgedock", "manifest.json");
  const safeManifest = await tryResolveSafePath(configDir, manifestPath);
  const resolvedHome = home || env.HOME || env.USERPROFILE || homedir();
  const legacyInstructions = join(resolvedHome, ".opencode-forge.md");
  const safeLegacyInstructions = await tryResolveSafePath(dirname(legacyInstructions), legacyInstructions);
  const legacyContent = safeLegacyInstructions
    ? await readRegularFile(safeLegacyInstructions.path)
    : null;
  const legacyInstalled = legacyContent?.split(/\r?\n/).some(
    (line) => line.trim() === LEGACY_SENTINEL,
  ) === true;

  if (!safeManifest || !existsSync(safeManifest.path)) {
    if (legacyInstalled) {
      return {
        installed: true,
        healthy: false,
        legacy: true,
        configDir,
        missing: [],
        integrity: "legacy-adapter",
      };
    }
    return { installed: false, healthy: false, configDir, missing: [] };
  }
  if (!(await isSafePath(configDir, manifestPath))) {
    return { installed: true, healthy: false, configDir, missing: [], integrity: "invalid-manifest" };
  }
  const manifest = await readManifest(manifestPath, configDir);
  if (!manifest) {
    return { installed: true, healthy: false, configDir, missing: [], integrity: "invalid-manifest" };
  }
  if (manifest.version !== MANIFEST_VERSION) {
    return {
      installed: true,
      healthy: false,
      configDir,
      manifest,
      missing: [],
      integrity: "upgrade-required",
    };
  }
  const missing = [];
  const current = [];
  for (const rel of manifest.files) {
    const path = join(configDir, rel);
    const safe = await tryResolveSafePath(configDir, path);
    const content = safe ? await readRegularFile(safe.path) : null;
    if (!safe || content === null || !hasManagedSentinel(content)) {
      missing.push(rel);
      continue;
    }
    current.push({ rel, content });
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
  return withAdapterLock(configDir, () => uninstallOpenCodeAdapterLocked({ home, env, configDir }));
}

async function uninstallOpenCodeAdapterLocked({ home, env, configDir }) {
  const manifestPath = join(configDir, "forgedock", "manifest.json");
  const manifest = (await readManifest(manifestPath, configDir)) || { files: [] };
  const removed = await removeOwnedFiles(configDir, manifest.files);
  const safeManifest = await tryResolveSafePath(configDir, manifestPath);
  if (safeManifest) {
    await unlink(safeManifest.path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const manifestDir = join(configDir, "forgedock");
  const safeManifestDir = await tryResolveSafePath(configDir, manifestDir);
  if (safeManifestDir) {
    await rmdir(safeManifestDir.path).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    });
  }
  const migration = await migrateLegacyAdapter({
    configDir,
    home,
    env,
    forgeHome: typeof manifest.forgeHome === "string" ? manifest.forgeHome : undefined,
  });
  return { configDir, removed, migration };
}
