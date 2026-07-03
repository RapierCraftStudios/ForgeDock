/**
 * bin/tests/journey.test.mjs — Unit tests for bin/journey.mjs.
 * Run with: node --test bin/tests/journey.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { writeForgeYaml, backupExisting, detectDescription, makeCtx, preflight } from "../journey.mjs";

const VALUES = {
  owner: "RapierCraftStudios",
  repo: "ForgeDock",
  name: "Forge Dock",
  description: 'Turn a "GitHub issue" into a merged PR',
  root: "C:\\proj\\ForgeDock",
  worktreeBase: "C:\\proj\\ForgeDock\\.claude\\worktrees",
  defaultBranch: "main",
  stagingBranch: "staging",
};

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "fd-journey-"));
});

describe("writeForgeYaml", () => {
  it("writes required sections with the given values", () => {
    const out = join(dir, "forge.yaml");
    const res = writeForgeYaml(VALUES, [], out);
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /owner: "RapierCraftStudios"/);
    assert.match(yaml, /repo: "ForgeDock"/);
    assert.match(yaml, /default: "main"/);
    assert.match(yaml, /staging: "staging"/);
    assert.equal(res.todoCount, 0);
  });
  it("escapes quotes and backslashes", () => {
    const out = join(dir, "forge.yaml");
    writeForgeYaml(VALUES, [], out);
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /Turn a \\"GitHub issue\\"/);
    assert.match(yaml, /C:\\\\proj\\\\ForgeDock/);
  });
  it("flags low-confidence keys with TODO comments and counts them", () => {
    const out = join(dir, "forge.yaml");
    const res = writeForgeYaml(VALUES, ["owner", "stagingBranch"], out);
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /owner: "RapierCraftStudios"\s+# TODO\(forgedock:owner\)/);
    assert.match(yaml, /staging: "staging"\s+# TODO\(forgedock:stagingBranch\)/);
    assert.equal(res.todoCount, 2);
  });
  it("escapes newlines so values stay on one line", () => {
    const out = join(dir, "forge.yaml");
    writeForgeYaml({ ...VALUES, description: "line one\nline two" }, ["description"], out);
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /description: "line one\\nline two"\s+# TODO\(forgedock:description\)/);
    assert.doesNotMatch(yaml, /line two"\s*$/m);
  });
});

describe("backupExisting", () => {
  it("returns null when the file does not exist", () => {
    assert.equal(backupExisting(join(dir, "forge.yaml")), null);
  });
  it("renames to forge.yaml.bak and returns basename (no slash-split bug)", () => {
    const out = join(dir, "forge.yaml");
    writeFileSync(out, "x", "utf-8");
    const res = backupExisting(out);
    assert.equal(res.backupName, "forge.yaml.bak");
    assert.ok(existsSync(join(dir, "forge.yaml.bak")));
    assert.ok(!existsSync(out));
  });
  it("timestamps the backup when forge.yaml.bak already exists", () => {
    writeFileSync(join(dir, "forge.yaml"), "x", "utf-8");
    writeFileSync(join(dir, "forge.yaml.bak"), "old", "utf-8");
    const res = backupExisting(join(dir, "forge.yaml"));
    assert.match(res.backupName, /^forge\.yaml\.bak\..+/);
  });
});

describe("detectDescription", () => {
  it("extracts the first README paragraph, stripping markdown", () => {
    writeFileSync(
      join(dir, "README.md"),
      "# Title\n\n**Turn** a [GitHub issue](https://x) into a `merged PR`.\n\nMore.\n",
      "utf-8",
    );
    const res = detectDescription(dir);
    assert.equal(res.value, "Turn a GitHub issue into a merged PR.");
    assert.equal(res.source, "README.md");
  });
  it("falls back to CLAUDE.md, then empty", () => {
    assert.deepEqual(detectDescription(dir), { value: "", source: "" });
    writeFileSync(join(dir, "CLAUDE.md"), "# T\n\nProject brain.\n", "utf-8");
    assert.deepEqual(detectDescription(dir), { value: "Project brain.", source: "CLAUDE.md" });
  });
});

// ---------------------------------------------------------------------------
// Task 5: preflight & makeCtx tests
// ---------------------------------------------------------------------------

/** Writer stub + exec stub factory for act tests. */
function fakeWriter() {
  const chunks = [];
  return { chunks, write(s) { chunks.push(s); return true; }, get text() { return chunks.join(""); }, isTTY: false };
}

function stubCtx({ execMap = {}, home = os.tmpdir(), cwd = os.tmpdir() } = {}) {
  const w = fakeWriter();
  return {
    ctx: makeCtx({
      cwd,
      home,
      forgeHome: "C:/fake/forgedock",
      argv: [],
      env: {},
      stdout: w,
      mode: "none",
      motion: false,
      startedAt: 0,
      exec: (cmd, args) => {
        const key = [cmd, ...(args || [])].join(" ");
        if (key in execMap) {
          const v = execMap[key];
          if (v instanceof Error) throw v;
          return v;
        }
        throw new Error(`ENOENT: ${key}`);
      },
    }),
    w,
  };
}

describe("preflight", () => {
  it("all green when everything is present", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx, w } = stubCtx({
      home,
      execMap: {
        "git --version": "git version 2.45.0",
        "gh --version": "gh version 2.52.0",
        "gh auth status": "Logged in to github.com",
      },
    });
    const res = await preflight(ctx);
    assert.equal(res.checks.every((c) => c.ok), true);
    assert.equal(res.ghReady, true);
    assert.match(w.text, /F O R G E D O C K/);
  });

  it("missing gh yields a fix card and ghReady=false, but does not throw", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home2-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx, w } = stubCtx({
      home,
      execMap: { "git --version": "git version 2.45.0" },
    });
    const res = await preflight(ctx);
    const gh = res.checks.find((c) => c.name === "GitHub CLI");
    assert.equal(gh.ok, false);
    assert.equal(res.ghReady, false);
    assert.match(w.text, /cli\.github\.com/); // fix card content
  });

  it("missing ~/.claude flags Claude Code check", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home3-"));
    const { ctx } = stubCtx({ home, execMap: { "git --version": "git version 2.45.0" } });
    const res = await preflight(ctx);
    const cc = res.checks.find((c) => c.name === "Claude Code");
    assert.equal(cc.ok, false);
  });

  it("gh installed but unauthenticated → auth fix card, ghReady=false", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home4-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx, w } = stubCtx({
      home,
      execMap: {
        "git --version": "git version 2.45.0",
        "gh --version": "gh version 2.52.0",
        // no "gh auth status" key → stub exec throws for it
      },
    });
    const res = await preflight(ctx);
    const gh = res.checks.find((c) => c.name === "GitHub CLI");
    assert.equal(gh.ok, false);
    assert.equal(res.ghReady, false);
    assert.match(w.text, /gh auth login/);
    assert.doesNotMatch(w.text, /cli\.github\.com/); // installed → no install card
  });

  it("old Node version → failed check with upgrade fix card", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home5-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx, w } = stubCtx({ home, execMap: { "git --version": "git version 2.45.0" } });
    ctx.nodeVersion = "16.20.0";
    const res = await preflight(ctx);
    const node = res.checks.find((c) => c.name === "Node");
    assert.equal(node.ok, false);
    assert.match(w.text, /nodejs\.org/);
  });
});

// ---------------------------------------------------------------------------
// Task 6: forge & findMarkdownFiles tests
// ---------------------------------------------------------------------------

import { forge } from "../journey.mjs";
import { lstatSync, mkdirSync as mkdirSyncFs } from "node:fs";

/**
 * A command is installed if the target is a symlink (Developer Mode / admin /
 * POSIX) OR a regular-file copy whose content equals the source (Windows
 * copy-fallback). Both count as success.
 */
function assertInstalled(target, sourceContent) {
  const st = lstatSync(target); // throws if missing
  if (st.isSymbolicLink()) return;
  assert.equal(readFileSync(target, "utf-8"), sourceContent);
}

describe("forge (Act II)", () => {
  it("installs commands (symlink or copy-fallback), registers hook, reports counts", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src-"));
    mkdirSyncFs(join(forgeHome, "commands", "sub"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "commands", "sub", "b.md"), "B", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.total, 2);
    assert.equal(res.installed + res.copied, res.total);
    assert.equal(res.hookStatus, "installed");
    assertInstalled(join(home, ".claude", "commands", "a.md"), "A");
    assertInstalled(join(home, ".claude", "commands", "sub", "b.md"), "B");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    assert.match(JSON.stringify(settings.hooks.SessionStart), /session-start\.mjs/);
    assert.match(w.text, /2.*commands|commands.*2/i);
  });

  it("second run is idempotent: skips links, hook already", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home2-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src2-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const { ctx } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    await forge(ctx);
    const res2 = await forge(makeCtx({ home, forgeHome, stdout: { write: () => true }, mode: "none", motion: false }));
    assert.equal(res2.installed, 0);
    assert.equal(res2.copied, 0);
    assert.equal(res2.skipped, 1);
    assert.equal(res2.hookStatus, "already");
  });

  it("re-run over our copied files is idempotent (manifest recognizes our copies)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home3-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src3-"));
    mkdirSyncFs(join(forgeHome, "commands", "sub"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "commands", "sub", "b.md"), "B", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const first = stubCtx({ home });
    first.ctx.forgeHome = forgeHome;
    await forge(first.ctx);

    const second = stubCtx({ home });
    second.ctx.forgeHome = forgeHome;
    const res2 = await forge(second.ctx);

    assert.equal(res2.installed, 0);
    assert.equal(res2.copied, 0);
    assert.equal(res2.skipped + res2.updated, res2.total);
    assert.equal(res2.hookStatus, "already");
    assert.doesNotMatch(second.w.text, /WARNING/);
  });

  it("user-owned regular file is never clobbered", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home4-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src4-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-create the target as a user-owned regular file — no manifest entry.
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "USER OWNED", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(readFileSync(target, "utf-8"), "USER OWNED");
    assert.equal(res.skipped, 1);
    assert.match(w.text, /WARNING/);
  });
});
