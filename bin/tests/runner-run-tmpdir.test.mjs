// forge#3572: per-run disk-backed TMPDIR, confined cleanup, disk-full classification, spec rules.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRunTmpRoot, runTmpDir, withRunTmpdir } from "../runner.mjs";
import { cleanupRunTmpdir } from "../engine.mjs";
import { isDiskQuotaText, isDiskQuotaError, codeForRunnerError, OUTCOME_CODES } from "../engine/outcome-codes.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let cwd;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "fd-tmproot-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("resolveRunTmpRoot / runTmpDir", () => {
  it("defaults to ~/.forge/tmp when nothing is configured or exported", () => {
    assert.equal(resolveRunTmpRoot(cwd, {}), join(homedir(), ".forge", "tmp"));
  });
  it("returns null (operator-managed) when TMPDIR or CLAUDE_CODE_TMPDIR is exported and no tmp_root is set", () => {
    assert.equal(resolveRunTmpRoot(cwd, { TMPDIR: "/mnt/big" }), null);
    assert.equal(resolveRunTmpRoot(cwd, { CLAUDE_CODE_TMPDIR: "/mnt/big" }), null);
  });
  it("forge.yaml engine.tmp_root wins over an exported TMPDIR; relative values are ignored", () => {
    writeFileSync(join(cwd, "forge.yaml"), "engine:\n  tmp_root: /data/forge-tmp\n");
    assert.equal(resolveRunTmpRoot(cwd, { TMPDIR: "/mnt/big" }), "/data/forge-tmp");
    writeFileSync(join(cwd, "forge.yaml"), "engine:\n  tmp_root: relative/dir\n");
    assert.equal(resolveRunTmpRoot(cwd, {}), join(homedir(), ".forge", "tmp"));
  });
  it("expands a ~-prefixed tmp_root", () => {
    writeFileSync(join(cwd, "forge.yaml"), "engine:\n  tmp_root: ~/scratch\n");
    assert.equal(resolveRunTmpRoot(cwd, {}), join(homedir(), "scratch"));
  });
  it("runTmpDir is per-issue and rejects empty/non-numeric issues (never the root)", () => {
    assert.equal(runTmpDir("/r", 7), join("/r", "7"));
    assert.notEqual(runTmpDir("/r", 7), runTmpDir("/r", 8));
    for (const bad of ["", null, undefined, "../x", "1/2", "a"]) assert.equal(runTmpDir("/r", bad), null);
    assert.equal(runTmpDir(null, 7), null);
  });
});

describe("withRunTmpdir", () => {
  it("sets TMPDIR and CLAUDE_CODE_TMPDIR to the per-run dir and creates it", () => {
    const root = join(cwd, "root");
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    const env = withRunTmpdir({ TMPDIR: "/tmp" }, { issue: "55", cwd });
    assert.equal(env.TMPDIR, join(root, "55"));
    assert.equal(env.CLAUDE_CODE_TMPDIR, join(root, "55"));
    assert.ok(existsSync(join(root, "55")));
  });
  it("leaves the env untouched when the operator owns the tmp root or the issue is unknown", () => {
    assert.deepEqual(withRunTmpdir({ TMPDIR: "/mnt/x" }, { issue: "55", cwd }), { TMPDIR: "/mnt/x" });
    assert.deepEqual(withRunTmpdir({}, { issue: null, cwd }), {});
  });
});

describe("cleanupRunTmpdir", () => {
  it("removes only the issue dir under the root, leaving siblings and the root", () => {
    const root = join(cwd, "root");
    mkdirSync(join(root, "55"), { recursive: true });
    mkdirSync(join(root, "56"), { recursive: true });
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    assert.equal(cleanupRunTmpdir(55, { cwd, env: {} }), true);
    assert.ok(!existsSync(join(root, "55")));
    assert.ok(existsSync(join(root, "56")));
  });
  it("never deletes an operator-exported TMPDIR and never throws", () => {
    const op = join(cwd, "op"); mkdirSync(join(op, "55"), { recursive: true });
    assert.equal(cleanupRunTmpdir(55, { cwd, env: { TMPDIR: op } }), false);
    assert.ok(existsSync(join(op, "55")));
    assert.equal(cleanupRunTmpdir("../x", { cwd, env: {} }), false);
    assert.equal(cleanupRunTmpdir(55, { cwd, env: {}, rm: () => { throw new Error("boom"); } }), false);
  });
});

describe("disk-full classification", () => {
  it("matches EDQUOT/ENOSPC/errno text and not unrelated failures", () => {
    for (const t of ["EDQUOT: quota", "ENOSPC", "Unknown system error -122: write", "errno -28", "No space left on device", "Disk quota exceeded", "pwd: write error: Disk quota exceeded"])
      assert.ok(isDiskQuotaText(t), t);
    for (const t of ["claude CLI exited with status 1", "errno -2", "errno 1228", "", null, undefined])
      assert.ok(!isDiskQuotaText(t), String(t));
  });
  it("isDiskQuotaError reads message, stderr, code and errno", () => {
    assert.ok(isDiskQuotaError(new Error("write: Disk quota exceeded")));
    assert.ok(isDiskQuotaError(Object.assign(new Error("x"), { code: "CLI_BACKEND_FAILED", stderr: "ENOSPC" })));
    assert.ok(isDiskQuotaError(Object.assign(new Error("x"), { errno: -122 })));
    assert.ok(!isDiskQuotaError(Object.assign(new Error("x"), { code: "CLI_BACKEND_FAILED" })));
  });
  it("codeForRunnerError maps disk-full to infra.disk_quota, even for CLI_BACKEND_FAILED", () => {
    assert.equal(codeForRunnerError(Object.assign(new Error("Disk quota exceeded"), { code: "CLI_BACKEND_FAILED" })), OUTCOME_CODES.INFRA_DISK_QUOTA);
    assert.equal(codeForRunnerError(Object.assign(new Error("boom"), { code: "CLI_BACKEND_FAILED" })), OUTCOME_CODES.ENGINE_ERROR);
  });
});

describe("spec rules (forge#3572)", () => {
  const read = (p) => readFileSync(join(REPO, p), "utf8");
  it("validate.md and implement.md direct venvs under $TMPDIR", () => {
    for (const p of ["commands/work-on/build/validate.md", "commands/work-on/build/implement.md"])
      assert.match(read(p), /\$TMPDIR\/forge-venv-/, p);
  });
  it("review specs carve EDQUOT/ENOSPC out of review-panel-integrity", () => {
    for (const p of ["commands/review-pr.md", "commands/review-pr-staging.md"])
      assert.match(read(p), /Disk-full carve-out.*EDQUOT.*ENOSPC/s, p);
  });
  it("no command spec hardcodes a /tmp venv path", () => {
    const walk = (d) => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".md") ? [f] : []; });
    for (const f of walk(join(REPO, "commands")))
      assert.doesNotMatch(readFileSync(f, "utf8"), /\/tmp\/[A-Za-z_$-]*(venv|env)/, f);
  });
});
