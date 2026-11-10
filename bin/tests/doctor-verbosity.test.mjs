// `doctor` hides internal/legacy warnings unless --verbose; prerequisites match setup (#5302).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./_tmp.mjs";

const CLI = resolve(import.meta.dirname, "../forgedock.mjs");
let home;
let cwd;
const run = (...args) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
  for (const k of ["FORGE_HOME", "CLAUDE_CONFIG_DIR"]) delete env[k];
  const r = spawnSync(process.execPath, [CLI, "doctor", ...args], { env, cwd, encoding: "utf8", timeout: 60000 });
  return (r.stdout ?? "") + (r.stderr ?? "");
};

before(() => {
  home = tmpDir("doctor-home-");
  cwd = tmpDir("doctor-cwd-");
  mkdirSync(join(home, ".claude"), { recursive: true });
});

describe("doctor verbosity", () => {
  it("default run hides internal and legacy warnings", () => {
    const out = run();
    for (const label of ["FORGE_HOME env var", "Playwright MCP", "CLAUDE.md legacy block", "Version-gated features", "Resource hygiene"]) {
      assert.ok(!new RegExp(`⚠\\s+${label.replace(/[()~.]/g, "\\$&")}`).test(out), `${label} should be hidden`);
    }
  });

  it("--verbose shows them", () => {
    const out = run("--verbose");
    assert.match(out, /⚠\s+FORGE_HOME env var/);
  });

  it("reports the shared prerequisites, yq included", () => {
    const out = run();
    for (const label of ["Node", "git", "Claude Code", "GitHub CLI", "yq"]) {
      assert.match(out, new RegExp(`[✔✗]\\s+${label}\\b`), `${label} line`);
    }
  });
});
