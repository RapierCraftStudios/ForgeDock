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

/** Substring identifying ForgeDock's own hook entry. */
export const HOOK_MARKER = "session-start.mjs";

function isOurs(entry) {
  return JSON.stringify(entry).includes(HOOK_MARKER);
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

  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
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

  const list = settings.hooks && Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];
  const kept = list.filter((e) => !isOurs(e));
  if (kept.length === list.length) return { status: "absent" };

  settings.hooks.SessionStart = kept;
  writeSettings(settingsPath, settings);
  return { status: "removed" };
}
