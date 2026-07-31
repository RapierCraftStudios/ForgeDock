import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN"];
const AUTH_MODES = ["initial", "github-token", "stored"];
const DEFAULT_REFRESH_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "refresh-bot-token.sh",
);

function tokenKey(name) {
  return String(name || "").toUpperCase();
}

function tokenValue(env, name) {
  const key = Object.keys(env).find((candidate) => tokenKey(candidate) === name);
  return key ? env[key] : undefined;
}

function withoutTokenOverrides(env, names = TOKEN_VARIABLES) {
  const removed = new Set(names);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !removed.has(tokenKey(name))));
}

function environmentForMode(env, mode) {
  if (mode === "github-token") return withoutTokenOverrides(env, ["GH_TOKEN"]);
  if (mode === "stored") return withoutTokenOverrides(env);
  return env;
}

function failureDetail(value) {
  if (typeof value === "string") return value.trim().slice(0, 2_000);
  if (value && typeof value === "object" && "stderr" in value) {
    return String(value.stderr || "").trim().slice(0, 2_000);
  }
  return String(value?.message || "").trim().slice(0, 2_000);
}

export function isGitHubAuthFailure(value) {
  return /(?:HTTP\s+401\b|bad credentials|not authenticated|gh auth login|set the GH_TOKEN environment variable|token in keyring is invalid|authentication token[^\n]*(?:invalid|expired))/i
    .test(failureDetail(value));
}

function terminalAuthError(failure, refresh, afterRefresh = false) {
  let message;
  if (afterRefresh) {
    message = "GitHub authentication still failed after automatic token refresh";
  } else if (!refresh.available) {
    message = `GitHub authentication failed; no automatic refresh script was found at ${refresh.script}`;
  } else {
    message = `GitHub authentication failed and automatic token refresh failed: ${refresh.reason}`;
  }
  const detail = failureDetail(failure);
  const error = new Error(detail ? `${message}. ${detail}` : message);
  error.code = "FORGEDOCK_GITHUB_AUTH";
  error.stderr = error.message;
  error.cause = failure;
  return error;
}

function refreshShell(platform, env, fileExists) {
  if (platform !== "win32") return "bash";
  const candidates = [
    env.ProgramFiles && win32.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fileExists(candidate)) || "bash";
}

export function createGitHubAuthRecovery({
  env = process.env,
  platform = process.platform,
  script = DEFAULT_REFRESH_SCRIPT,
  fileExists = existsSync,
  execute = exec,
  spawn = spawnSync,
} = {}) {
  let confirmedMode = "initial";
  let refreshPromise;

  const modeRank = (mode) => AUTH_MODES.indexOf(mode);
  const confirm = (mode) => {
    if (modeRank(mode) > modeRank(confirmedMode)) confirmedMode = mode;
  };
  const environment = (mode = confirmedMode) => environmentForMode(env, mode);
  const fallbackModes = (fromMode) => {
    const modes = [];
    let baseMode = fromMode;
    if (modeRank(confirmedMode) > modeRank(baseMode)) {
      baseMode = confirmedMode;
      modes.push(baseMode);
    }
    const hasGhToken = Boolean(tokenValue(env, "GH_TOKEN"));
    const hasGitHubToken = Boolean(tokenValue(env, "GITHUB_TOKEN"));
    if (modeRank(baseMode) < modeRank("github-token") && hasGhToken && hasGitHubToken) {
      modes.push("github-token");
      baseMode = "github-token";
    }
    if (modeRank(baseMode) < modeRank("stored") && (hasGhToken || hasGitHubToken)) modes.push("stored");
    return [...new Set(modes)];
  };
  const shellOverrides = () => {
    if (confirmedMode === "github-token") return { GH_TOKEN: "" };
    if (confirmedMode === "stored") return { GH_TOKEN: "", GITHUB_TOKEN: "" };
    return {};
  };

  const performRefresh = async (cwd) => {
    if (!fileExists(script)) {
      return { available: false, attempted: false, refreshed: false, script, reason: "refresh script is not installed" };
    }
    try {
      await execute(refreshShell(platform, env, fileExists), [script], {
        cwd,
        env: environmentForMode(env, "stored"),
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      confirm("stored");
      return { available: true, attempted: true, refreshed: true, script, reason: "" };
    } catch (error) {
      return {
        available: true,
        attempted: true,
        refreshed: false,
        script,
        reason: failureDetail(error) || "refresh command failed",
      };
    }
  };

  const refresh = async (cwd) => {
    refreshPromise ||= performRefresh(cwd);
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = undefined;
    }
  };

  const refreshSync = (cwd) => {
    if (!fileExists(script)) {
      return { available: false, attempted: false, refreshed: false, script, reason: "refresh script is not installed" };
    }
    const result = spawn(refreshShell(platform, env, fileExists), [script], {
      cwd,
      env: environmentForMode(env, "stored"),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      return {
        available: true,
        attempted: true,
        refreshed: false,
        script,
        reason: failureDetail(result.error || result) || "refresh command failed",
      };
    }
    confirm("stored");
    return { available: true, attempted: true, refreshed: true, script, reason: "" };
  };

  return {
    mode: () => confirmedMode,
    environment,
    fallbackModes,
    confirm,
    shellOverrides,
    refresh,
    refreshSync,
  };
}

export const githubAuthRecovery = createGitHubAuthRecovery();

export async function runGitHubWithAuthRecovery(args, cwd, {
  recovery = githubAuthRecovery,
  execute = exec,
  options = {},
} = {}) {
  const invoke = (mode) => execute("gh", args, {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    cwd,
    env: recovery.environment(mode),
  });
  let mode = recovery.mode();
  let failure;
  try {
    const result = await invoke(mode);
    recovery.confirm(mode);
    return result;
  } catch (error) {
    if (!isGitHubAuthFailure(error)) throw error;
    failure = error;
  }

  for (const fallback of recovery.fallbackModes(mode)) {
    mode = fallback;
    try {
      const result = await invoke(mode);
      recovery.confirm(mode);
      return result;
    } catch (error) {
      if (!isGitHubAuthFailure(error)) throw error;
      failure = error;
    }
  }

  const refresh = await recovery.refresh(cwd);
  if (!refresh.refreshed) throw terminalAuthError(failure, refresh);
  try {
    return await invoke("stored");
  } catch (error) {
    if (isGitHubAuthFailure(error)) throw terminalAuthError(error, refresh, true);
    throw error;
  }
}

function commandSucceeded(result) {
  return !result.error && result.status === 0;
}

export function runGitHubSyncWithAuthRecovery(args, cwd, {
  recovery = githubAuthRecovery,
  spawn = spawnSync,
  options = {},
} = {}) {
  const invoke = (mode) => spawn("gh", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    cwd,
    env: recovery.environment(mode),
  });
  let mode = recovery.mode();
  let result = invoke(mode);
  if (commandSucceeded(result)) {
    recovery.confirm(mode);
    return result;
  }
  if (!isGitHubAuthFailure(result)) return result;

  for (const fallback of recovery.fallbackModes(mode)) {
    mode = fallback;
    result = invoke(mode);
    if (commandSucceeded(result)) {
      recovery.confirm(mode);
      return result;
    }
    if (!isGitHubAuthFailure(result)) return result;
  }

  const refresh = recovery.refreshSync(cwd);
  if (!refresh.refreshed) throw terminalAuthError(result.error || result, refresh);
  result = invoke("stored");
  if (!commandSucceeded(result) && isGitHubAuthFailure(result)) {
    throw terminalAuthError(result.error || result, refresh, true);
  }
  return result;
}
