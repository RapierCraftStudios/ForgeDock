// #5415: staging must carry at least main's released version, and the two
// manifests must agree, or Deploy Version Guard fails the release PR.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const semver = (v) => v.match(/^(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);

describe("version sync (#5415)", () => {
  it("package.json and .claude-plugin/plugin.json carry the same version", () => {
    assert.equal(read(".claude-plugin/plugin.json").version, read("package.json").version);
  });

  it("package.json version is not lower than origin/main's", (t) => {
    let main;
    try {
      main = JSON.parse(execFileSync("git", ["show", "origin/main:package.json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).version;
    } catch { t.skip("origin/main not available"); return; }
    const [a, b] = [semver(read("package.json").version), semver(main)];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(cmp >= 0, `package.json ${a.join(".")} is below main ${b.join(".")}`);
  });
});
