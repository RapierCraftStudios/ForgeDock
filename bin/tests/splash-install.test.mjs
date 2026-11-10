/**
 * bin/tests/splash-install.test.mjs — default install of forgedock-splash (forge#5312).
 * Run with: node --test bin/tests/splash-install.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./_tmp.mjs";
import {
  installSplash, uninstallSplash, splashState, splashOptedOut, splashStageDir, LOCAL_MARKETPLACE,
} from "../splash-install.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
let home, claudeDir, calls;
const env = () => ({ HOME: home, CLAUDE_CONFIG_DIR: claudeDir });
const fakeExec = (fail = []) => (cmd, args, e) => {
  calls.push({ cmd, args, e });
  if (fail.some((f) => args.join(" ").startsWith(f))) throw new Error("boom");
  return "";
};
const write = (p, o) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(o)); };
const run = (extra = {}) => installSplash({ pkgRoot: REPO, home, env: env(), exec: fakeExec(), ...extra });
const cmds = () => calls.map((c) => c.args.join(" "));

beforeEach(() => {
  home = tmpDir("fd-splash-");
  claudeDir = join(home, "cfg");
  mkdirSync(claudeDir, { recursive: true });
  calls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("installSplash", () => {
  it("stages plugin without tests, registers local marketplace, installs at user scope", () => {
    const r = run();
    assert.equal(r.status, "installed");
    assert.match(r.line, /startup splash installed {3}turn off: \/plugin disable forgedock-splash/);
    const stage = splashStageDir(home);
    const m = JSON.parse(readFileSync(join(stage, ".claude-plugin", "marketplace.json"), "utf8"));
    assert.equal(m.name, LOCAL_MARKETPLACE);
    assert.ok(existsSync(join(stage, "plugins/forgedock-splash/hooks/hooks.json")));
    assert.ok(!existsSync(join(stage, "plugins/forgedock-splash/tests")));
    assert.deepEqual(cmds(), ["--version", `plugin marketplace add ${stage}`, "plugin install forgedock-splash@forgedock-local --scope user"]);
    assert.equal(calls[1].e.CLAUDE_CONFIG_DIR, claudeDir);
  });
  it("skips with a line when claude is missing", () => {
    const r = run({ exec: fakeExec(["--version"]) });
    assert.equal(r.status, "no-claude");
    assert.match(r.line, /skipped: claude CLI not found/);
  });
  it("never throws when the CLI fails", () => {
    const r = run({ exec: fakeExec(["plugin install"]) });
    assert.equal(r.status, "failed");
    assert.match(r.line, /re-run npx forgedock to retry/);
  });
  it("--no-splash and env opt out without calling claude", () => {
    assert.equal(run({ argv: ["--no-splash"] }).status, "opted-out");
    assert.equal(run({ env: { ...env(), FORGEDOCK_NO_SPLASH: "1" } }).status, "opted-out");
    assert.equal(calls.length, 0);
    assert.ok(splashOptedOut([], { FORGEDOCK_SPLASH: "0" }));
    assert.ok(!splashOptedOut([], {}));
  });
  it("a user-disabled splash stays disabled across re-runs", () => {
    write(join(claudeDir, "settings.json"), { enabledPlugins: { "forgedock-splash@forgedock-local": false } });
    assert.equal(splashState({ home, env: env() }), "disabled");
    assert.equal(run().status, "disabled");
    assert.equal(run().status, "disabled");
    assert.equal(calls.length, 0);
  });
  it("already installed: refreshes marketplace + plugin, reports already installed", () => {
    write(join(claudeDir, "settings.json"), { enabledPlugins: { "forgedock-splash@forgedock-local": true } });
    write(join(claudeDir, "plugins/known_marketplaces.json"), { [LOCAL_MARKETPLACE]: {} });
    const r = run();
    assert.equal(r.status, "already-installed");
    assert.deepEqual(cmds(), ["--version", "plugin marketplace update forgedock-local", "plugin update forgedock-splash@forgedock-local"]);
  });
  it("upgrade re-copies the staged plugin", () => {
    run();
    const f = join(splashStageDir(home), "plugins/forgedock-splash/hooks/hooks.json");
    writeFileSync(f, "stale");
    run();
    assert.notEqual(readFileSync(f, "utf8"), "stale");
  });
  it("reuses a GitHub forgedock marketplace that already lists the plugin", () => {
    const loc = join(home, "gh-market");
    write(join(loc, ".claude-plugin/marketplace.json"), { plugins: [{ name: "forgedock-splash" }] });
    write(join(claudeDir, "plugins/known_marketplaces.json"), { forgedock: { installLocation: loc } });
    const r = run();
    assert.equal(r.status, "installed");
    assert.ok(cmds().includes("plugin install forgedock-splash@forgedock --scope user"));
    assert.ok(!cmds().some((c) => c.startsWith("plugin marketplace add")));
  });
  it("is silent when the package has no plugin source", () => {
    assert.equal(run({ pkgRoot: home }).status, "no-source");
  });
});

describe("uninstallSplash / state", () => {
  it("removes plugin, marketplace and staged dir", () => {
    run();
    calls = [];
    const r = uninstallSplash({ home, env: env(), exec: fakeExec() });
    assert.ok(r.removed);
    assert.ok(cmds().includes("plugin uninstall forgedock-splash@forgedock-local"));
    assert.ok(cmds().includes("plugin marketplace remove forgedock-local"));
    assert.ok(!existsSync(splashStageDir(home)));
  });
  it("is a no-op when nothing was installed", () => {
    assert.equal(uninstallSplash({ home, env: env(), exec: fakeExec() }).removed, false);
    assert.equal(calls.length, 0);
  });
  it("state is 'not installed' by default, 'installed' when enabled", () => {
    assert.equal(splashState({ home, env: env() }), "not installed");
    write(join(claudeDir, "settings.json"), { enabledPlugins: { "forgedock-splash@forgedock": true } });
    assert.equal(splashState({ home, env: env() }), "installed");
  });
});
