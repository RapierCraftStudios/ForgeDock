// doctor/uninstall against an npm-style install whose links target ~/.forge (#4962).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "forgedock.mjs");
const PKG = join(dirname(BIN), "..");

function setup({ stale = false, mcp = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fd-links-"));
  const claude = join(home, ".claude");
  mkdirSync(join(claude, "commands"), { recursive: true });
  mkdirSync(join(claude, "scripts"), { recursive: true });
  // Persisted copy of one real command and one pipeline script.
  const cmd = "bootstrap.md";
  const src = join(PKG, "commands", cmd);
  const persisted = join(home, ".forge", "commands", cmd);
  mkdirSync(dirname(persisted), { recursive: true });
  writeFileSync(persisted, stale ? "stale\n" : readFileSync(src, "utf-8"));
  symlinkSync(persisted, join(claude, "commands", cmd));
  // Script link into the persisted home whose target no longer exists.
  symlinkSync(join(home, ".forge", "scripts", "classify-lane.sh"), join(claude, "scripts", "classify-lane.sh"));
  if (mcp) writeFileSync(join(home, ".claude.json"), JSON.stringify(mcp));
  return { home, claude, cmd };
}
const run = (home, args, cwd = home) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: "utf-8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), NO_COLOR: "1" },
  });

describe("persisted ~/.forge links (#4962)", () => {
  it("doctor does not flag a link into an up-to-date ~/.forge copy", () => {
    const { home } = setup();
    assert.match(run(home, ["doctor"]).stdout, /Command files[^\n]*\n[^\n]*41\/42 broken/);
  });

  it("doctor reports a stale ~/.forge copy", () => {
    const { home } = setup({ stale: true });
    assert.match(run(home, ["doctor"]).stdout, /bootstrap\.md \(stale ~\/\.forge copy\)/);
  });

  it("uninstall removes links into ~/.forge, including dangling script links", () => {
    const { home, claude, cmd } = setup();
    const r = run(home, ["uninstall"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lstatSyncSafe(join(claude, "commands", cmd)), false);
    assert.equal(lstatSyncSafe(join(claude, "scripts", "classify-lane.sh")), false);
  });

  it("uninstall leaves foreign links alone", () => {
    const { home, claude, cmd } = setup();
    const other = join(home, "mine.md");
    writeFileSync(other, "x");
    rmSync(join(claude, "commands", cmd));
    symlinkSync(other, join(claude, "commands", cmd));
    run(home, ["uninstall"]);
    assert.equal(lstatSyncSafe(join(claude, "commands", cmd)), true);
  });

  it("doctor finds Playwright MCP registered in ~/.claude.json", () => {
    const { home } = setup({ mcp: { mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } } });
    assert.match(run(home, ["doctor"]).stdout, /Playwright MCP[^\n]*registered/);
  });

  it("doctor finds Playwright MCP in project .mcp.json", () => {
    const { home } = setup();
    const proj = join(home, "proj");
    mkdirSync(proj);
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { pw: { command: "npx", args: ["@playwright/mcp"] } } }));
    assert.match(run(home, ["doctor"], proj).stdout, /Playwright MCP[^\n]*registered/);
  });
});

function lstatSyncSafe(p) {
  try { lstatSync(p); return true; } catch { return false; }
}
