/**
 * bin/settings-hook.mjs — Idempotent SessionStart hook registration in
 * ~/.claude/settings.json.
 *
 * Contract (spec: "Hook wiring"):
 *   - Read-modify-write; unrelated keys and hooks preserved verbatim
 *   - Our entry identified by HOOK_MARKER in its command string
 *   - Malformed JSON → skip and report, NEVER overwrite the file
 *   - Absolute hook script path baked in at install time
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";

/** Substring identifying ForgeDock's own SessionStart hook entry. */
export const HOOK_MARKER = "session-start.mjs";

/** Substring identifying ForgeDock's own SubagentStop hook entry (interactive engine adapter). */
export const SUBAGENT_STOP_MARKER = "interactive-engine.mjs";

/** Substring identifying ForgeDock's SubagentStop enforcement hook (annotation verification). */
export const SUBAGENT_STOP_ENFORCE_MARKER = "subagent-stop-enforce.mjs";

/** Substring identifying ForgeDock's own PreToolUse hook entry. */
export const PRE_TOOL_USE_MARKER = "pre-tool-use.mjs";

function isOurs(entry) {
  return JSON.stringify(entry).includes(HOOK_MARKER);
}

function isOursSubagentStop(entry) {
  return JSON.stringify(entry).includes(SUBAGENT_STOP_MARKER);
}

function isOursSubagentStopEnforce(entry) {
  return JSON.stringify(entry).includes(SUBAGENT_STOP_ENFORCE_MARKER);
}

function isOursPreToolUse(entry) {
  return JSON.stringify(entry).includes(PRE_TOOL_USE_MARKER);
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return { settings: {}, fresh: true };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { settings: parsed, fresh: false };
  } catch {
    return null; // malformed — caller must not write
  }
}

function writeSettings(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = settingsPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmp, settingsPath);
}

/**
 * Merge ForgeDock's SessionStart hook into settings.json.
 * @param {string} settingsPath - Absolute path to ~/.claude/settings.json
 * @param {string} hookScriptPath - Absolute path to bin/hooks/session-start.mjs
 * @returns {{ status: 'installed'|'already'|'skipped-malformed' }}
 */
export function installSessionStartHook(settingsPath, hookScriptPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings } = read;

  // Validate hooks shape: must be a plain object (not array, string, etc.)
  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
    // Validate SessionStart if present: must be an array
    if (settings.hooks.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) {
      return { status: "skipped-malformed" };
    }
  } else {
    // hooks missing or null → initialize to fresh object
    settings.hooks = {};
  }

  const list = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  if (list.some(isOurs)) return { status: "already" };

  list.push({
    hooks: [
      {
        type: "command",
        command: `node "${hookScriptPath}"`,
      },
    ],
  });
  settings.hooks.SessionStart = list;
  writeSettings(settingsPath, settings);
  return { status: "installed" };
}

/**
 * Remove ForgeDock's SessionStart hook entry; leaves everything else alone.
 * @returns {{ status: 'removed'|'absent'|'skipped-malformed' }}
 */
export function removeSessionStartHook(settingsPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings, fresh } = read;
  if (fresh) return { status: "absent" };

  // Validate hooks shape: must be a plain object (not array, string, etc.)
  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
  }

  // Validate SessionStart shape if present: must be an array
  if (settings.hooks && settings.hooks.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) {
    return { status: "skipped-malformed" };
  }

  const list = settings.hooks && Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];
  const kept = list.filter((e) => !isOurs(e));
  if (kept.length === list.length) return { status: "absent" };

  settings.hooks.SessionStart = kept;
  writeSettings(settingsPath, settings);
  return { status: "removed" };
}

// ---------------------------------------------------------------------------
// SubagentStop hook — interactive engine adapter (#1323)
// ---------------------------------------------------------------------------

/**
 * Merge ForgeDock's SubagentStop hook into settings.json.
 * @param {string} settingsPath       - Absolute path to ~/.claude/settings.json
 * @param {string} hookScriptPath     - Absolute path to bin/hooks/interactive-engine.mjs
 * @returns {{ status: 'installed'|'already'|'skipped-malformed' }}
 */
export function installSubagentStopHook(settingsPath, hookScriptPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings } = read;

  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
    if (settings.hooks.SubagentStop !== undefined && !Array.isArray(settings.hooks.SubagentStop)) {
      return { status: "skipped-malformed" };
    }
  } else {
    settings.hooks = {};
  }

  const list = Array.isArray(settings.hooks.SubagentStop) ? settings.hooks.SubagentStop : [];
  if (list.some(isOursSubagentStop)) return { status: "already" };

  list.push({
    hooks: [{ type: "command", command: `node "${hookScriptPath}"` }],
  });
  settings.hooks.SubagentStop = list;
  writeSettings(settingsPath, settings);
  return { status: "installed" };
}

/**
 * Remove ForgeDock's SubagentStop hook entry; leaves everything else alone.
 * @returns {{ status: 'removed'|'absent'|'skipped-malformed' }}
 */
export function removeSubagentStopHook(settingsPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings, fresh } = read;
  if (fresh) return { status: "absent" };

  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
  }
  if (settings.hooks && settings.hooks.SubagentStop !== undefined && !Array.isArray(settings.hooks.SubagentStop)) {
    return { status: "skipped-malformed" };
  }

  const list = settings.hooks && Array.isArray(settings.hooks.SubagentStop)
    ? settings.hooks.SubagentStop : [];
  const kept = list.filter((e) => !isOursSubagentStop(e));
  if (kept.length === list.length) return { status: "absent" };

  settings.hooks.SubagentStop = kept;
  writeSettings(settingsPath, settings);
  return { status: "removed" };
}

// ---------------------------------------------------------------------------
// PreToolUse hook — enforcement (#1250, #1323)
// ---------------------------------------------------------------------------

/**
 * Merge ForgeDock's PreToolUse hook into settings.json.
 *
 * The installed entry carries `matcher: "Bash"` so Claude Code's harness
 * only invokes this hook for Bash tool calls — without it, Node spawns for
 * every tool call (Read/Edit/Grep/Glob/...) just to exit 0 immediately
 * (issue #1591).
 *
 * @param {string} settingsPath       - Absolute path to ~/.claude/settings.json
 * @param {string} hookScriptPath     - Absolute path to bin/hooks/pre-tool-use.mjs
 * @returns {{ status: 'installed'|'already'|'skipped-malformed' }}
 */
export function installPreToolUseHook(settingsPath, hookScriptPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings } = read;

  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
    if (settings.hooks.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) {
      return { status: "skipped-malformed" };
    }
  } else {
    settings.hooks = {};
  }

  const list = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  if (list.some(isOursPreToolUse)) return { status: "already" };

  list.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: `node "${hookScriptPath}"` }],
  });
  settings.hooks.PreToolUse = list;
  writeSettings(settingsPath, settings);
  return { status: "installed" };
}

/**
 * Remove ForgeDock's PreToolUse hook entry; leaves everything else alone.
 * @returns {{ status: 'removed'|'absent'|'skipped-malformed' }}
 */
export function removePreToolUseHook(settingsPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings, fresh } = read;
  if (fresh) return { status: "absent" };

  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
  }
  if (settings.hooks && settings.hooks.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) {
    return { status: "skipped-malformed" };
  }

  const list = settings.hooks && Array.isArray(settings.hooks.PreToolUse)
    ? settings.hooks.PreToolUse : [];
  const kept = list.filter((e) => !isOursPreToolUse(e));
  if (kept.length === list.length) return { status: "absent" };

  settings.hooks.PreToolUse = kept;
  writeSettings(settingsPath, settings);
  return { status: "removed" };
}

// ---------------------------------------------------------------------------
// SubagentStop enforcement hook — annotation verification (#1250)
// ---------------------------------------------------------------------------

/**
 * Merge ForgeDock's SubagentStop enforcement hook into settings.json.
 *
 * This hook (subagent-stop-enforce.mjs) is separate from the interactive
 * engine adapter (interactive-engine.mjs): it verifies that each pipeline
 * phase posted its FORGE: annotation before completion, and blocks (exit 2)
 * if the annotation is missing.
 *
 * Version-gated: requires Claude Code v2.1.163+ (additionalContext injection).
 *
 * @param {string} settingsPath   - Absolute path to ~/.claude/settings.json
 * @param {string} hookScriptPath - Absolute path to bin/hooks/subagent-stop-enforce.mjs
 * @returns {{ status: 'installed'|'already'|'skipped-malformed' }}
 */
export function installSubagentStopEnforceHook(settingsPath, hookScriptPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings } = read;

  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
    if (settings.hooks.SubagentStop !== undefined && !Array.isArray(settings.hooks.SubagentStop)) {
      return { status: "skipped-malformed" };
    }
  } else {
    settings.hooks = {};
  }

  const list = Array.isArray(settings.hooks.SubagentStop) ? settings.hooks.SubagentStop : [];
  if (list.some(isOursSubagentStopEnforce)) return { status: "already" };

  list.push({
    hooks: [{ type: "command", command: `node "${hookScriptPath}"` }],
  });
  settings.hooks.SubagentStop = list;
  writeSettings(settingsPath, settings);
  return { status: "installed" };
}

/**
 * Remove ForgeDock's SubagentStop enforcement hook entry; leaves everything else alone.
 * @returns {{ status: 'removed'|'absent'|'skipped-malformed' }}
 */
export function removeSubagentStopEnforceHook(settingsPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings, fresh } = read;
  if (fresh) return { status: "absent" };

  if (settings.hooks !== undefined && settings.hooks !== null) {
    if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
      return { status: "skipped-malformed" };
    }
  }
  if (settings.hooks && settings.hooks.SubagentStop !== undefined && !Array.isArray(settings.hooks.SubagentStop)) {
    return { status: "skipped-malformed" };
  }

  const list = settings.hooks && Array.isArray(settings.hooks.SubagentStop)
    ? settings.hooks.SubagentStop : [];
  const kept = list.filter((e) => !isOursSubagentStopEnforce(e));
  if (kept.length === list.length) return { status: "absent" };

  settings.hooks.SubagentStop = kept;
  writeSettings(settingsPath, settings);
  return { status: "removed" };
}
