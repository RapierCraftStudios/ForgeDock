// forge#3572: per-run disk-backed TMPDIR, confined cleanup, disk-full classification, spec rules.
import { tmpDir } from "./_tmp.mjs";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRunTmpRoot, runTmpDir, withRunTmpdir, repoKey, withLeaseHolder, runCliBackend, getToolHandlers, loadCommandSpec } from "../runner.mjs";
import { cleanupRunTmpdir } from "../engine.mjs";
import { isDiskQuotaText, isDiskQuotaError, codeForRunnerError, OUTCOME_CODES } from "../engine/outcome-codes.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let cwd;
beforeEach(() => { cwd = tmpDir("fd-tmproot-"); });
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
    assert.equal(runTmpDir("/r", 7, cwd), join("/r", repoKey(cwd), "7"));
    assert.notEqual(runTmpDir("/r", 7, cwd), runTmpDir("/r", 8, cwd));
    for (const bad of ["", null, undefined, "../x", "1/2", "a"]) assert.equal(runTmpDir("/r", bad, cwd), null);
    assert.equal(runTmpDir(null, 7, cwd), null);
  });
  it("two repos with the same issue number get distinct dirs; the same cwd is stable", () => {
    const other = tmpDir("fd-tmproot-");
    try {
      assert.notEqual(runTmpDir("/r", 42, cwd), runTmpDir("/r", 42, other));
      assert.equal(runTmpDir("/r", 42, cwd), runTmpDir("/r", 42, cwd));
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
  it("repoKey is path-safe: no separators, never empty, never dot segments", () => {
    for (const c of ["/", "/a/b c/..weird", "/tmp/we ird;$(x)", "relative/nonexistent/dir"]) {
      const k = repoKey(c);
      assert.match(k, /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/, c);
      assert.ok(!k.startsWith("."), c);
    }
  });
});

describe("withRunTmpdir", () => {
  it("sets TMPDIR and CLAUDE_CODE_TMPDIR to the per-run dir and creates it", () => {
    const root = join(cwd, "root");
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    const env = withRunTmpdir({ TMPDIR: "/tmp" }, { issue: "55", cwd });
    const dir = join(root, repoKey(cwd), "55");
    assert.equal(env.TMPDIR, dir);
    assert.equal(env.CLAUDE_CODE_TMPDIR, dir);
    assert.ok(existsSync(dir));
  });
  it("creates the run dir and its repo-key parent with mode 0700", () => {
    const root = join(cwd, "root");
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    const env = withRunTmpdir({}, { issue: "55", cwd });
    assert.equal(statSync(env.TMPDIR).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(env.TMPDIR)).mode & 0o777, 0o700);
  });
  it("tightens a pre-existing loose-mode dir owned by us", () => {
    const root = join(cwd, "root");
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    const dir = join(root, repoKey(cwd), "55");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const env = withRunTmpdir({}, { issue: "55", cwd });
    assert.equal(env.TMPDIR, dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
  it("does not use a pre-existing symlink at the run dir path", () => {
    const root = join(cwd, "root");
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    const target = join(cwd, "victim"); mkdirSync(target);
    mkdirSync(join(root, repoKey(cwd)), { recursive: true });
    symlinkSync(target, join(root, repoKey(cwd), "55"));
    assert.deepEqual(withRunTmpdir({ TMPDIR: "/tmp" }, { issue: "55", cwd }), { TMPDIR: "/tmp" });
  });
  it("leaves the env untouched when the operator owns the tmp root or the issue is unknown", () => {
    assert.deepEqual(withRunTmpdir({ TMPDIR: "/mnt/x" }, { issue: "55", cwd }), { TMPDIR: "/mnt/x" });
    assert.deepEqual(withRunTmpdir({}, { issue: null, cwd }), {});
  });
});

describe("cleanupRunTmpdir", () => {
  it("removes only the issue dir under the root, leaving siblings and the root", () => {
    const root = join(cwd, "root");
    mkdirSync(join(root, repoKey(cwd), "55"), { recursive: true });
    mkdirSync(join(root, repoKey(cwd), "56"), { recursive: true });
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    assert.equal(cleanupRunTmpdir(55, { cwd, env: {} }), true);
    assert.ok(!existsSync(join(root, repoKey(cwd), "55")));
    assert.ok(existsSync(join(root, repoKey(cwd), "56")));
  });
  it("cleanup of one repo's run leaves another repo's same-numbered dir intact", () => {
    const root = join(cwd, "root");
    const other = tmpDir("fd-tmproot-");
    try {
      const yaml = `engine:\n  tmp_root: ${root}\n`;
      writeFileSync(join(cwd, "forge.yaml"), yaml);
      writeFileSync(join(other, "forge.yaml"), yaml);
      const a = withRunTmpdir({}, { issue: "55", cwd }).TMPDIR;
      const b = withRunTmpdir({}, { issue: "55", cwd: other }).TMPDIR;
      assert.notEqual(a, b);
      assert.equal(cleanupRunTmpdir(55, { cwd, env: {} }), true);
      assert.ok(!existsSync(a));
      assert.ok(existsSync(b));
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
  it("cleanup of a symlinked run dir removes the link only, never the target", () => {
    const root = join(cwd, "root");
    writeFileSync(join(cwd, "forge.yaml"), `engine:\n  tmp_root: ${root}\n`);
    const target = join(cwd, "victim"); mkdirSync(target); writeFileSync(join(target, "f"), "x");
    mkdirSync(join(root, repoKey(cwd)), { recursive: true });
    symlinkSync(target, join(root, repoKey(cwd), "55"));
    cleanupRunTmpdir(55, { cwd, env: {} });
    assert.ok(existsSync(join(target, "f")));
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

describe("orphan marker: FORGE_LEASE_HOLDER in the phase child env (forge#3724)", () => {
  it("orphan-marker-stamps-valid-holder-only", () => {
    assert.equal(withLeaseHolder({}, "cli_box-1.local_123").FORGE_LEASE_HOLDER, "cli_box-1.local_123");
    for (const bad of [null, undefined, "", "cli_123", "x; rm -rf", "cli_h_5\nX=1", 5])
      assert.deepEqual(withLeaseHolder({ A: "1" }, bad), { A: "1" }, String(bad));
  });
  it("orphan-marker-cli-backend-env", () => {
    const envs = [];
    const spawnFn = (_b, _a, o) => { envs.push(o.env); return { status: 0, stdout: "", stderr: "" }; };
    const base = { spec: loadCommandSpec(join(REPO, "commands"), "work-on"), userMessage: "x", args: ["3724"], cwd, logger: { log: () => {} }, spawnFn };
    runCliBackend({ ...base, leaseHolder: "cli_h_77" });
    runCliBackend(base);
    assert.equal(envs[0].FORGE_LEASE_HOLDER, "cli_h_77");
    assert.equal(envs[1].FORGE_LEASE_HOLDER, undefined);
  });
  it("orphan-marker-run-bash-env", () => {
    const cmd = "node -e \"process.stdout.write(process.env.FORGE_LEASE_HOLDER || 'ABSENT')\"";
    assert.equal(getToolHandlers(cwd, null, "cli_h_77").run_bash({ command: cmd }).trim(), "cli_h_77");
    assert.equal(getToolHandlers(cwd, null, "not valid").run_bash({ command: cmd }).trim(), "ABSENT");
  });
});
