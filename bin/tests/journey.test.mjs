/**
 * bin/tests/journey.test.mjs — Unit tests for bin/journey.mjs.
 * Run with: node --test bin/tests/journey.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { writeForgeYaml, backupExisting, detectDescription, makeCtx, preflight, forge, read, review, celebrate, runJourney, manualLowConfidenceKeys, parseInstallTier, findMarkdownFiles } from "../journey.mjs";

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

describe("manualLowConfidenceKeys", () => {
  /** A draft where only `owner` is low-confidence; everything else high/medium. */
  function makeDraft() {
    return {
      project: {
        owner: { value: "your-github-org", confidence: "low", source: "default placeholder", why: "" },
        repo: { value: "ForgeDock", confidence: "high", source: "git remote", why: "" },
        name: { value: "Forge Dock", confidence: "medium", source: "derived from repo slug", why: "" },
      },
      paths: {
        root: { value: "/repo", confidence: "high", source: "process.cwd()", why: "" },
        worktreeBase: { value: "/repo/.claude/worktrees", confidence: "high", source: "derived from root", why: "" },
      },
      branches: {
        default: { value: "main", confidence: "high", source: "git symbolic-ref", why: "" },
        staging: { value: "staging", confidence: "high", source: "git branch -r", why: "" },
      },
      meta: { remoteDetected: true },
    };
  }

  /** Values accepted unchanged from the draft, description left blank. */
  function baseValues(draft) {
    return {
      owner: draft.project.owner.value,
      repo: draft.project.repo.value,
      name: draft.project.name.value,
      description: "",
      root: draft.paths.root.value,
      worktreeBase: draft.paths.worktreeBase.value,
      defaultBranch: draft.branches.default.value,
      stagingBranch: draft.branches.staging.value,
    };
  }

  it("low owner + unchanged value → ['owner']", () => {
    const draft = makeDraft();
    // Give description a value so this test isolates owner-only behavior
    // (description's own low-confidence rule is covered separately below).
    const values = { ...baseValues(draft), description: "A hand-typed description" };
    const res = manualLowConfidenceKeys(draft, { value: "", source: "" }, values);
    assert.deepEqual(res, ["owner"]);
  });

  it("edited value → []", () => {
    const draft = makeDraft();
    const values = { ...baseValues(draft), owner: "edited-owner", description: "A hand-typed description" };
    const res = manualLowConfidenceKeys(draft, { value: "", source: "" }, values);
    assert.deepEqual(res, []);
  });

  it("description: detection empty + user left it empty → flagged low", () => {
    const draft = makeDraft();
    const values = { ...baseValues(draft), owner: "edited-owner" }; // isolate to description
    const res = manualLowConfidenceKeys(draft, { value: "", source: "" }, values);
    assert.ok(res.includes("description"), "description should be flagged when detection and user both left it blank");
  });

  it("description: user typed a value over an empty detection → not flagged", () => {
    const draft = makeDraft();
    const values = { ...baseValues(draft), owner: "edited-owner", description: "A hand-typed description" };
    const res = manualLowConfidenceKeys(draft, { value: "", source: "" }, values);
    assert.ok(!res.includes("description"));
  });

  it("description: detected from README and accepted → not flagged", () => {
    const draft = makeDraft();
    const values = { ...baseValues(draft), owner: "edited-owner", description: "Detected description" };
    const res = manualLowConfidenceKeys(draft, { value: "Detected description", source: "README.md" }, values);
    assert.ok(!res.includes("description"));
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

function stubCtx({ execMap = {}, home = os.tmpdir(), cwd = os.tmpdir(), ...overrides } = {}) {
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
      ...overrides,
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

import { lstatSync, mkdirSync as mkdirSyncFs, symlinkSync } from "node:fs";

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

  it("makeCtx defaults linkStrategy to 'symlink'", () => {
    const { ctx } = stubCtx({});
    assert.equal(ctx.linkStrategy, "symlink");
  });

  it("re-run over our copied files is idempotent (manifest recognizes our copies)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home3-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src3-"));
    mkdirSyncFs(join(forgeHome, "commands", "sub"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "commands", "sub", "b.md"), "B", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // linkStrategy "copy" forces the copy-fallback path deterministically,
    // even on symlink-capable machines (POSIX CI, Developer Mode).
    const first = stubCtx({ home, linkStrategy: "copy" });
    first.ctx.forgeHome = forgeHome;
    const res1 = await forge(first.ctx);
    assert.equal(res1.copied, res1.total);
    assert.equal(res1.installed, 0);
    assert.ok(existsSync(join(home, ".claude", "forgedock", "copied-commands.json")));
    // Honest receipt: when everything was copied, the headline says
    // "installed" (not "linked") and the parenthetical accounts for copied.
    assert.match(first.w.text, /installed/);
    assert.match(first.w.text, new RegExp(`copied ${res1.copied}\\b`));
    assert.doesNotMatch(first.w.text, /commands linked/);

    const second = stubCtx({ home, linkStrategy: "copy" });
    second.ctx.forgeHome = forgeHome;
    const res2 = await forge(second.ctx);

    assert.equal(res2.installed, 0);
    assert.equal(res2.copied, 0);
    assert.equal(res2.skipped, res2.total);
    assert.equal(res2.hookStatus, "already");
    assert.doesNotMatch(second.w.text, /WARNING/);
  });

  it("manifest-tracked file with changed content is updated", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home5-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src5-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-seed the manifest (it's our copy) and a stale copy at the target.
    mkdirSyncFs(join(home, ".claude", "forgedock"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "forgedock", "copied-commands.json"),
      JSON.stringify({ version: 1, files: { "a.md": true } }),
      "utf-8",
    );
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "OLD", "utf-8");

    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.updated, 1);
    assert.equal(readFileSync(target, "utf-8"), "A");
    assert.doesNotMatch(w.text, /WARNING/);
  });

  it("linkStrategy copy replaces a stale symlink with a copy", async (t) => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home6-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src6-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Stale symlink at the target pointing at a different file. Only possible
    // where symlinks can be created — skip otherwise (no Developer Mode).
    const other = join(forgeHome, "other.md");
    writeFileSync(other, "OTHER", "utf-8");
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    try {
      symlinkSync(other, target);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation unavailable (Windows without Developer Mode)");
        return;
      }
      throw err;
    }

    const { ctx } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.updated, 1);
    assert.ok(!lstatSync(target).isSymbolicLink()); // now a regular file, not a link
    assert.equal(readFileSync(target, "utf-8"), "A");
    const manifest = JSON.parse(
      readFileSync(join(home, ".claude", "forgedock", "copied-commands.json"), "utf-8"),
    );
    assert.equal(manifest.files["a.md"], true);
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

// ---------------------------------------------------------------------------
// Task 8: read, review, celebrate, & runJourney tests
// ---------------------------------------------------------------------------

describe("read (Act III)", () => {
  it("returns a draft + description without a git repo (placeholders, low confidence)", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-"));
    writeFileSync(join(cwd, "README.md"), "# X\n\nA test project.\n", "utf-8");
    const { ctx, w } = stubCtx({ cwd });
    const res = await read(ctx);
    assert.equal(res.draft.project.owner.value, "your-github-org");
    assert.equal(res.description.value, "A test project.");
    assert.match(w.text, /\[low\]/); // badge rendered for placeholder
  });

  it("enrichFn is called when ANTHROPIC_API_KEY is set and returns enriched draft", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-enrich-"));
    const original = await read(stubCtx({ cwd }).ctx);
    const { ctx, w } = stubCtx({
      cwd,
      env: { ANTHROPIC_API_KEY: "test-key" },
      enrichFn: (draft) => {
        // Return a structuredClone with the name enriched
        const enriched = structuredClone(draft);
        enriched.project.name.value = "ENRICHED";
        return enriched;
      },
    });
    const res = await read(ctx);
    assert.equal(res.draft.project.name.value, "ENRICHED");
    assert.match(w.text, /enriching with AI/);
  });

  it("enrichFn throws: draft stays original, error message written", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-enrich-fail-"));
    const { ctx, w } = stubCtx({
      cwd,
      env: { ANTHROPIC_API_KEY: "test-key" },
      enrichFn: () => {
        throw new Error("API failed");
      },
    });
    const res = await read(ctx);
    assert.equal(res.draft.project.owner.value, "your-github-org"); // unchanged
    assert.match(w.text, /unavailable/);
  });

  it("no ANTHROPIC_API_KEY: enrichFn is never called", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-no-key-"));
    let enrichFnCalled = false;
    const { ctx, w } = stubCtx({
      cwd,
      env: {},
      enrichFn: () => {
        enrichFnCalled = true;
        return null;
      },
    });
    const res = await read(ctx);
    assert.equal(enrichFnCalled, false);
    assert.match(w.text, /no ANTHROPIC_API_KEY/);
  });
});

describe("review (Act IV)", () => {
  it("non-TTY + no existing config: writes forge.yaml with TODO flags for low fields", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review-"));
    const { ctx } = stubCtx({ cwd });
    const res0 = await read(ctx);
    const res = await review(ctx, res0.draft, res0.description);
    assert.equal(res.written, true);
    assert.equal(res.aborted, false);
    const yaml = readFileSync(join(cwd, "forge.yaml"), "utf-8");
    assert.match(yaml, /# TODO\(forgedock:owner\)/);
    assert.ok(res.todoCount >= 1);
  });

  it("non-TTY + existing config: aborts and leaves the file untouched", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review2-"));
    writeFileSync(join(cwd, "forge.yaml"), "precious: true\n", "utf-8");
    const { ctx } = stubCtx({ cwd });
    const res0 = await read(ctx);
    const res = await review(ctx, res0.draft, res0.description);
    assert.equal(res.aborted, true);
    assert.equal(res.written, false);
    assert.equal(readFileSync(join(cwd, "forge.yaml"), "utf-8"), "precious: true\n");
  });
});

describe("celebrate (Act V)", () => {
  it("prints elapsed time, receipt, and next steps", () => {
    const { ctx, w } = stubCtx({});
    ctx.startedAt = Date.now() - 34000;
    celebrate(ctx, { written: true, todoCount: 2, total: 24, hookStatus: "installed" });
    assert.match(w.text, /Forged\./);
    assert.match(w.text, /34s|3[0-9]s/);
    assert.match(w.text, /work-on next/);
    assert.match(w.text, /2/); // TODO count surfaces in the receipt
  });

  it("when hookStatus is skipped-malformed, mentions hook skipped", () => {
    const { ctx, w } = stubCtx({});
    celebrate(ctx, { written: true, todoCount: 0, total: 5, hookStatus: "skipped-malformed" });
    assert.match(w.text, /hook skipped|NOT active/);
  });
});

// ---------------------------------------------------------------------------
// Task 8: runJourney contract tests
// ---------------------------------------------------------------------------

describe("runJourney", () => {
  it("fresh cwd: resolves exit code 0 and forge.yaml exists", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-journey-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-journey-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// stub\n", "utf-8");

    const initialListenerCount = process.listenerCount("SIGINT");
    const ctx = makeCtx({
      cwd,
      forgeHome,
      home: mkdtempSync(join(os.tmpdir(), "fd-home-journey-")),
      env: {},
      stdout: fakeWriter(),
      mode: "none",
      motion: false,
      linkStrategy: "copy",
    });
    const exitCode = await runJourney(ctx);
    const finalListenerCount = process.listenerCount("SIGINT");

    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(cwd, "forge.yaml")));
    assert.equal(initialListenerCount, finalListenerCount);
  });

  it("pre-existing forge.yaml: resolves exit code 1, file byte-identical", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-journey2-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-journey2-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// stub\n", "utf-8");

    const preContent = "precious: config\n";
    writeFileSync(join(cwd, "forge.yaml"), preContent, "utf-8");

    const ctx = makeCtx({
      cwd,
      forgeHome,
      home: mkdtempSync(join(os.tmpdir(), "fd-home-journey2-")),
      env: {},
      stdout: fakeWriter(),
      mode: "none",
      motion: false,
      linkStrategy: "copy",
    });
    const exitCode = await runJourney(ctx);
    const postContent = readFileSync(join(cwd, "forge.yaml"), "utf-8");

    assert.equal(exitCode, 1);
    assert.equal(postContent, preContent);
  });

  it("SIGINT listener is cleaned up after journey (or error)", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-journey3-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-journey3-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest\n", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// stub\n", "utf-8");

    const initialCount = process.listenerCount("SIGINT");
    const ctx = makeCtx({
      cwd,
      forgeHome,
      home: mkdtempSync(join(os.tmpdir(), "fd-home-journey3-")),
      env: {},
      stdout: fakeWriter(),
      mode: "none",
      motion: false,
      linkStrategy: "copy",
    });

    try {
      await runJourney(ctx);
    } catch {
      // Tolerate any errors; we care about listener cleanup.
    }

    const finalCount = process.listenerCount("SIGINT");
    assert.equal(initialCount, finalCount);
  });
});

// ---------------------------------------------------------------------------
// parseInstallTier — install filter (issue #1346)
// ---------------------------------------------------------------------------

describe("parseInstallTier", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), "fd-tier-"));
  });

  it("returns 'core' when install key is absent", () => {
    const f = join(dir, "core-no-key.md");
    writeFileSync(f, `---\ndescription: a command\n---\n# Body\n`, "utf-8");
    assert.equal(parseInstallTier(f), "core");
  });

  it("returns 'core' when install: core is explicit", () => {
    const f = join(dir, "core-explicit.md");
    writeFileSync(f, `---\ndescription: a command\ninstall: core\n---\n# Body\n`, "utf-8");
    assert.equal(parseInstallTier(f), "core");
  });

  it("returns 'internal' when install: internal", () => {
    const f = join(dir, "internal.md");
    writeFileSync(f, `---\ndescription: benchmark rig\ninstall: internal\n---\n# Body\n`, "utf-8");
    assert.equal(parseInstallTier(f), "internal");
  });

  it("returns 'extras' when install: extras", () => {
    const f = join(dir, "extras.md");
    writeFileSync(f, `---\ndescription: opt-in extra\ninstall: extras\n---\n# Body\n`, "utf-8");
    assert.equal(parseInstallTier(f), "extras");
  });

  it("returns 'core' for unrecognised install value (fail-open)", () => {
    const f = join(dir, "unknown.md");
    writeFileSync(f, `---\ndescription: a command\ninstall: unknown-tier\n---\n# Body\n`, "utf-8");
    assert.equal(parseInstallTier(f), "core");
  });

  it("returns 'core' when file has no frontmatter delimiters (fail-open)", () => {
    const f = join(dir, "no-frontmatter.md");
    writeFileSync(f, `# Just a heading\nNo frontmatter here.\n`, "utf-8");
    assert.equal(parseInstallTier(f), "core");
  });

  it("returns 'core' when file does not exist (fail-open)", () => {
    assert.equal(parseInstallTier(join(dir, "nonexistent.md")), "core");
  });

  it("strips BOM before parsing frontmatter (ref: review-finding #657)", () => {
    const f = join(dir, "bom.md");
    // Write UTF-8 BOM followed by frontmatter with install: internal
    const bom = "\uFEFF";
    writeFileSync(f, `${bom}---\ninstall: internal\n---\n# Body\n`, "utf-8");
    assert.equal(parseInstallTier(f), "internal");
  });

  it("handles quoted install values", () => {
    const f = join(dir, "quoted.md");
    writeFileSync(f, `---\ndescription: a command\ninstall: "internal"\n---\n# Body\n`, "utf-8");
    assert.equal(parseInstallTier(f), "internal");
  });
});

// ---------------------------------------------------------------------------
// findMarkdownFiles — install filter integration (issue #1346)
// ---------------------------------------------------------------------------

describe("findMarkdownFiles — install tier filter", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), "fd-find-"));
  });

  it("includes files with no install key (core by default)", async () => {
    const f = join(dir, "no-key.md");
    writeFileSync(f, `---\ndescription: a command\n---\n# Body\n`, "utf-8");
    const found = await findMarkdownFiles(dir);
    assert.deepEqual(found, [f]);
  });

  it("includes files with install: core", async () => {
    const f = join(dir, "core.md");
    writeFileSync(f, `---\ninstall: core\n---\n# Body\n`, "utf-8");
    const found = await findMarkdownFiles(dir);
    assert.deepEqual(found, [f]);
  });

  it("excludes files with install: internal", async () => {
    const f = join(dir, "internal.md");
    writeFileSync(f, `---\ninstall: internal\n---\n# Body\n`, "utf-8");
    const found = await findMarkdownFiles(dir);
    assert.deepEqual(found, []);
  });

  it("excludes files with install: extras", async () => {
    const f = join(dir, "extras.md");
    writeFileSync(f, `---\ninstall: extras\n---\n# Body\n`, "utf-8");
    const found = await findMarkdownFiles(dir);
    assert.deepEqual(found, []);
  });

  it("returns only core files when the directory contains a mix", async () => {
    writeFileSync(join(dir, "a-core.md"), `---\ninstall: core\n---\n`, "utf-8");
    writeFileSync(join(dir, "b-internal.md"), `---\ninstall: internal\n---\n`, "utf-8");
    writeFileSync(join(dir, "c-no-key.md"), `---\ndescription: x\n---\n`, "utf-8");
    writeFileSync(join(dir, "d-extras.md"), `---\ninstall: extras\n---\n`, "utf-8");
    const found = await findMarkdownFiles(dir);
    assert.deepEqual(found, [
      join(dir, "a-core.md"),
      join(dir, "c-no-key.md"),
    ]);
  });

  it("filters recursively inside subdirectories", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    const core = join(sub, "core-sub.md");
    const internal = join(sub, "internal-sub.md");
    writeFileSync(core, `---\ninstall: core\n---\n`, "utf-8");
    writeFileSync(internal, `---\ninstall: internal\n---\n`, "utf-8");
    const found = await findMarkdownFiles(dir);
    assert.deepEqual(found, [core]);
  });

  it("verifies the 5 known internal specs are excluded from the real commands/ dir", async () => {
    // Resolve commands/ relative to the repo root (two levels up from tests/).
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const commandsDir = join(testsDir, "..", "..", "commands");

    // Skip if we're not running from the repo (e.g. an isolated install).
    if (!existsSync(commandsDir)) return;

    const found = await findMarkdownFiles(commandsDir);
    const foundNames = found.map((f) => f.replace(/.*commands[\\/]/, "").replace(/\\/g, "/"));

    for (const internal of [
      "work-on-monolithic.md",
      "design-bench.md",
      "forge-stats.md",
      "design.md",
      "design-render-critique-loop.md",
    ]) {
      assert.ok(
        !foundNames.includes(internal),
        `Expected ${internal} to be excluded from findMarkdownFiles() output (install: internal)`,
      );
    }

    // Core commands must still be present
    assert.ok(foundNames.includes("work-on.md"), "work-on.md must be included");
    assert.ok(foundNames.includes("review-pr.md"), "review-pr.md must be included");
    assert.ok(foundNames.includes("quality-gate.md"), "quality-gate.md must be included");
  });
});
