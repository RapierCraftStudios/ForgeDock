/**
 * bin/splash-install.mjs — default install of the forgedock-splash Claude Code
 * plugin during `npx forgedock` setup (forge#5312).
 *
 * The plugin is staged, together with a generated local marketplace manifest
 * named `forgedock-local`, into ~/.forge/splash-marketplace (the persisted
 * toolset home, so the path survives npx cache changes). The `claude` CLI then
 * registers that directory as a marketplace and installs the plugin at user
 * scope. Every step is best-effort: nothing here ever throws or fails setup,
 * and re-running setup retries and refreshes the staged copy.
 */
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveClaudeConfigDir } from "./journey.mjs";

export const SPLASH_PLUGIN = "forgedock-splash";
export const LOCAL_MARKETPLACE = "forgedock-local";
const GITHUB_MARKETPLACE = "forgedock";
const TURN_OFF = `turn off: /plugin disable ${SPLASH_PLUGIN}`;

export const splashStageDir = (home) => join(home, ".forge", "splash-marketplace");

/** `--no-splash` or FORGEDOCK_NO_SPLASH=1 (also FORGEDOCK_SPLASH=0/false/off) opts out. */
export function splashOptedOut(argv = [], env = process.env) {
  if (argv.includes("--no-splash")) return true;
  if (/^(1|true|yes|on)$/i.test(env.FORGEDOCK_NO_SPLASH ?? "")) return true;
  return /^(0|false|no|off)$/i.test(env.FORGEDOCK_SPLASH ?? "");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Real `claude` runner; the plugin CLI reads CLAUDE_CONFIG_DIR and HOME from env. */
export function defaultSplashExec(cmd, args, env = process.env) {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
    env,
    shell: process.platform === "win32",
  });
}

/**
 * Plugin state from the user's settings.json `enabledPlugins`:
 * "disabled" when any forgedock-splash@* entry is false, "installed" when one is true.
 */
export function splashState({ home, env = process.env }) {
  const settings = readJson(join(resolveClaudeConfigDir(env, home), "settings.json"));
  const entries = Object.entries(settings?.enabledPlugins ?? {}).filter(([k]) => k.startsWith(`${SPLASH_PLUGIN}@`));
  if (entries.some(([, v]) => v === false)) return "disabled";
  return entries.some(([, v]) => v === true) ? "installed" : "not installed";
}

function knownMarketplaces(home, env) {
  return readJson(join(resolveClaudeConfigDir(env, home), "plugins", "known_marketplaces.json")) ?? {};
}

/** True when the already-added GitHub-backed `forgedock` marketplace lists the plugin. */
function githubMarketplaceHasSplash(home, env) {
  const entry = knownMarketplaces(home, env)[GITHUB_MARKETPLACE];
  if (!entry?.installLocation) return false;
  const manifest = readJson(join(entry.installLocation, ".claude-plugin", "marketplace.json"));
  return Array.isArray(manifest?.plugins) && manifest.plugins.some((p) => p?.name === SPLASH_PLUGIN);
}

/** Copy the plugin (without tests/) and a generated local marketplace manifest into ~/.forge. */
export function stageSplash({ pkgRoot, home }) {
  const src = join(pkgRoot, "plugins", SPLASH_PLUGIN);
  if (!existsSync(join(src, ".claude-plugin", "plugin.json"))) return null;
  const stage = splashStageDir(home);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, ".claude-plugin"), { recursive: true });
  cpSync(src, join(stage, "plugins", SPLASH_PLUGIN), {
    recursive: true,
    filter: (p) => !/[\\/]tests([\\/]|$)/.test(p.slice(src.length)),
  });
  const manifest = {
    name: LOCAL_MARKETPLACE,
    description: "ForgeDock splash plugin, installed locally by npx forgedock.",
    owner: { name: "RapierCraft Studios" },
    plugins: [{ name: SPLASH_PLUGIN, source: `./plugins/${SPLASH_PLUGIN}`, description: "ForgeDock startup splash for Claude Code." }],
  };
  writeFileSync(join(stage, ".claude-plugin", "marketplace.json"), JSON.stringify(manifest, null, 2) + "\n");
  return stage;
}

/**
 * Install or refresh the splash. Returns { status, line } where status is one of
 * opted-out | disabled | no-source | no-claude | failed | installed | already-installed.
 * Never throws.
 */
export function installSplash({ pkgRoot, home, env = process.env, argv = [], exec = defaultSplashExec }) {
  try {
    if (splashOptedOut(argv, env)) return { status: "opted-out", line: "startup splash skipped (--no-splash)" };
    const state = splashState({ home, env });
    if (state === "disabled") {
      return { status: "disabled", line: `startup splash left disabled   re-enable: /plugin enable ${SPLASH_PLUGIN}` };
    }
    const stage = stageSplash({ pkgRoot, home });
    if (!stage) return { status: "no-source", line: "" };
    const run = (...args) => exec("claude", args, env);
    try {
      run("--version");
    } catch {
      return { status: "no-claude", line: "startup splash skipped: claude CLI not found   re-run npx forgedock after installing Claude Code" };
    }
    let market = LOCAL_MARKETPLACE;
    if (githubMarketplaceHasSplash(home, env)) {
      market = GITHUB_MARKETPLACE;
      try { run("plugin", "marketplace", "update", market); } catch { /* best-effort refresh */ }
    } else if (LOCAL_MARKETPLACE in knownMarketplaces(home, env)) {
      run("plugin", "marketplace", "update", market);
    } else {
      try {
        run("plugin", "marketplace", "add", stage);
      } catch {
        run("plugin", "marketplace", "update", market); // already added under another record
      }
    }
    const ref = `${SPLASH_PLUGIN}@${market}`;
    if (state === "installed") {
      try { run("plugin", "update", ref); } catch { /* best-effort refresh */ }
      return { status: "already-installed", line: `startup splash already installed   ${TURN_OFF}` };
    }
    run("plugin", "install", ref, "--scope", "user");
    return { status: "installed", line: `startup splash installed   ${TURN_OFF}` };
  } catch (err) {
    const why = String(err?.stderr || err?.message || err).split("\n")[0].slice(0, 120);
    return { status: "failed", line: `startup splash skipped: ${why}   re-run npx forgedock to retry` };
  }
}

/** Remove the plugin and the local marketplace this installer added. Never throws. */
export function uninstallSplash({ home, env = process.env, exec = defaultSplashExec }) {
  const lines = [];
  const stage = splashStageDir(home);
  const hadLocal = LOCAL_MARKETPLACE in knownMarketplaces(home, env) || existsSync(stage);
  if (!hadLocal) return { removed: false, lines };
  const run = (...args) => exec("claude", args, env);
  let cli = true;
  try { run("--version"); } catch { cli = false; }
  if (cli) {
    try { run("plugin", "uninstall", `${SPLASH_PLUGIN}@${LOCAL_MARKETPLACE}`); lines.push("Removed startup splash plugin"); } catch { /* not installed */ }
    try { run("plugin", "marketplace", "remove", LOCAL_MARKETPLACE); lines.push(`Removed ${LOCAL_MARKETPLACE} marketplace`); } catch { /* not added */ }
  } else {
    lines.push(`claude CLI not found: run /plugin uninstall ${SPLASH_PLUGIN}@${LOCAL_MARKETPLACE} manually`);
  }
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* best-effort */ }
  return { removed: true, lines };
}
