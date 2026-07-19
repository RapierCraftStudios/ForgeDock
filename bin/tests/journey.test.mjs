/**
 * bin/tests/journey.test.mjs — Unit tests for bin/journey.mjs.
 * Run with: node --test bin/tests/journey.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync, chmodSync, utimesSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { writeForgeYaml, backfillForgeYaml, backupExisting, detectDescription, makeCtx, preflight, forge, read, review, celebrate, connect, maybeOfferDemo, openUrl, runJourney, manualLowConfidenceKeys, parseInstallTier, findMarkdownFiles, isEphemeralCachePath, detectCrossEnvInstall, validateForgeYamlShape, writeInstallReceipt, persistHome, isSymlinkTraversable, pruneStaleExtensionlessEntries } from "../journey.mjs";
import { detectEnvironment } from "../env-detect.mjs";

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
  it("uses atomic tmp+rename: no partial .tmp left on write failure (ref: #1396)", () => {
    // Simulate a write failure by pointing outputPath at a directory (writeFileSync
    // throws EISDIR — a cheap stand-in for ENOSPC without needing a real disk-full condition).
    const out = join(dir, "forge.yaml");
    mkdirSync(out); // make outputPath a directory so writeFileSync to .tmp fails
    assert.throws(() => writeForgeYaml(VALUES, [], out), /EISDIR|EEXIST|EPERM/);
    // The .tmp must not survive the failure
    assert.ok(!existsSync(out + ".tmp"), ".tmp file must be cleaned up on write failure");
  });
  it("leaves no stale .tmp after a successful write", () => {
    const out = join(dir, "forge.yaml");
    writeForgeYaml(VALUES, [], out);
    assert.ok(existsSync(out), "forge.yaml must exist after write");
    assert.ok(!existsSync(out + ".tmp"), ".tmp must be gone after successful write");
  });
  it("emits all 16 optional sections from forge.yaml.example (#1983)", () => {
    const out = join(dir, "forge.yaml");
    writeForgeYaml(VALUES, [], out);
    const yaml = readFileSync(out, "utf-8");
    const optionalSections = [
      "AGENTS",
      "REPOS",
      "PROJECT BOARD",
      "PIPELINE",
      "SERVICES",
      "REVIEW",
      "VERIFICATION",
      "DEPLOY",
      "AUTOPILOT",
      "BILLING",
      "DEVDOCS",
      "ADAPTIVE_SCRIPTS",
      "LEARNED",
      "INDEX",
      "ATTRIBUTION",
      "PATTERN_FEEDS",
    ];
    for (const name of optionalSections) {
      assert.match(
        yaml,
        new RegExp(`# ${name} \\(OPTIONAL\\)`),
        `missing optional section banner: ${name}`,
      );
    }
    // Every line of every new/existing optional section must stay commented out —
    // never parsed as active YAML.
    assert.doesNotMatch(yaml, /^agents:/m);
    assert.doesNotMatch(yaml, /^pipeline:/m);
    assert.doesNotMatch(yaml, /^services:/m);
    assert.doesNotMatch(yaml, /^deploy:/m);
    assert.doesNotMatch(yaml, /^autopilot:/m);
    assert.doesNotMatch(yaml, /^billing:/m);
    assert.doesNotMatch(yaml, /^devdocs:/m);
    assert.doesNotMatch(yaml, /^adaptive_scripts:/m);
    assert.doesNotMatch(yaml, /^learned:/m);
    assert.doesNotMatch(yaml, /^index:/m);
    assert.doesNotMatch(yaml, /^attribution:/m);
    assert.doesNotMatch(yaml, /^pattern_feeds:/m);
  });
});

describe("backfillForgeYaml (#1982)", () => {
  const ALL_16_KEYS = [
    "agents", "repos", "project_board", "pipeline", "services", "review",
    "verification", "deploy", "autopilot", "billing", "devdocs",
    "adaptive_scripts", "learned", "index", "attribution", "pattern_feeds",
  ];

  it("returns present:false and does nothing when forge.yaml does not exist", () => {
    const res = backfillForgeYaml(dir);
    assert.deepEqual(res, { present: false, added: [], alreadyPresent: [] });
    assert.ok(!existsSync(join(dir, "forge.yaml")));
  });

  it("adds all 16 optional sections to a minimal (required-only) forge.yaml", () => {
    const out = join(dir, "forge.yaml");
    writeFileSync(
      out,
      `project:\n  name: "X"\n  owner: "o"\n  repo: "r"\n  description: "d"\n\npaths:\n  root: "/tmp"\n  worktree_base: "/tmp/wt"\n\nbranches:\n  default: "main"\n  staging: "staging"\n  feature_pattern: "milestone/{slug}"\n`,
      "utf-8",
    );
    const res = backfillForgeYaml(dir);
    assert.equal(res.present, true);
    assert.deepEqual([...res.added].sort(), [...ALL_16_KEYS].sort());
    assert.deepEqual(res.alreadyPresent, []);

    const yaml = readFileSync(out, "utf-8");
    for (const key of ALL_16_KEYS) {
      assert.match(yaml, new RegExp(`^#\\s?${key}:`, "m"), `missing backfilled stub for ${key}`);
    }
    // Backfilled sections stay commented out — never parsed as active YAML.
    for (const key of ALL_16_KEYS) {
      assert.doesNotMatch(yaml, new RegExp(`^${key}:`, "m"), `${key} must remain commented out`);
    }
  });

  it("is a no-op when writeForgeYaml() already emitted all 16 sections", () => {
    const out = join(dir, "forge.yaml");
    writeForgeYaml(VALUES, [], out);
    const before = readFileSync(out, "utf-8");
    const res = backfillForgeYaml(dir);
    assert.equal(res.added.length, 0);
    assert.equal(res.alreadyPresent.length, 16);
    assert.equal(readFileSync(out, "utf-8"), before, "file must be untouched when nothing is missing");
  });

  it("adds only the sections missing from a partially-migrated forge.yaml, leaving the rest untouched", () => {
    const out = join(dir, "forge.yaml");
    // Simulate a pre-#1983 file: required sections + only 2 of the 16 optional stubs.
    const original = `project:\n  name: "X"\n  owner: "o"\n  repo: "r"\n  description: "d"\n\npaths:\n  root: "/tmp"\n  worktree_base: "/tmp/wt"\n\nbranches:\n  default: "main"\n  staging: "staging"\n  feature_pattern: "milestone/{slug}"\n\n# repos:\n#   default:\n#     repo: "o/r"\n\n# billing:\n#   enabled: false\n`;
    writeFileSync(out, original, "utf-8");
    const res = backfillForgeYaml(dir);
    assert.deepEqual([...res.alreadyPresent].sort(), ["billing", "repos"]);
    assert.equal(res.added.length, 14);
    assert.ok(!res.added.includes("repos"));
    assert.ok(!res.added.includes("billing"));

    const yaml = readFileSync(out, "utf-8");
    // Original content must remain byte-for-byte at the start of the file.
    assert.ok(yaml.startsWith(original.trimEnd()), "existing content must be preserved unchanged as a prefix");
    for (const key of res.added) {
      assert.match(yaml, new RegExp(`^#\\s?${key}:`, "m"));
    }
  });

  it("is idempotent — running twice produces no further changes on the second run", () => {
    const out = join(dir, "forge.yaml");
    writeFileSync(
      out,
      `project:\n  name: "X"\n  owner: "o"\n  repo: "r"\n  description: "d"\n\npaths:\n  root: "/tmp"\n  worktree_base: "/tmp/wt"\n\nbranches:\n  default: "main"\n  staging: "staging"\n  feature_pattern: "milestone/{slug}"\n`,
      "utf-8",
    );
    backfillForgeYaml(dir);
    const afterFirst = readFileSync(out, "utf-8");
    const res2 = backfillForgeYaml(dir);
    assert.equal(res2.added.length, 0);
    assert.equal(res2.alreadyPresent.length, 16);
    assert.equal(readFileSync(out, "utf-8"), afterFirst, "second run must not modify the file");
  });

  it("treats an active (uncommented) section as already present and does not duplicate it", () => {
    const out = join(dir, "forge.yaml");
    writeFileSync(
      out,
      `project:\n  name: "X"\n  owner: "o"\n  repo: "r"\n  description: "d"\n\npaths:\n  root: "/tmp"\n  worktree_base: "/tmp/wt"\n\nbranches:\n  default: "main"\n  staging: "staging"\n  feature_pattern: "milestone/{slug}"\n\nbilling:\n  enabled: true\n`,
      "utf-8",
    );
    const res = backfillForgeYaml(dir);
    assert.ok(res.alreadyPresent.includes("billing"));
    assert.ok(!res.added.includes("billing"));
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /^billing:\n  enabled: true$/m);
    // Only one "billing:" (active or stub) occurrence — no duplicate stub appended.
    assert.equal((yaml.match(/^#?\s?billing:/gm) || []).length, 1);
  });

  it("uses atomic tmp+rename: no stale .tmp left after a successful backfill (ref: #1396)", () => {
    const out = join(dir, "forge.yaml");
    writeFileSync(
      out,
      `project:\n  name: "X"\n  owner: "o"\n  repo: "r"\n  description: "d"\n\npaths:\n  root: "/tmp"\n  worktree_base: "/tmp/wt"\n\nbranches:\n  default: "main"\n  staging: "staging"\n  feature_pattern: "milestone/{slug}"\n`,
      "utf-8",
    );
    backfillForgeYaml(dir);
    assert.ok(!existsSync(out + ".tmp"), ".tmp must be gone after a successful backfill");
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
  it("rotates the existing .bak to a timestamped file, then takes its place (forge#1850)", () => {
    // Regression fix: .bak must always hold the MOST RECENT pre-write state,
    // not just the FIRST one ever captured. Before this fix, a second clobber
    // left the original good .bak untouched and rotated the already-stubbed
    // current file into a timestamped sibling instead — the exact inversion
    // that buried the one good copy behind newer-looking garbage.
    writeFileSync(join(dir, "forge.yaml.bak"), "generation-1 (old)", "utf-8");
    writeFileSync(join(dir, "forge.yaml"), "generation-2 (current)", "utf-8");
    const res = backupExisting(join(dir, "forge.yaml"));
    // .bak now holds the just-clobbered "current" content, not the old one.
    assert.equal(res.backupName, "forge.yaml.bak");
    assert.equal(readFileSync(join(dir, "forge.yaml.bak"), "utf-8"), "generation-2 (current)");
    // The old generation-1 content survived — rotated to a timestamped file.
    const files = readdirSync(dir);
    const rotated = files.filter((f) => /^forge\.yaml\.bak\..+/.test(f));
    assert.equal(rotated.length, 1, "exactly one rotated (timestamped) backup should exist");
    assert.equal(readFileSync(join(dir, rotated[0]), "utf-8"), "generation-1 (old)");
  });

  it("preserves full history across 3 successive overwrites — nothing silently destroyed (forge#1850)", () => {
    writeFileSync(join(dir, "forge.yaml"), "gen-1 (originally good config)", "utf-8");
    backupExisting(join(dir, "forge.yaml")); // gen-1 -> .bak

    writeFileSync(join(dir, "forge.yaml"), "gen-2 (stub)", "utf-8");
    backupExisting(join(dir, "forge.yaml")); // gen-1 -> timestamped, gen-2 -> .bak

    writeFileSync(join(dir, "forge.yaml"), "gen-3 (stub)", "utf-8");
    backupExisting(join(dir, "forge.yaml")); // gen-2 -> timestamped, gen-3 -> .bak

    // .bak always holds the most recent pre-write state (gen-3, the content
    // just moved out of forge.yaml) — the best next guess for "undo my last mistake".
    assert.equal(readFileSync(join(dir, "forge.yaml.bak"), "utf-8"), "gen-3 (stub)");

    // Every generation is recoverable somewhere on disk — nothing was ever
    // silently overwritten without a trace, including the original good config.
    const files = readdirSync(dir);
    const allBackupContents = files
      .filter((f) => f.startsWith("forge.yaml.bak"))
      .map((f) => readFileSync(join(dir, f), "utf-8"));
    assert.ok(
      allBackupContents.includes("gen-1 (originally good config)"),
      "the original good config must still be recoverable from a timestamped backup",
    );
    assert.ok(allBackupContents.includes("gen-2 (stub)"));
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
      // Default to "CLI not available" so tests never depend on whether the
      // host running the suite happens to have a real, authenticated
      // `claude` binary on PATH — that would make Act III's enrichment
      // ladder resolve to the cli backend and shell out for real (issue
      // #2004). Individual tests override this via `overrides` to exercise
      // the cli-backend-present path deterministically.
      isCliAvailableFn: () => false,
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

  it("adds Platform/WSL/Shell rows after GitHub CLI without disturbing ghReady's index", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home6-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx } = stubCtx({
      home,
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      execMap: {
        "git --version": "git version 2.45.0",
        "gh --version": "gh version 2.52.0",
        "gh auth status": "Logged in to github.com",
      },
    });
    const res = await preflight(ctx);
    assert.equal(res.checks.length, 7);
    assert.equal(res.checks[3].name, "GitHub CLI");
    assert.equal(res.ghReady, true);

    const platformRow = res.checks.find((c) => c.name === "Platform");
    const wslRow = res.checks.find((c) => c.name === "WSL");
    const shellRow = res.checks.find((c) => c.name === "Shell");
    assert.equal(platformRow.ok, true);
    assert.match(platformRow.detail, /Linux/);
    assert.match(platformRow.detail, /bash/);
    assert.equal(wslRow.ok, true);
    assert.equal(wslRow.detail, "not detected");
    assert.equal(shellRow.ok, true);
    assert.equal(shellRow.detail, "bash");

    // Existing checks unaffected — still all-green with the informational rows included.
    assert.equal(res.checks.every((c) => c.ok), true);
  });

  it("Platform/WSL rows reflect WSL detection when WSL_DISTRO_NAME is injected", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home7-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx } = stubCtx({
      home,
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu-22.04" },
      execMap: { "git --version": "git version 2.45.0" },
    });
    const res = await preflight(ctx);
    const wslRow = res.checks.find((c) => c.name === "WSL");
    const platformRow = res.checks.find((c) => c.name === "Platform");
    assert.equal(wslRow.detail, "Ubuntu-22.04");
    assert.match(platformRow.detail, /WSL: Ubuntu-22\.04/);
  });

  it("Platform row reports Windows label + shell when platform/release are injected as win32", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home8-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx } = stubCtx({
      home,
      platform: "win32",
      release: "10.0.22631",
      env: { PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules" },
      execMap: { "git --version": "git version 2.45.0" },
    });
    const res = await preflight(ctx);
    const platformRow = res.checks.find((c) => c.name === "Platform");
    const shellRow = res.checks.find((c) => c.name === "Shell");
    assert.match(platformRow.detail, /Windows 11/);
    assert.match(platformRow.detail, /PowerShell/);
    assert.equal(shellRow.detail, "PowerShell");
  });
});

// ---------------------------------------------------------------------------
// Task 6: forge & findMarkdownFiles tests
// ---------------------------------------------------------------------------

import { lstatSync, mkdirSync as mkdirSyncFs, symlinkSync, statSync, readlinkSync } from "node:fs";

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

describe("isEphemeralCachePath", () => {
  it("recognizes npm's npx cache (POSIX shape)", () => {
    assert.equal(isEphemeralCachePath("/home/user/.npm/_npx/a1b2c3/node_modules/forgedock"), true);
  });

  it("recognizes npm's npx cache (Windows shape)", () => {
    assert.equal(
      isEphemeralCachePath("C:\\Users\\user\\AppData\\Local\\npm-cache\\_npx\\a1b2c3\\node_modules\\forgedock"),
      true,
    );
  });

  it("recognizes pnpm's dlx cache", () => {
    assert.equal(isEphemeralCachePath("/home/user/.local/share/pnpm/dlx/a1b2c3/node_modules/forgedock"), true);
  });

  it("recognizes yarn (Berry) dlx's xfs- prefixed temp dir, case-insensitively", () => {
    assert.equal(isEphemeralCachePath("/tmp/xfs-6a8c1f2e/node_modules/forgedock"), true);
    assert.equal(isEphemeralCachePath("/tmp/XFS-6A8C1F2E/node_modules/forgedock"), true);
  });

  it("does not false-positive on a global npm install path", () => {
    assert.equal(isEphemeralCachePath("/usr/lib/node_modules/forgedock"), false);
    assert.equal(isEphemeralCachePath("C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\forgedock"), false);
  });

  it("does not false-positive on a local repo clone path", () => {
    assert.equal(isEphemeralCachePath("C:/Users/ItsMr/Documents/Projects/ForgeDock"), false);
    assert.equal(isEphemeralCachePath("/home/user/projects/ForgeDock"), false);
  });

  it("does not false-positive on pnpm's persistent content-addressable store (.pnpm, not dlx)", () => {
    assert.equal(
      isEphemeralCachePath("/home/user/projects/node_modules/.pnpm/forgedock@1.0.0/node_modules/forgedock"),
      false,
    );
  });

  it("matches by path segment, not substring — 'my-dlx-tool' and 'npx-utils' project names are not flagged", () => {
    assert.equal(isEphemeralCachePath("/home/user/projects/my-dlx-tool"), false);
    assert.equal(isEphemeralCachePath("/home/user/projects/npx-utils"), false);
  });

  it("handles empty/non-string input without throwing", () => {
    assert.equal(isEphemeralCachePath(""), false);
    assert.equal(isEphemeralCachePath(null), false);
    assert.equal(isEphemeralCachePath(undefined), false);
  });
});

describe("persistHome (forge#1943)", () => {
  /** Populate a fake forgeHome source tree with a minimal payload + package.json. */
  function makeSourceForgeHome({ version = "1.2.3" } = {}) {
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-persist-src-"));
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "scripts"), { recursive: true });
    // templates/ deliberately omitted from some tests below to exercise the
    // "missing source subdirectory" tolerance.
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook\n", "utf-8");
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n", "utf-8");
    writeFileSync(join(forgeHome, "scripts", "classify-lane.sh"), "#!/bin/sh\n", "utf-8");
    writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version }), "utf-8");
    return forgeHome;
  }

  it("fresh copy: copies bin/commands/scripts into ~/.forge/ and writes version", async () => {
    const forgeHome = makeSourceForgeHome({ version: "1.2.3" });
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-home-"));

    const res = await persistHome({ forgeHome, home });

    assert.equal(res.skipped, false);
    assert.equal(res.migrated, true);
    assert.equal(res.version, "1.2.3");
    assert.equal(res.forgeHome, join(home, ".forge"));

    assert.equal(readFileSync(join(home, ".forge", "commands", "one.md"), "utf-8"), "# /one\n");
    assert.equal(readFileSync(join(home, ".forge", "bin", "hooks", "session-start.mjs"), "utf-8"), "// hook\n");
    assert.equal(readFileSync(join(home, ".forge", "scripts", "classify-lane.sh"), "utf-8"), "#!/bin/sh\n");
    assert.equal(readFileSync(join(home, ".forge", "version"), "utf-8").trim(), "1.2.3");
  });

  it("git-clone skip: does not touch ~/.forge/ at all when ctx.forgeHome is a real git clone", async () => {
    const forgeHome = makeSourceForgeHome();
    mkdirSyncFs(join(forgeHome, ".git"), { recursive: true }); // real clone: .git is a DIRECTORY
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-home-git-"));

    const res = await persistHome({ forgeHome, home });

    assert.equal(res.skipped, true);
    assert.equal(res.migrated, false);
    assert.equal(res.forgeHome, forgeHome);
    assert.match(res.reason, /git working tree/i);
    assert.equal(existsSync(join(home, ".forge")), false);
  });

  it("idempotent re-run: unchanged source content does not rewrite files (mtime preserved, migrated: false)", async () => {
    const forgeHome = makeSourceForgeHome({ version: "2.0.0" });
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-home-idempotent-"));

    const first = await persistHome({ forgeHome, home });
    assert.equal(first.migrated, true);

    const commandFile = join(home, ".forge", "commands", "one.md");
    const mtimeBefore = statSync(commandFile).mtimeMs;

    // Re-run with byte-identical source content.
    const second = await persistHome({ forgeHome, home });
    assert.equal(second.skipped, false);
    assert.equal(second.migrated, false, "no file content changed, so nothing should have been rewritten");

    const mtimeAfter = statSync(commandFile).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, "unchanged file must not be rewritten (content-compare before overwrite)");
  });

  it("re-run after a real content change re-copies only the changed file and reports migrated: true", async () => {
    const forgeHome = makeSourceForgeHome({ version: "2.0.0" });
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-home-changed-"));

    await persistHome({ forgeHome, home });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one (edited)\n", "utf-8");

    const second = await persistHome({ forgeHome, home });
    assert.equal(second.migrated, true);
    assert.equal(readFileSync(join(home, ".forge", "commands", "one.md"), "utf-8"), "# /one (edited)\n");
  });

  it("degrades gracefully when a source subdirectory (templates/) does not exist", async () => {
    const forgeHome = makeSourceForgeHome(); // no templates/ dir created
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-home-notemplates-"));

    await assert.doesNotReject(persistHome({ forgeHome, home }));
    const res = await persistHome({ forgeHome, home });

    assert.equal(res.skipped, false);
    assert.equal(existsSync(join(home, ".forge", "templates")), false);
    // The dirs that DO exist in the source were still copied correctly.
    assert.equal(readFileSync(join(home, ".forge", "commands", "one.md"), "utf-8"), "# /one\n");
  });

  it("worktree shape (.git is a FILE, not a directory) is also skipped — not just real clones", async () => {
    const forgeHome = makeSourceForgeHome();
    writeFileSync(join(forgeHome, ".git"), "gitdir: /somewhere/else/.git/worktrees/foo\n", "utf-8");
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-home-worktree-"));

    const res = await persistHome({ forgeHome, home });

    assert.equal(res.skipped, true);
    assert.equal(existsSync(join(home, ".forge")), false);
  });

  it("missing package.json degrades to an empty version string rather than throwing", async () => {
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-persist-src-nopkg-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n", "utf-8");
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-home-nopkg-"));

    const res = await persistHome({ forgeHome, home });

    assert.equal(res.skipped, false);
    assert.equal(res.version, "");
    assert.equal(readFileSync(join(home, ".forge", "version"), "utf-8").trim(), "");
  });

  // -------------------------------------------------------------------------
  // Downgrade guard + orphan cleanup (forge#2133)
  //
  // Regression covered: a stale resolved package (e.g. a plain
  // `npx forgedock update` that resolves an old global install) must never
  // silently overwrite a newer persisted ~/.forge/ with older file contents,
  // and files dropped from an upstream release must not linger in ~/.forge/
  // forever — copyDirIfChanged() is additive-only by design.
  // -------------------------------------------------------------------------

  it("downgrade guard: refuses to overwrite a newer persisted ~/.forge/ with an older source package", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-downgrade-home-"));

    // First persist a NEWER version (2.0.0).
    const newerSource = makeSourceForgeHome({ version: "2.0.0" });
    const first = await persistHome({ forgeHome: newerSource, home });
    assert.equal(first.skipped, false);
    assert.equal(first.version, "2.0.0");
    writeFileSync(join(home, ".forge", "commands", "one.md"), "# /one (v2)\n", "utf-8");

    // Now resolve an OLDER stale package (1.0.0) and attempt to persist it.
    const olderSource = makeSourceForgeHome({ version: "1.0.0" });
    const second = await persistHome({ forgeHome: olderSource, home });

    assert.equal(second.skipped, true);
    assert.match(second.reason, /refus.*downgrade/i);
    // The persisted version must still report the newer, already-persisted value.
    assert.equal(second.version, "2.0.0");
    // The newer content must survive untouched — not overwritten by the stale source.
    assert.equal(
      readFileSync(join(home, ".forge", "commands", "one.md"), "utf-8"),
      "# /one (v2)\n",
      "downgrade guard must prevent the older source from overwriting the newer persisted file",
    );
    assert.equal(readFileSync(join(home, ".forge", "version"), "utf-8").trim(), "2.0.0");
  });

  it("same-version re-persist is not blocked by the downgrade guard (compareVersions == 0 proceeds normally)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-sameversion-home-"));
    const source = makeSourceForgeHome({ version: "3.1.0" });

    await persistHome({ forgeHome: source, home });
    writeFileSync(join(source, "commands", "one.md"), "# /one (updated content, same version)\n", "utf-8");

    const second = await persistHome({ forgeHome: source, home });
    assert.equal(second.skipped, false);
    assert.equal(
      readFileSync(join(home, ".forge", "commands", "one.md"), "utf-8"),
      "# /one (updated content, same version)\n",
    );
  });

  it("orphan cleanup: a file removed from the source payload is deleted from the persisted ~/.forge/ copy", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-orphan-home-"));
    const forgeHome = makeSourceForgeHome({ version: "1.0.0" });
    writeFileSync(join(forgeHome, "commands", "two.md"), "# /two\n", "utf-8");

    const first = await persistHome({ forgeHome, home });
    assert.equal(first.skipped, false);
    assert.ok(existsSync(join(home, ".forge", "commands", "one.md")));
    assert.ok(existsSync(join(home, ".forge", "commands", "two.md")));

    // Simulate an upstream release that drops commands/two.md, bumping the
    // version so the downgrade guard doesn't interfere with this persist.
    unlinkSync(join(forgeHome, "commands", "two.md"));
    writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "1.1.0" }), "utf-8");

    const second = await persistHome({ forgeHome, home });
    assert.equal(second.skipped, false);
    assert.equal(second.filesRemoved, 1);
    assert.equal(second.migrated, true);
    assert.ok(
      !existsSync(join(home, ".forge", "commands", "two.md")),
      "orphaned file must be removed from ~/.forge/ once dropped from the source payload",
    );
    assert.ok(
      existsSync(join(home, ".forge", "commands", "one.md")),
      "files still present in the source payload must be left alone",
    );
  });

  it("orphan cleanup: an entire orphaned subdirectory is removed recursively", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-orphan-dir-home-"));
    const forgeHome = makeSourceForgeHome({ version: "1.0.0" });
    mkdirSyncFs(join(forgeHome, "commands", "legacy-subdir"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "legacy-subdir", "old.md"), "# old\n", "utf-8");

    await persistHome({ forgeHome, home });
    assert.ok(existsSync(join(home, ".forge", "commands", "legacy-subdir", "old.md")));

    // Drop the whole subdirectory upstream, bump version to clear the downgrade guard.
    rmSync(join(forgeHome, "commands", "legacy-subdir"), { recursive: true, force: true });
    writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "1.1.0" }), "utf-8");

    const second = await persistHome({ forgeHome, home });
    assert.equal(second.skipped, false);
    assert.ok(
      !existsSync(join(home, ".forge", "commands", "legacy-subdir")),
      "an orphaned subdirectory must be removed recursively, not just its files",
    );
  });

  it("removeOrphans: source subdir replaced by a symlink-to-file (ENOTDIR) does not abort the whole persist (forge#2227)", async (t) => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-persist-enotdir-home-"));
    const forgeHome = makeSourceForgeHome({ version: "1.0.0" });
    mkdirSyncFs(join(forgeHome, "commands", "subdir"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "subdir", "old.md"), "# old\n", "utf-8");

    const first = await persistHome({ forgeHome, home });
    assert.equal(first.skipped, false);
    assert.ok(existsSync(join(home, ".forge", "commands", "subdir", "old.md")));
    assert.ok(existsSync(join(home, ".forge", "commands", "one.md")));

    // Replace the source subdirectory with a symlink pointing at a plain file.
    // readdir()'ing this path (as removeOrphans recurses into the still-real
    // dest-side directory) throws ENOTDIR, not ENOENT — the exact escape this
    // regression guards against. Bump version to clear the downgrade guard.
    rmSync(join(forgeHome, "commands", "subdir"), { recursive: true, force: true });
    try {
      symlinkSync(join(forgeHome, "package.json"), join(forgeHome, "commands", "subdir"));
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation unavailable (Windows without Developer Mode)");
        return;
      }
      throw err;
    }
    writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "1.1.0" }), "utf-8");

    const second = await persistHome({ forgeHome, home });
    assert.equal(
      second.skipped,
      false,
      "an ENOTDIR on one reconciled path must not fail the whole persist open (forge#2227)",
    );
    assert.ok(
      existsSync(join(home, ".forge", "commands", "one.md")),
      "unrelated files must still be persisted/kept even when one path hits ENOTDIR",
    );
    assert.ok(
      !existsSync(join(home, ".forge", "commands", "subdir", "old.md")),
      "the now-type-mismatched subdir's stale contents must be treated as orphaned and removed",
    );
  });
});

describe("detectCrossEnvInstall (forge#1893)", () => {
  it("WSL -> Windows: finds a Windows-native install via the live /mnt mount", () => {
    const envInfo = detectEnvironment({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu-22.04" } });
    const ctx = { cwd: "/mnt/c/Users/testuser/projects/repo", exec: () => { throw new Error("should not be called"); } };
    const existsSyncFn = (p) => p === "/mnt/c/Users/testuser/.claude/forgedock";
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn });
    assert.equal(res.conflict, true);
    assert.equal(res.direction, "windows");
    assert.equal(res.otherPath, "C:\\Users\\testuser\\.claude\\forgedock");
  });

  it("WSL -> Windows: no conflict when no Windows install marker exists (the common case)", () => {
    const envInfo = detectEnvironment({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu-22.04" } });
    const ctx = { cwd: "/mnt/c/Users/testuser/projects/repo", exec: () => { throw new Error("should not be called"); } };
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn: () => false });
    assert.equal(res.conflict, false);
    assert.equal(res.otherPath, null);
  });

  it("WSL -> Windows: no conflict, no crash when cwd isn't under /mnt/<drive>/Users/<user>", () => {
    const envInfo = detectEnvironment({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu-22.04" } });
    const ctx = { cwd: "/home/testuser/projects/repo", exec: () => { throw new Error("should not be called"); } };
    let existsCalled = false;
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn: () => { existsCalled = true; return true; } });
    assert.equal(res.conflict, false);
    assert.equal(existsCalled, false); // never even probes — path shape doesn't apply
  });

  it("Windows -> WSL: finds a WSL install by enumerating distros via `wsl -l -q`", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    // Simulate `wsl -l -q`'s real UTF-16LE-decoded-as-UTF-8 output: ASCII
    // characters interleaved with NUL bytes.
    const rawDistroOutput = "Ubuntu-22.04".split("").join("\0") + "\0\r\n";
    const ctx = {
      cwd: "C:\\Users\\testuser\\projects\\repo",
      exec: (cmd, args) => {
        assert.equal(cmd, "wsl");
        assert.deepEqual(args, ["-l", "-q"]);
        return rawDistroOutput;
      },
    };
    const existsSyncFn = (p) => p === "\\\\wsl.localhost\\Ubuntu-22.04\\home\\testuser\\.claude\\forgedock";
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn });
    assert.equal(res.conflict, true);
    assert.equal(res.direction, "wsl");
    assert.equal(res.otherPath, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\testuser\\.claude\\forgedock");
  });

  it("Windows -> WSL: matches a lowercase `users` path segment (case-insensitive, symmetric with the WSL -> Windows branch)", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    const rawDistroOutput = "Ubuntu-22.04".split("").join("\0") + "\0\r\n";
    const ctx = {
      cwd: "C:\\users\\testuser\\projects\\repo",
      exec: (cmd, args) => {
        assert.equal(cmd, "wsl");
        assert.deepEqual(args, ["-l", "-q"]);
        return rawDistroOutput;
      },
    };
    const existsSyncFn = (p) => p === "\\\\wsl.localhost\\Ubuntu-22.04\\home\\testuser\\.claude\\forgedock";
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn });
    assert.equal(res.conflict, true);
    assert.equal(res.direction, "wsl");
    assert.equal(res.otherPath, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\testuser\\.claude\\forgedock");
  });

  it("Windows -> WSL: falls back to the \\\\wsl$\\ UNC root when \\\\wsl.localhost\\ isn't found", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    const ctx = {
      cwd: "C:\\Users\\testuser\\projects\\repo",
      exec: () => "Ubuntu\0\r\n",
    };
    const existsSyncFn = (p) => p === "\\\\wsl$\\Ubuntu\\home\\testuser\\.claude\\forgedock";
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn });
    assert.equal(res.conflict, true);
    assert.equal(res.direction, "wsl");
  });

  it("Windows -> WSL: no conflict when `wsl` isn't installed/on PATH (common case)", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    const ctx = {
      cwd: "C:\\Users\\testuser\\projects\\repo",
      exec: () => { throw new Error("ENOENT: wsl"); },
    };
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn: () => true });
    assert.equal(res.conflict, false);
  });

  it("Windows -> WSL: no conflict when distros exist but none has a ForgeDock install", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    const ctx = {
      cwd: "C:\\Users\\testuser\\projects\\repo",
      exec: () => "Ubuntu\0\r\n",
    };
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn: () => false });
    assert.equal(res.conflict, false);
  });

  it("Windows -> WSL: no conflict, no crash when cwd isn't under <drive>:\\Users\\<user>", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    let execCalled = false;
    const ctx = {
      cwd: "C:\\ForgeDock\\repo",
      exec: () => { execCalled = true; return "Ubuntu\0\r\n"; },
    };
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn: () => true });
    assert.equal(res.conflict, false);
    assert.equal(execCalled, false); // never enumerates distros — path shape doesn't apply
  });

  it("macOS/Linux (non-WSL, non-Windows): no conflict, never probes anything", () => {
    const envInfo = detectEnvironment({ platform: "darwin", env: {} });
    let called = false;
    const ctx = {
      cwd: "/Users/testuser/projects/repo",
      exec: () => { called = true; return ""; },
    };
    const res = detectCrossEnvInstall(ctx, envInfo, { existsSyncFn: () => { called = true; return true; } });
    assert.equal(res.conflict, false);
    assert.equal(called, false);
  });

  it("never throws even when existsSyncFn itself throws", () => {
    const envInfo = detectEnvironment({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
    const ctx = { cwd: "/mnt/c/Users/testuser/repo", exec: () => "" };
    assert.doesNotThrow(() => {
      const res = detectCrossEnvInstall(ctx, envInfo, {
        existsSyncFn: () => { throw new Error("boom"); },
      });
      assert.equal(res.conflict, false);
    });
  });

  it("Windows -> WSL: probe loop is bounded by distro count — stops after the cap even with more distros registered (forge#1917)", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    // 8 registered distros, none has a ForgeDock install — more than the cap.
    const rawDistroOutput = ["one", "two", "three", "four", "five", "six", "seven", "eight"]
      .map((d) => d.split("").join("\0") + "\0")
      .join("\r\n");
    const ctx = {
      cwd: "C:\\Users\\testuser\\projects\\repo",
      exec: () => rawDistroOutput,
    };
    let probeCount = 0;
    const res = detectCrossEnvInstall(ctx, envInfo, {
      existsSyncFn: () => { probeCount++; return false; },
    });
    assert.equal(res.conflict, false);
    // 2 UNC roots probed per distro; capped at 5 distros = 10 probes max.
    assert.ok(probeCount <= 10, `expected at most 10 probes (5 distros x 2 roots), got ${probeCount}`);
    assert.ok(probeCount > 0);
  });

  it("Windows -> WSL: probe loop stops early once the wall-clock budget is exhausted (forge#1917)", () => {
    const envInfo = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    const rawDistroOutput = ["one", "two", "three"].map((d) => d.split("").join("\0") + "\0").join("\r\n");
    const ctx = {
      cwd: "C:\\Users\\testuser\\projects\\repo",
      exec: () => rawDistroOutput,
    };
    // Fake clock: first call establishes the deadline, every call after that
    // reports time already past the budget — so only the very first probe
    // (checked against the deadline established on the same first call) can
    // still run before the loop bails.
    let tick = 0;
    const nowFn = () => (tick++ === 0 ? 0 : 999999);
    let probeCount = 0;
    const res = detectCrossEnvInstall(ctx, envInfo, {
      nowFn,
      existsSyncFn: () => { probeCount++; return false; },
    });
    assert.equal(res.conflict, false);
    assert.equal(probeCount, 0); // deadline already exceeded before the first probe check
  });
});

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

  it("warns when ctx.forgeHome resolves inside an ephemeral npx cache (forge#1895)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home-npx-"));
    const forgeHome = join(mkdtempSync(join(os.tmpdir(), "fd-forge-src-npx-")), "_npx", "abcd1234", "node_modules", "forgedock");
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    await forge(ctx);

    assert.match(w.text, /ephemeral cache/i);
    assert.match(w.text, /npm install -g forgedock/);
  });

  it("does NOT warn for a durable forgeHome (global install / local clone) — no false positive (forge#1895)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home-durable-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src-durable-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome; // an mkdtemp path with no _npx/dlx/xfs- segment
    await forge(ctx);

    assert.doesNotMatch(w.text, /ephemeral cache/i);
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

  it("relinking a stale symlink uses a per-process tmp path, unaffected by a stray plain target+\".tmp\" file (forge#2600)", async (t) => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home6b-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src6b-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Stale symlink at the target pointing at a different file — same setup
    // as "linkStrategy copy replaces a stale symlink with a copy" above, but
    // this time with the default (symlink) linkStrategy so forge() takes the
    // relink branch (bin/journey.mjs, wantSymlink=true) instead of falling
    // straight to the copy fallback.
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

    // Simulate a leftover plain `target + ".tmp"` file from a *different*
    // process (e.g. a concurrent forge() invocation with a different PID, or
    // a stale leftover from before forge#2600). Before forge#2600, the
    // relink branch wrote to and renamed exactly this literal path, so a
    // second concurrent invocation sharing it could race and surface an
    // uncaught EEXIST. After the fix, this invocation writes to its own
    // `target + "." + process.pid + ".tmp"` path and must never read,
    // write, or clean up this foreign sibling.
    const foreignTmp = target + ".tmp";
    writeFileSync(foreignTmp, "FOREIGN PROCESS LEFTOVER", "utf-8");

    const { ctx } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.updated, 1, "the stale symlink should be relinked");
    assert.ok(lstatSync(target).isSymbolicLink(), "target should remain a symlink after relinking");
    assert.equal(
      readFileSync(foreignTmp, "utf-8"),
      "FOREIGN PROCESS LEFTOVER",
      "a foreign (non-pid-suffixed) .tmp sibling must be untouched — this invocation writes to its own per-process tmp path",
    );
  });

  it("upgrading a manifest-tracked copy to a symlink uses a per-process tmp path, unaffected by a stray plain target+\".tmp\" file (forge#2600)", async (t) => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home6c-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src6c-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Probe symlink permission before setting up the (regular-file) target
    // state below — the upgrade branch's initial target must be a plain
    // file, so unlike the sibling relink test above we can't gate on the
    // fixture's own symlinkSync call. Probe with a throwaway path instead.
    const probeLink = join(forgeHome, "probe-link.md");
    try {
      symlinkSync(join(forgeHome, "commands", "a.md"), probeLink);
      unlinkSync(probeLink);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation unavailable (Windows without Developer Mode)");
        return;
      }
      throw err;
    }

    // Pre-seed the manifest (it's our copy) and a stale-content copy at the
    // target — the "manifest-tracked file" branch, same setup as
    // "manifest-tracked file with changed content is updated" above, but
    // with the default (symlink) linkStrategy so forge() attempts the
    // upgrade-to-symlink branch (wantSymlink=true) instead of the
    // copy-fallback content-compare path.
    mkdirSyncFs(join(home, ".claude", "forgedock"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "forgedock", "copied-commands.json"),
      JSON.stringify({ version: 1, files: { "a.md": true } }),
      "utf-8",
    );
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "OLD", "utf-8");

    // Same foreign-tmp-sibling simulation as the relink test above.
    const foreignTmp = target + ".tmp";
    writeFileSync(foreignTmp, "FOREIGN PROCESS LEFTOVER", "utf-8");

    const { ctx } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.updated, 1, "the manifest-tracked copy should be upgraded to a symlink");
    assert.ok(lstatSync(target).isSymbolicLink(), "target should be a symlink after upgrading");
    const manifest = JSON.parse(
      readFileSync(join(home, ".claude", "forgedock", "copied-commands.json"), "utf-8"),
    );
    assert.equal(manifest.files["a.md"], undefined, "upgraded file should be dropped from the manifest");
    assert.equal(
      readFileSync(foreignTmp, "utf-8"),
      "FOREIGN PROCESS LEFTOVER",
      "a foreign (non-pid-suffixed) .tmp sibling must be untouched — this invocation writes to its own per-process tmp path",
    );
  });

  it("stale regular-file copy with no manifest entry is overwritten and adopted (forge#2459)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home4-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src4-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-create the target as a stale regular-file copy (content mismatches
    // the current source) with no manifest entry — e.g. a pre-manifest
    // ForgeDock version's copy-fallback install, or one that fell out of the
    // manifest. `a.md` is a path forge() itself ships (findMarkdownFiles(commandsDir)
    // enumerates it), so it is never an arbitrary user file — doctor --fix must
    // be able to repair it without a manual delete step.
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "OLD STALE COPY", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(readFileSync(target, "utf-8"), "A", "stale copy should be overwritten with current source content");
    assert.equal(res.updated, 1);
    assert.doesNotMatch(w.text, /WARNING/, "should not warn — the stale copy was repaired");
    const manifest = JSON.parse(
      readFileSync(join(home, ".claude", "forgedock", "copied-commands.json"), "utf-8"),
    );
    assert.equal(manifest.files["a.md"], true, "repaired file should be adopted into the manifest");
  });

  it("stale regular-file copy with no manifest entry: target is untouched on a .tmp write failure (forge#2498)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home4b-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src4b-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-create the target as a stale regular-file copy (content mismatches
    // the current source) with no manifest entry, same setup as the sibling
    // "stale regular-file copy" test above.
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "OLD STALE COPY", "utf-8");

    // Simulate a write failure by pre-creating the per-process tmp sibling
    // (target + "." + process.pid + ".tmp", forge#2542) as a directory —
    // copyFile(file, tmpTarget) then throws EISDIR/EEXIST at open-time (the
    // write never starts, not a partial in-flight write), a cheap stand-in
    // for ENOSPC/AV-lock without needing a real disk-full condition (same
    // technique used for writeForgeYaml's atomic-write test above, ref:
    // #1396). Must use the pid-suffixed path — the plain `target + ".tmp"`
    // is no longer the path forge() actually writes to.
    mkdirSyncFs(target + "." + process.pid + ".tmp", { recursive: true });

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    // The write failure must land entirely on the .tmp path — target itself
    // must never be opened for a direct overwrite, so its prior (stale)
    // content survives completely intact rather than being truncated.
    assert.equal(
      readFileSync(target, "utf-8"),
      "OLD STALE COPY",
      "target content must be untouched when the .tmp write fails — never partially overwritten",
    );
    assert.match(w.text, /WARNING/, "a write failure should still surface the repair warning");
    assert.equal(res.updated, 0, "no update should be counted when the write failed");
  });

  it("stale regular-file copy with no manifest entry: orphaned .tmp file is cleaned up on a copyFile failure (forge#2540)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home4d-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src4d-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-create the target as a stale regular-file copy (content mismatches
    // the current source) with no manifest entry, same setup as the sibling
    // mid-write-failure test above.
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "OLD STALE COPY", "utf-8");

    // Unlike the sibling mid-write-failure test above (which pre-creates
    // the per-process tmp sibling as a directory — a technique that forces
    // copyFile to fail but leaves nothing unlink() can remove), pre-create
    // it as a *regular file* and mark it read-only. copyFile(file,
    // tmpTarget) then fails with EPERM while attempting to open the
    // destination for writing — the same failure shape as a real AV lock or
    // permission error — but leaves a genuine file-type .tmp residue on
    // disk, so this test can actually assert that the cleanup path
    // (forge#2540) removes it. Must use the pid-suffixed path (forge#2542)
    // — the plain `target + ".tmp"` is no longer the path forge() writes to.
    const tmpSibling = target + "." + process.pid + ".tmp";
    writeFileSync(tmpSibling, "STALE .tmp LEFTOVER", "utf-8");
    chmodSync(tmpSibling, 0o444);

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    let res;
    try {
      res = await forge(ctx);
    } finally {
      // Defensive: if the cleanup assertion below fails, don't leave a
      // read-only file behind for the OS temp-dir GC to choke on.
      try { chmodSync(tmpSibling, 0o666); } catch { /* already removed */ }
    }

    assert.ok(
      !existsSync(tmpSibling),
      "the orphaned .tmp file must be cleaned up after a copyFile failure, not left behind",
    );
    assert.equal(
      readFileSync(target, "utf-8"),
      "OLD STALE COPY",
      "target content must be untouched when the .tmp write fails — never partially overwritten",
    );
    assert.match(w.text, /WARNING/, "a write failure should still surface the repair warning");
    assert.equal(res.updated, 0, "no update should be counted when the write failed");
  });

  it("stale regular-file copy with no manifest entry: prior content is backed up before being overwritten (forge#2499)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home4c-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src4c-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-create the target as a stale regular-file copy (content mismatches
    // the current source) with no manifest entry, same setup as the sibling
    // "stale regular-file copy" test above.
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "OLD STALE COPY", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(readFileSync(target, "utf-8"), "A", "stale copy should still be overwritten with current source content");
    assert.equal(
      readFileSync(target + ".bak", "utf-8"),
      "OLD STALE COPY",
      "prior stale content must be preserved in a .bak sibling before being overwritten",
    );
    assert.equal(res.backedUp, 1, "forge() should report exactly one backup");
    assert.equal(res.updated, 1);
    assert.doesNotMatch(w.text, /WARNING/, "should not warn — the stale copy was repaired");
  });

  it("stale regular-file copy with no manifest entry: uses a per-process tmp path, unaffected by a stray plain target+\".tmp\" file (forge#2542)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home4e-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src4e-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-create the target as a stale regular-file copy (content mismatches
    // the current source) with no manifest entry, same setup as the sibling
    // tests above.
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "OLD STALE COPY", "utf-8");

    // Simulate a leftover plain `target + ".tmp"` file from a *different*
    // process (e.g. a concurrent forge() invocation with a different PID,
    // or a stale leftover from before this fix). Before forge#2542, this
    // repair branch wrote to and cleaned up exactly this literal path, so a
    // second concurrent invocation sharing it could race. After the fix,
    // this invocation writes to its own `target + "." + process.pid +
    // ".tmp"` path and must never read, write, or clean up this foreign
    // sibling — it should be left completely untouched.
    const foreignTmp = target + ".tmp";
    writeFileSync(foreignTmp, "FOREIGN PROCESS LEFTOVER", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(readFileSync(target, "utf-8"), "A", "stale copy should still be overwritten with current source content");
    assert.equal(res.backedUp, 1, "forge() should report exactly one backup");
    assert.equal(res.updated, 1);
    assert.doesNotMatch(w.text, /WARNING/, "should not warn — the stale copy was repaired despite the foreign .tmp sibling");
    assert.equal(
      readFileSync(foreignTmp, "utf-8"),
      "FOREIGN PROCESS LEFTOVER",
      "a foreign (non-pid-suffixed) .tmp sibling must be untouched — this invocation writes to its own per-process tmp path",
    );
  });

  it("files outside the shipped command set are never touched by forge() (forge#2459 AC#3)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home-unrelated-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src-unrelated-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // A file at a path forge() never enumerates (no corresponding source file
    // under forgeHome/commands) — this is genuinely outside the ForgeDock
    // command set (e.g. a user's own custom slash command) and must be left
    // completely untouched, since forge()'s loop only ever iterates paths
    // returned by findMarkdownFiles(commandsDir).
    const unrelatedTarget = join(home, ".claude", "commands", "my-custom-command.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(unrelatedTarget, "MY OWN CUSTOM COMMAND", "utf-8");

    const { ctx } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    await forge(ctx);

    assert.equal(readFileSync(unrelatedTarget, "utf-8"), "MY OWN CUSTOM COMMAND");
  });

  it("adopts pre-manifest regular file into manifest when content matches source", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-adopt-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-adopt-src-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-create target as a regular file with identical content — no manifest entry.
    const target = join(home, ".claude", "commands", "a.md");
    mkdirSyncFs(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(target, "A", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(readFileSync(target, "utf-8"), "A");
    assert.equal(res.skipped, 1);
    assert.ok(!w.text.includes("WARNING"), "should not warn for content-matching file");
    const manifest = JSON.parse(
      readFileSync(join(home, ".claude", "forgedock", "copied-commands.json"), "utf-8"),
    );
    assert.equal(manifest.files["a.md"], true, "file should be adopted into manifest");
  });

  it("saveCopiedManifest uses a per-process tmp path, unaffected by a stray plain manifestPath+\".tmp\" file (forge#2599)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-pid-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-pid-src-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    mkdirSyncFs(join(home, ".claude", "forgedock"), { recursive: true });

    // Simulate a leftover plain `manifestPath + ".tmp"` file from a
    // *different* process (e.g. a concurrent forge() invocation with a
    // different PID, or a stale leftover from before this fix). Before
    // forge#2599, saveCopiedManifest() wrote to and renamed exactly this
    // literal path, so a second concurrent invocation sharing it could
    // race. After the fix, this invocation writes to its own
    // `manifestPath + "." + process.pid + ".tmp"` path and must never
    // read, write, or clean up this foreign sibling.
    const foreignTmp = manifestPath + ".tmp";
    writeFileSync(foreignTmp, "FOREIGN PROCESS LEFTOVER", "utf-8");

    // linkStrategy "copy" forces the copy-fallback path deterministically
    // (same technique used elsewhere in this file, e.g. line ~1158) — only
    // the copy path calls recordCopy()/sets manifestChanged, so this is
    // required for the manifest write under test to actually happen on
    // platforms where symlinks succeed (e.g. Linux CI), not just on
    // Windows-without-Developer-Mode where copy-fallback happens anyway.
    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.copied, 1, "the file should be freshly copied");
    assert.ok(!w.text.includes("manifest not saved"), "manifest save should succeed");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.files["a.md"], true, "manifest should be written normally");
    assert.equal(
      readFileSync(foreignTmp, "utf-8"),
      "FOREIGN PROCESS LEFTOVER",
      "a foreign (non-pid-suffixed) .tmp sibling must be untouched — this invocation writes to its own per-process tmp path",
    );
  });

  it("saveCopiedManifest cleans up its per-process tmp sibling on write failure, without touching the previous manifest (forge#2599)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-fail-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-fail-src-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    mkdirSyncFs(join(home, ".claude", "forgedock"), { recursive: true });

    // Pre-seed a prior manifest with recognizable content BEFORE forcing the
    // write failure below. The test's name claims the failed write leaves
    // "the previous manifest" untouched — that claim is only meaningful if a
    // previous manifest actually exists to potentially be clobbered
    // (forge#2615: without this, `!existsSync(manifestPath)` was trivially
    // true because there was never a prior manifest in play).
    const priorManifestContent = JSON.stringify(
      { files: { "prior.md": true }, marker: "PRE-EXISTING-MANIFEST-forge2615" },
      null,
      2,
    ) + "\n";
    writeFileSync(manifestPath, priorManifestContent, "utf-8");

    // Pre-create the pid-suffixed tmp sibling as a directory — writeFile()
    // then throws EISDIR at open-time (the write never starts), the same
    // technique used by #1396/#2542's atomic-write failure tests.
    const tmpSibling = manifestPath + "." + process.pid + ".tmp";
    mkdirSyncFs(tmpSibling, { recursive: true });

    // linkStrategy "copy" forces the copy-fallback path deterministically —
    // see the comment in the preceding test for why this is required for
    // manifestChanged to actually be set (and saveCopiedManifest to run) on
    // every platform, not just Windows-without-Developer-Mode.
    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.copied, 1, "the file copy itself should still succeed");
    assert.ok(
      w.text.includes("manifest not saved"),
      "forge() should surface the manifest save failure instead of crashing",
    );
    assert.ok(
      existsSync(manifestPath),
      "the pre-existing manifest should still exist — the failed write must not delete it",
    );
    assert.equal(
      readFileSync(manifestPath, "utf-8"),
      priorManifestContent,
      "the pre-existing manifest's content must be byte-for-byte unchanged — the failed write never replaced it",
    );
  });

  it("forge() sweeps a crash-orphaned pid-suffixed manifest tmp sibling but preserves an in-flight one and the legacy plain .tmp (forge#2612)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-sweep-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-sweep-src-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    mkdirSyncFs(join(home, ".claude", "forgedock"), { recursive: true });

    // A crash-orphaned pid-suffixed tmp from a prior hard-killed run (a pid
    // this process will never reuse). Backdate it well past the sweep age
    // threshold so it is eligible for reclamation.
    const staleTmp = manifestPath + ".999999.tmp";
    writeFileSync(staleTmp, "orphaned by SIGKILL between writeFile and rename", "utf-8");
    const anHourAgo = Date.now() / 1000 - 3600;
    utimesSync(staleTmp, anHourAgo, anHourAgo);

    // A *recent* pid-suffixed tmp — as if a concurrent forge() (different pid)
    // is mid-write right now. Younger than the age threshold → must survive.
    const liveTmp = manifestPath + ".888888.tmp";
    writeFileSync(liveTmp, "in-flight write by a concurrent forge()", "utf-8");

    // The legacy plain `.tmp` (no digit segment) must never be swept here —
    // the sweep only reclaims the pid-suffixed shape.
    const legacyTmp = manifestPath + ".tmp";
    writeFileSync(legacyTmp, "legacy foreign leftover", "utf-8");
    utimesSync(legacyTmp, anHourAgo, anHourAgo);

    // linkStrategy "copy" is not required for the sweep (it runs unconditionally
    // at forge() startup), but keep the forge() invocation on the same
    // deterministic footing as the sibling manifest tests.
    const { ctx } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;
    await forge(ctx);

    assert.ok(!existsSync(staleTmp), "a stale crash-orphaned pid-suffixed tmp sibling should be swept");
    assert.ok(existsSync(liveTmp), "a recent (in-flight) pid-suffixed tmp sibling must be preserved");
    assert.ok(existsSync(legacyTmp), "the legacy plain .tmp (no pid segment) must not be swept");
  });

  it("forge()'s final manifest save preserves a concurrent process's own manifest change instead of last-writer-wins overwriting it (forge#2614)", async () => {
    // #2599/#2609 fixed the tmp-file *write-path* race (concurrent forge()
    // invocations no longer collide on the same tmp filename), but left the
    // manifest's logical *content* racy: forge() loads the manifest once at
    // the start of the run and writes the whole in-memory object back at the
    // end, so a second process's manifest.files change — saved between this
    // run's load and its own final save — would previously be silently
    // dropped. This test simulates that window directly (matching this
    // suite's convention, e.g. the #2599/#2600/#2612 tests above, of
    // reproducing a concurrent process's on-disk effect rather than
    // orchestrating true OS-level concurrency): give this run many files to
    // copy so its loop spans many await points, and inject the "other
    // process's" manifest write via a macrotask timer so it lands on disk
    // sometime during that loop — well before this run's final save.
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-merge-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-merge-src-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    const fileCount = 25;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(forgeHome, "commands", `f${i}.md`), `content ${i}`, "utf-8");
    }
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    mkdirSyncFs(join(home, ".claude", "forgedock"), { recursive: true });
    // Seed the manifest with the state this run will load at startup.
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: {} }, null, 2) + "\n", "utf-8");

    // linkStrategy "copy" forces the copy-fallback path deterministically —
    // same rationale as the sibling manifest tests above (recordCopy() only
    // runs, and manifestChanged only gets set, on the copy path on platforms
    // where symlinks succeed, e.g. Linux CI).
    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;

    const forgePromise = forge(ctx);
    // Simulate a concurrent forge() invocation that loaded the same
    // manifest, added its own entry, and saved — after this run's own
    // initial load but before this run's final save.
    setTimeout(() => {
      const concurrent = JSON.parse(readFileSync(manifestPath, "utf-8"));
      concurrent.files["concurrent-process.md"] = true;
      writeFileSync(manifestPath, JSON.stringify(concurrent, null, 2) + "\n", "utf-8");
    }, 0);
    const res = await forgePromise;

    assert.equal(res.copied, fileCount, "this run should have copied all of its own files");
    assert.ok(!w.text.includes("manifest not saved"), "manifest save should succeed");

    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.equal(
      finalManifest.files["concurrent-process.md"],
      true,
      "the concurrent process's own manifest entry must survive this run's final save — last-writer-wins must not silently drop it",
    );
    for (let i = 0; i < fileCount; i++) {
      assert.equal(finalManifest.files[`f${i}.md`], true, `this run's own entry for f${i}.md must be present`);
    }
  });

  // forge#2637: #2614 (above) closed the "whole run duration" last-writer-wins
  // race by re-reading and merging right before the final save, but left that
  // final read→merge→write sequence itself unprotected — a third concurrent
  // forge() could still land its own save inside that narrower window. These
  // tests exercise the file-lock mitigation added around that sequence,
  // simulating a concurrent holder via the real `<manifest>.lock` artifact on
  // disk (rather than mocking internals — acquireManifestLock/
  // releaseManifestLock are not exported, matching this suite's existing
  // convention of testing forge()'s on-disk effects rather than its private
  // helpers).
  it("final manifest save waits for a concurrently held lock and merges both sides once it's released (forge#2637)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-wait-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-wait-src-"));
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    mkdirSync(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "content a", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    const lockPath = manifestPath + ".lock";
    mkdirSync(join(home, ".claude", "forgedock"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: {} }, null, 2) + "\n", "utf-8");

    // Simulate a concurrent process already holding the lock, mid-critical-
    // section, when this run reaches its own final save.
    writeFileSync(lockPath, "", "utf-8");

    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;

    const forgePromise = forge(ctx);
    // Release the held lock — and land the "other process's" own manifest
    // write, as it would have on releasing — shortly after this run starts
    // retrying, well within the retry/backoff budget.
    setTimeout(() => {
      const concurrent = JSON.parse(readFileSync(manifestPath, "utf-8"));
      concurrent.files["concurrent-process.md"] = true;
      writeFileSync(manifestPath, JSON.stringify(concurrent, null, 2) + "\n", "utf-8");
      unlinkSync(lockPath);
    }, 15);
    const res = await forgePromise;

    assert.equal(res.copied, 1, "this run should have copied its own file");
    assert.ok(!w.text.includes("manifest not saved"), "manifest save should succeed once the lock is released");
    assert.ok(!existsSync(lockPath), "the lock file must be cleaned up after this run's save completes");

    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.equal(finalManifest.files["a.md"], true, "this run's own entry must be present");
    assert.equal(
      finalManifest.files["concurrent-process.md"],
      true,
      "the concurrent holder's entry (written before releasing the lock) must survive this run's save",
    );
  });

  it("stale (crash-orphaned) manifest lock is reclaimed so forge() is not permanently blocked (forge#2637)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-stale-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-stale-src-"));
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    mkdirSync(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "content a", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    const lockPath = manifestPath + ".lock";
    mkdirSync(join(home, ".claude", "forgedock"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: {} }, null, 2) + "\n", "utf-8");

    // A lock left behind by a process that was hard-killed before releasing
    // it — backdate its mtime well past the staleness threshold so this run's
    // first contended attempt reclaims it instead of waiting out the full
    // retry budget.
    writeFileSync(lockPath, "", "utf-8");
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTime, staleTime);

    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;

    const res = await forge(ctx);

    assert.equal(res.copied, 1, "this run should have copied its own file");
    assert.ok(!w.text.includes("manifest not saved"), "manifest save should succeed after reclaiming the stale lock");
    assert.ok(!existsSync(lockPath), "the reclaimed lock must not be left behind after this run's own save");

    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.equal(finalManifest.files["a.md"], true, "this run's own entry must be present");
  });

  it("a lock younger than the new 30s threshold (but older than the old 10s one) is NOT reclaimed (forge#2655)", async () => {
    // Regression guard for the STALE_MANIFEST_LOCK_AGE_MS bump (10s -> 30s,
    // forge#2655): backdate the held lock's mtime to 20s ago — past the old
    // threshold, but still well within the new one. A correct implementation
    // must leave this lock completely untouched (never reclaim it) and fall
    // back to an unlocked save instead, exactly like the "held for the full
    // retry budget" case below. If the threshold ever regresses back toward
    // 10s, this lock would incorrectly get reclaimed and unlinked/replaced —
    // this test catches that by asserting the original lock file survives
    // byte-for-byte (same mtime) after forge() completes.
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-boundary-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-boundary-src-"));
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    mkdirSync(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "content a", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    const lockPath = manifestPath + ".lock";
    mkdirSync(join(home, ".claude", "forgedock"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: {} }, null, 2) + "\n", "utf-8");

    writeFileSync(lockPath, "", "utf-8");
    const boundaryTime = new Date(Date.now() - 20_000); // 20s old: > old 10s threshold, < new 30s threshold
    utimesSync(lockPath, boundaryTime, boundaryTime);
    const originalMtimeMs = statSync(lockPath).mtimeMs;

    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;

    const res = await forge(ctx);

    assert.equal(res.copied, 1, "this run should have copied its own file even without the lock");
    assert.ok(existsSync(lockPath), "a lock younger than the new threshold must survive untouched, not be reclaimed");
    assert.equal(
      statSync(lockPath).mtimeMs,
      originalMtimeMs,
      "the held lock's mtime must be unchanged — proves it was never re-stat'd-and-unlinked by the reclaim path",
    );
  });

  it("falls back to an unlocked save (never-abort contract preserved) when the lock cannot be acquired within the retry budget (forge#2637)", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-heldfull-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-manifest-lock-heldfull-src-"));
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    mkdirSync(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "content a", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    const lockPath = manifestPath + ".lock";
    mkdirSync(join(home, ".claude", "forgedock"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: {} }, null, 2) + "\n", "utf-8");

    // Held for the entire run — freshly touched throughout so it is never
    // treated as stale — simulating a live (non-crashed) concurrent holder
    // whose own critical section outlasts this run's retry budget.
    writeFileSync(lockPath, "", "utf-8");
    const keepAlive = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(lockPath, now, now);
      } catch {
        // lock already gone (test cleanup raced) — stop trying
        clearInterval(keepAlive);
      }
    }, 20);

    const { ctx, w } = stubCtx({ home, linkStrategy: "copy" });
    ctx.forgeHome = forgeHome;

    try {
      const res = await forge(ctx);
      assert.equal(res.copied, 1, "this run should have copied its own file");
      assert.ok(
        !w.text.includes("manifest not saved"),
        "manifest save must still succeed unlocked — the lock is best-effort, not a hard requirement",
      );
      const finalManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      assert.equal(finalManifest.files["a.md"], true, "this run's own entry must be present even without the lock");
    } finally {
      clearInterval(keepAlive);
      unlinkSync(lockPath);
    }
  });

  // forge#1527: the SubagentStop annotation-enforcement hook's trigger
  // (`FORGE:PHASE_START` in the transcript) is never emitted anywhere in the
  // pipeline, so it was dead code that always exited 0 with zero enforcement
  // effect. `forge()` must no longer install it, and must clean up any prior
  // installation.
  it("does not install the SubagentStop annotation-enforcement hook", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home7-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src7-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const { ctx } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.notEqual(res.subagentStopEnforceStatus, "installed");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    const subagentStop = settings.hooks?.SubagentStop ?? [];
    assert.ok(!JSON.stringify(subagentStop).includes("subagent-stop-enforce.mjs"));
  });

  it("removes a previously installed SubagentStop annotation-enforcement hook", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home8-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src8-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-seed settings.json as if a prior install had registered the
    // now-removed hook.
    mkdirSyncFs(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SubagentStop: [
            { hooks: [{ type: "command", command: 'node "/fake/bin/hooks/subagent-stop-enforce.mjs"' }] },
          ],
        },
      }),
      "utf-8",
    );

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.subagentStopEnforceStatus, "removed");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    const subagentStop = settings.hooks?.SubagentStop ?? [];
    assert.ok(!JSON.stringify(subagentStop).includes("subagent-stop-enforce.mjs"));
    assert.match(w.text, /SubagentStop enforcement hook removed/);
  });

  it("prunes orphaned ForgeDock symlink after command rename (forge#1701)", async (t) => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home9-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src9-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    // Current state: only pipeline-resume.md exists (resume.md was renamed away)
    writeFileSync(join(forgeHome, "commands", "pipeline-resume.md"), "PIPELINE-RESUME", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // Pre-seed the target dir with an orphaned symlink that points to the
    // now-deleted resume.md in commandsDir.
    const commandsDir = join(forgeHome, "commands");
    const targetCommands = join(home, ".claude", "commands");
    mkdirSyncFs(targetCommands, { recursive: true });
    const orphanTarget = join(commandsDir, "resume.md"); // this file no longer exists
    const orphanLink = join(targetCommands, "resume.md");
    try {
      symlinkSync(orphanTarget, orphanLink);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation unavailable (Windows without Developer Mode)");
        return;
      }
      throw err;
    }
    assert.ok(existsSync(orphanLink) || true, "orphan link created (lstat follows the broken link)");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    // Orphan should be gone
    assert.ok(!existsSync(orphanLink), "orphaned symlink was removed");
    // pipeline-resume.md should be installed
    assert.ok(existsSync(join(targetCommands, "pipeline-resume.md")), "renamed command installed");
    // pruned count reported
    assert.equal(res.pruned, 1);
    assert.match(w.text, /orphaned symlink/);
  });

  it("does not remove user-owned symlinks pointing outside commandsDir", async (t) => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home10-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src10-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    // A user-owned symlink pointing somewhere outside commandsDir
    const targetCommands = join(home, ".claude", "commands");
    mkdirSyncFs(targetCommands, { recursive: true });
    const userFile = join(home, "user-custom.md");
    writeFileSync(userFile, "USER CUSTOM", "utf-8");
    const userLink = join(targetCommands, "user-custom.md");
    try {
      symlinkSync(userFile, userLink);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation unavailable (Windows without Developer Mode)");
        return;
      }
      throw err;
    }

    const { ctx } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    // User-owned symlink must survive untouched
    assert.ok(existsSync(userLink), "user-owned symlink preserved");
    assert.equal(res.pruned, 0);
  });

  describe("isSymlinkTraversable (forge#2620)", () => {
    it("returns true for a symlink that resolves to a readable file", async () => {
      const dirT = mkdtempSync(join(os.tmpdir(), "fd-symtrav-ok-"));
      const src = join(dirT, "src.md");
      writeFileSync(src, "content", "utf-8");
      const link = join(dirT, "link.md");
      symlinkSync(src, link);
      assert.equal(await isSymlinkTraversable(link), true);
    });

    it("returns false for a symlink whose target does not exist", async () => {
      const dirT = mkdtempSync(join(os.tmpdir(), "fd-symtrav-missing-"));
      const link = join(dirT, "link.md");
      symlinkSync(join(dirT, "does-not-exist.md"), link);
      assert.equal(await isSymlinkTraversable(link), false);
    });

    it("returns false for a symlink whose target cannot be read as a file (e.g. a directory) — the portable proxy for an MSYS 'untrusted mount point' failure", async () => {
      const dirT = mkdtempSync(join(os.tmpdir(), "fd-symtrav-eisdir-"));
      const targetDirEntry = join(dirT, "not-a-file");
      mkdirSyncFs(targetDirEntry, { recursive: true });
      const link = join(dirT, "link.md");
      symlinkSync(targetDirEntry, link);
      assert.equal(await isSymlinkTraversable(link), false);
    });
  });

  describe("pruneStaleExtensionlessEntries (forge#2620)", () => {
    it("removes a top-level extensionless symlink whose target no longer exists", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-missing-"));
      const link = join(targetDir, "orchestrate");
      symlinkSync(join(targetDir, "gone-forever"), link);
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 1);
      assert.ok(!existsSync(link));
    });

    it("removes a top-level extensionless symlink pointing into the npx cache", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-npx-"));
      const cacheHome = mkdtempSync(join(os.tmpdir(), "fd-stale-npxsrc-"));
      const cacheTarget = join(cacheHome, "_npx", "abcd1234", "node_modules", "forgedock", "commands", "pipeline-health.md");
      mkdirSyncFs(join(cacheHome, "_npx", "abcd1234", "node_modules", "forgedock", "commands"), { recursive: true });
      writeFileSync(cacheTarget, "STALE", "utf-8");
      const link = join(targetDir, "pipeline-health");
      symlinkSync(cacheTarget, link);
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 1);
      assert.ok(!existsSync(link));
    });

    it("does not touch a real extensionless directory (e.g. a multi-file command dir like work-on/)", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-realdir-"));
      const cmdDir = join(targetDir, "work-on");
      mkdirSyncFs(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, "build.md"), "BUILD", "utf-8");
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 0);
      assert.ok(existsSync(join(cmdDir, "build.md")), "real command directory left untouched");
    });

    it("does not touch entries with a file extension", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-hasext-"));
      const link = join(targetDir, "orchestrate.md");
      symlinkSync(join(targetDir, "gone-forever"), link);
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 0);
      assert.ok(existsSync(link) || true); // lstat-broken symlink still "exists" as a dirent; just confirm untouched by pruned count
    });

    it("does not touch a plain (non-symlink) extensionless file", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-plainfile-"));
      writeFileSync(join(targetDir, "orchestrate"), "not a symlink", "utf-8");
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 0);
      assert.ok(existsSync(join(targetDir, "orchestrate")));
    });

    it("returns 0 for a targetDir that does not exist yet (fresh install)", async () => {
      const pruned = await pruneStaleExtensionlessEntries(join(os.tmpdir(), "fd-stale-does-not-exist-" + Date.now()));
      assert.equal(pruned, 0);
    });

    it("resolves a relative symlink target against the symlink's own directory, not process.cwd() (forge#2646)", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-relative-"));
      // Relative target that DOES exist when resolved against targetDir
      // (its own containing directory), but would NOT exist if resolved
      // against process.cwd() instead.
      writeFileSync(join(targetDir, "real-target.md"), "REAL", "utf-8");
      const link = join(targetDir, "orchestrate");
      symlinkSync("real-target.md", link); // relative target, not absolute
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 0, "relative target resolves to an existing file relative to its own dir — must not be pruned");
      assert.ok(existsSync(link));
    });

    it("still prunes a relative symlink target that is genuinely missing", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-relative-missing-"));
      const link = join(targetDir, "orchestrate");
      symlinkSync("does-not-exist.md", link); // relative target, missing either way
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 1);
      assert.ok(!existsSync(link));
    });

    it("leaves a Windows drive-relative symlink target (e.g. \"C:foo\") untouched on win32; treats it as an ordinary relative target on POSIX (forge#2659, win32-gated per forge#2663)", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-driverel-"));
      const link = join(targetDir, "orchestrate");
      // "C:foo" — drive letter + colon with NO separator after it — is
      // classified as "relative" by both path.win32.isAbsolute() and
      // path.posix.isAbsolute() (neither recognizes this shape as absolute).
      // The drive-relative special case is deliberately platform-gated to
      // win32 (forge#2663): only on Windows does "C:foo" mean "relative to
      // drive C's own cwd" — a path Node has no API to resolve — so the entry
      // is left untouched there. On POSIX, `:` is an ordinary filename
      // character, so "C:foo" is just a normal relative target resolved
      // against the link's own directory and pruned like any broken link.
      symlinkSync("C:foo", link);
      if (process.platform === "win32") {
        // Native Windows symlink creation resolves a drive-relative target
        // against the process's cwd at creation time (CreateSymbolicLink
        // semantics), so readlink() may return an already-absolute path
        // rather than the literal "C:foo" string this branch targets. Only
        // assert the untouched contract when the literal string survived.
        if (readlinkSync(link) !== "C:foo") return;
        const pruned = await pruneStaleExtensionlessEntries(targetDir);
        assert.equal(pruned, 0, "drive-relative target must not be pruned on win32 — cannot be resolved safely");
      } else {
        // POSIX: symlink() stores the literal "C:foo", which resolves to a
        // missing path under targetDir and is pruned like any broken link.
        assert.equal(readlinkSync(link), "C:foo");
        const pruned = await pruneStaleExtensionlessEntries(targetDir);
        assert.equal(pruned, 1, "on POSIX, \"C:foo\" is an ordinary relative target and is pruned when its resolved path is missing");
        assert.ok(!existsSync(link));
      }
    });

    it("does NOT mistake a genuinely drive-absolute target (\"C:\\\\foo\") for drive-relative", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-driveabs-"));
      const realTarget = join(targetDir, "real-target.md");
      writeFileSync(realTarget, "REAL", "utf-8");
      const link = join(targetDir, "orchestrate");
      symlinkSync(realTarget, link); // absolute target (e.g. "C:\...\real-target.md" on Windows)
      const pruned = await pruneStaleExtensionlessEntries(targetDir);
      assert.equal(pruned, 0, "a genuinely absolute target must resolve normally and not be pruned");
      assert.ok(existsSync(link));
    });

    it("expands a leading ~ against the home directory before resolving the target (forge#2660)", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-tilde-"));
      const homeDir = mkdtempSync(join(os.tmpdir(), "fd-stale-tildehome-"));
      const realTargetHomeRelative = join(homeDir, "real-target.md");
      writeFileSync(realTargetHomeRelative, "REAL", "utf-8");
      const originalHomedir = os.homedir;
      os.homedir = () => homeDir;
      try {
        const link = join(targetDir, "orchestrate");
        symlinkSync("~/real-target.md", link); // literal tilde-prefixed target, as readlink() would return it
        const pruned = await pruneStaleExtensionlessEntries(targetDir);
        // NOTE: cannot assert existsSync(link) here — existsSync follows the
        // symlink using the OS's own (non-tilde-aware) resolution, which
        // would report the link as broken regardless of our custom
        // expansion. pruned === 0 is the correct, complete assertion: it
        // proves pruneStaleExtensionlessEntries itself resolved the tilde
        // target to the real, existing file and therefore left the entry
        // alone (matches this describe block's existing convention — see
        // "does not touch entries with a file extension" above).
        assert.equal(pruned, 0, "tilde target must expand against home dir and resolve to the existing file");
      } finally {
        os.homedir = originalHomedir;
      }
    });

    it("still prunes a tilde-prefixed target that is genuinely missing under the home directory", async () => {
      const targetDir = mkdtempSync(join(os.tmpdir(), "fd-stale-tilde-missing-"));
      const homeDir = mkdtempSync(join(os.tmpdir(), "fd-stale-tildehome-missing-"));
      const originalHomedir = os.homedir;
      os.homedir = () => homeDir;
      try {
        const link = join(targetDir, "orchestrate");
        symlinkSync("~/does-not-exist.md", link);
        const pruned = await pruneStaleExtensionlessEntries(targetDir);
        assert.equal(pruned, 1);
        assert.ok(!existsSync(link));
      } finally {
        os.homedir = originalHomedir;
      }
    });
  });

  describe("linkPipelineScripts copy-fallback content comparison (forge#1916)", () => {
    it("byte-identical plain-file target is skipped, not recopied", async () => {
      const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home-scripts1-"));
      const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src-scripts1-"));
      mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
      mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
      mkdirSyncFs(join(forgeHome, "scripts"), { recursive: true });
      writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
      writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");
      writeFileSync(join(forgeHome, "scripts", "classify-lane.sh"), "#!/bin/sh\necho lane\n", "utf-8");

      // Pre-seed the target as an already-correct plain file (simulates a
      // prior copy-fallback install on Windows without Developer Mode).
      const scriptsTargetDir = join(home, ".claude", "scripts");
      mkdirSyncFs(scriptsTargetDir, { recursive: true });
      writeFileSync(join(scriptsTargetDir, "classify-lane.sh"), "#!/bin/sh\necho lane\n", "utf-8");

      const { ctx } = stubCtx({ home, linkStrategy: "copy" });
      ctx.forgeHome = forgeHome;
      const res = await forge(ctx);

      assert.equal(res.scriptsResult.copied, 0, "byte-identical content must not be recopied");
      assert.equal(res.scriptsResult.skipped, 1);
      assert.equal(
        readFileSync(join(scriptsTargetDir, "classify-lane.sh"), "utf-8"),
        "#!/bin/sh\necho lane\n",
      );
    });

    it("differing plain-file target is still recopied (unchanged behavior)", async () => {
      const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home-scripts2-"));
      const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src-scripts2-"));
      mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
      mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
      mkdirSyncFs(join(forgeHome, "scripts"), { recursive: true });
      writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
      writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");
      writeFileSync(join(forgeHome, "scripts", "classify-lane.sh"), "#!/bin/sh\necho new\n", "utf-8");

      // Pre-seed the target with stale content — must be detected as different
      // and recopied.
      const scriptsTargetDir = join(home, ".claude", "scripts");
      mkdirSyncFs(scriptsTargetDir, { recursive: true });
      writeFileSync(join(scriptsTargetDir, "classify-lane.sh"), "#!/bin/sh\necho old\n", "utf-8");

      const { ctx } = stubCtx({ home, linkStrategy: "copy" });
      ctx.forgeHome = forgeHome;
      const res = await forge(ctx);

      assert.equal(res.scriptsResult.copied, 1, "differing content must still be recopied");
      assert.equal(
        readFileSync(join(scriptsTargetDir, "classify-lane.sh"), "utf-8"),
        "#!/bin/sh\necho new\n",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Task 8: read, review, celebrate, & runJourney tests
// ---------------------------------------------------------------------------

describe("read (Act III)", () => {
  it("returns a draft + description without a git repo (placeholders, low confidence)", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-"));
    writeFileSync(join(cwd, "README.md"), "# X\n\nA test project.\n", "utf-8");
    const { ctx, w } = stubCtx({ cwd, isCliAvailableFn: () => false });
    const res = await read(ctx);
    assert.equal(res.draft.project.owner.value, "your-github-org");
    assert.equal(res.description.value, "A test project.");
    assert.match(w.text, /\[low\]/); // badge rendered for placeholder
  });

  it("enrichFn is called when ANTHROPIC_API_KEY is set and returns enriched draft", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-enrich-"));
    const original = await read(stubCtx({ cwd, isCliAvailableFn: () => false }).ctx);
    const { ctx, w } = stubCtx({
      cwd,
      env: { ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => false,
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
      isCliAvailableFn: () => false,
      enrichFn: () => {
        throw new Error("API failed");
      },
    });
    const res = await read(ctx);
    assert.equal(res.draft.project.owner.value, "your-github-org"); // unchanged
    assert.match(w.text, /unavailable/);
  });

  it("no ANTHROPIC_API_KEY and no CLI: enrichFn is never called", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-no-key-"));
    let enrichFnCalled = false;
    const { ctx, w } = stubCtx({
      cwd,
      env: {},
      isCliAvailableFn: () => false,
      enrichFn: () => {
        enrichFnCalled = true;
        return null;
      },
    });
    const res = await read(ctx);
    assert.equal(enrichFnCalled, false);
    assert.match(w.text, /no Claude Code CLI or ANTHROPIC_API_KEY/);
  });

  it("CLI available and no ANTHROPIC_API_KEY: enrichFn is still called (cli backend)", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-cli-backend-"));
    let receivedOpts;
    const { ctx, w } = stubCtx({
      cwd,
      env: {},
      isCliAvailableFn: () => true,
      enrichFn: (draft, opts) => {
        receivedOpts = opts;
        const enriched = structuredClone(draft);
        enriched.project.name.value = "ENRICHED-VIA-CLI";
        return enriched;
      },
    });
    const res = await read(ctx);
    assert.equal(res.draft.project.name.value, "ENRICHED-VIA-CLI");
    assert.equal(receivedOpts.backend, "cli");
    assert.match(w.text, /enriching with AI/);
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

describe("review (Act IV) — TTY overwrite confirmation gate (forge#1850, regression of #578)", () => {
  // annotatedReviewScreen and review() both branch on the global
  // process.stdin.isTTY. Spoof it for the duration of these tests so the
  // hasExisting && isTTY===true branch (the one that was silently
  // unprotected) is actually exercised, then restore it. setRawMode() throws
  // on this non-real TTY, so annotatedReviewScreen falls back to its
  // accept-all branch instantly (no hang) when the confirm gate lets it
  // through — verified manually before writing these tests.
  let originalIsTTY;
  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
  });
  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it("declining the confirm prompt aborts before any backup or write", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review-tty-decline-"));
    writeFileSync(join(cwd, "forge.yaml"), "precious: true\n", "utf-8");
    let confirmCalled = false;
    let confirmMessage = "";
    const { ctx } = stubCtx({
      cwd,
      confirmFn: async (message) => {
        confirmCalled = true;
        confirmMessage = message;
        return false;
      },
    });
    const res0 = await read(ctx);
    const res = await review(ctx, res0.draft, res0.description);

    assert.equal(confirmCalled, true, "confirmFn must be called for an existing config in TTY mode");
    assert.match(confirmMessage, /overwrite/i);
    assert.equal(res.aborted, true);
    assert.equal(res.written, false);
    assert.equal(readFileSync(join(cwd, "forge.yaml"), "utf-8"), "precious: true\n");
    assert.ok(!existsSync(join(cwd, "forge.yaml.bak")), "no backup should be created when the user declines");
  });

  it("accepting the confirm prompt proceeds to backup + write", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review-tty-accept-"));
    writeFileSync(join(cwd, "forge.yaml"), "precious: true\n", "utf-8");
    const { ctx } = stubCtx({
      cwd,
      confirmFn: async () => true,
    });
    // Build a resolved (non-placeholder) draft directly rather than via
    // read()/detectConfig(), since cwd has no git remote and would otherwise
    // resolve to placeholders — a scenario covered by the dedicated
    // hard-fail test below.
    const draft = {
      project: {
        owner: { value: "test-owner", confidence: "high", source: "git remote", why: "" },
        repo: { value: "test-repo", confidence: "high", source: "git remote", why: "" },
        name: { value: "Test Repo", confidence: "medium", source: "derived from repo slug", why: "" },
      },
      paths: {
        root: { value: cwd, confidence: "high", source: "process.cwd()", why: "" },
        worktreeBase: { value: join(cwd, ".claude", "worktrees"), confidence: "high", source: "derived from root", why: "" },
      },
      branches: {
        default: { value: "main", confidence: "high", source: "git symbolic-ref", why: "" },
        staging: { value: "staging", confidence: "high", source: "git branch -r", why: "" },
      },
      meta: { remoteDetected: true },
    };
    const res = await review(ctx, draft, { value: "", source: "" });

    assert.equal(res.aborted, false);
    assert.equal(res.written, true);
    assert.ok(existsSync(join(cwd, "forge.yaml.bak")), "the old file must be backed up");
    assert.equal(readFileSync(join(cwd, "forge.yaml.bak"), "utf-8"), "precious: true\n");
  });

  it("no existing config: confirmFn is never called (nothing to confirm)", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review-tty-fresh-"));
    let confirmCalled = false;
    const { ctx } = stubCtx({
      cwd,
      confirmFn: async () => {
        confirmCalled = true;
        return true;
      },
    });
    const res0 = await read(ctx);
    const res = await review(ctx, res0.draft, res0.description);

    assert.equal(confirmCalled, false);
    assert.equal(res.written, true);
  });

  it("hard-fails when overwrite is confirmed but owner/repo are unresolved placeholders", async () => {
    // cwd has no git remote, so detection resolves owner/repo to placeholders.
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review-tty-placeholder-"));
    writeFileSync(join(cwd, "forge.yaml"), "precious: true\n", "utf-8");
    const { ctx } = stubCtx({
      cwd,
      confirmFn: async () => true, // user says "yes, overwrite"
    });
    const res0 = await read(ctx);
    const res = await review(ctx, res0.draft, res0.description);

    assert.equal(res.aborted, true);
    assert.equal(res.written, false);
    assert.equal(readFileSync(join(cwd, "forge.yaml"), "utf-8"), "precious: true\n");
    assert.ok(!existsSync(join(cwd, "forge.yaml.bak")), "no backup should be created — the write never proceeds");
  });
});

describe("celebrate (Act V)", () => {
  it("prints elapsed time, receipt, and next steps", () => {
    const { ctx, w } = stubCtx({});
    ctx.startedAt = Date.now() - 34000;
    celebrate(ctx, { written: true, todoCount: 2, total: 24, hookStatus: "installed" });
    assert.match(w.text, /Forged\./);
    assert.match(w.text, /34s|3[0-9]s/);
    assert.match(w.text, /npx forgedock doctor/);
    assert.match(w.text, /\/issue/);
    assert.match(w.text, /2/); // TODO count surfaces in the receipt
  });

  it("when hookStatus is skipped-malformed, mentions hook skipped", () => {
    const { ctx, w } = stubCtx({});
    celebrate(ctx, { written: true, todoCount: 0, total: 5, hookStatus: "skipped-malformed" });
    assert.match(w.text, /hook skipped|NOT active/);
  });

  it("what's next box includes GitHub App install as item 1", () => {
    const { ctx, w } = stubCtx({});
    celebrate(ctx, { written: true, todoCount: 0, total: 5, hookStatus: "installed" });
    assert.match(w.text, /install GitHub App/i);
    assert.match(w.text, /rapiercraft-forgedock/);
  });

  it("mentions uninstall and the full help command so removal is discoverable (#1881)", () => {
    const { ctx, w } = stubCtx({});
    celebrate(ctx, { written: true, todoCount: 0, total: 5, hookStatus: "installed" });
    assert.match(w.text, /npx forgedock uninstall/);
    assert.match(w.text, /npx forgedock help/);
  });
});

// ---------------------------------------------------------------------------
// connect (Act V.5) — GitHub App install prompt (Issue #1719)
// ---------------------------------------------------------------------------

describe("connect (Act V.5)", () => {
  it("shows the GitHub App prompt in the output", async () => {
    const { ctx, w } = stubCtx({ openFn: () => {} });
    await connect(ctx);
    assert.match(w.text, /Connect to GitHub/i);
    assert.match(w.text, /rapiercraft-forgedock/);
  });

  it("calls openFn with the app URL when user confirms (yes), via non-TTY defaultValue", async () => {
    let openedUrl = null;
    const { ctx, w } = stubCtx({
      openFn: (url) => { openedUrl = url; },
    });
    const result = await connect(ctx);
    // In non-TTY (test environment), confirm() returns false (defaultValue).
    assert.equal(result.opened, false);
    assert.equal(openedUrl, null); // openFn NOT called when confirm returns false
    assert.match(w.text, /Skipped/);
  });

  it("calls openFn with the app URL when confirmFn resolves true (forge#1850: confirmFn now injectable)", async () => {
    // ctx.confirmFn is now injectable (added for the forge.yaml overwrite gate
    // in review()), which also closes the testability gap noted above — the
    // "yes" path can finally be exercised directly instead of only trusted.
    let openedUrl = null;
    const { ctx, w } = stubCtx({
      openFn: (url) => { openedUrl = url; },
      confirmFn: async () => true,
    });
    const result = await connect(ctx);
    assert.equal(result.opened, true);
    assert.match(openedUrl, /rapiercraft-forgedock/);
    assert.match(w.text, /Opening/);
  });

  it("does NOT call openFn when user declines (non-TTY auto-skip)", async () => {
    let called = false;
    const { ctx } = stubCtx({ openFn: () => { called = true; } });
    await connect(ctx);
    // In non-TTY mode confirm() always returns false — openFn must not be called
    assert.equal(called, false);
  });

  it("returns { opened: false } silently in non-TTY without throwing", async () => {
    const { ctx } = stubCtx({});
    const result = await connect(ctx);
    assert.equal(typeof result.opened, "boolean");
    // Non-TTY → auto-skip → opened must be false
    assert.equal(result.opened, false);
  });
});

// ---------------------------------------------------------------------------
// maybeOfferDemo (Act V.6, issue #1945)
// ---------------------------------------------------------------------------

describe("maybeOfferDemo (Act V.6)", () => {
  it("shows the demo prompt and skips cleanly in non-TTY (default false, no hang)", async () => {
    let demoCalled = false;
    const { ctx, w } = stubCtx({ runDemoFn: async () => { demoCalled = true; return { status: "ok" }; } });
    const result = await maybeOfferDemo(ctx);
    assert.equal(result.offered, true);
    assert.equal(result.ranDemo, false);
    assert.equal(demoCalled, false);
    assert.match(w.text, /Skipped/);
  });

  it("runs the demo when confirmFn resolves true", async () => {
    let calledWith = null;
    const { ctx } = stubCtx({
      confirmFn: async () => true,
      runDemoFn: async (opts) => { calledWith = opts; return { status: "ok", target: "/fake/demo" }; },
    });
    const result = await maybeOfferDemo(ctx);
    assert.equal(result.offered, true);
    assert.equal(result.ranDemo, true);
    assert.ok(calledWith);
    assert.equal(calledWith.forgeHome, ctx.forgeHome);
    assert.equal(calledWith.cwd, ctx.cwd);
  });

  it("does NOT run the demo when user declines", async () => {
    let demoCalled = false;
    const { ctx } = stubCtx({
      confirmFn: async () => false,
      runDemoFn: async () => { demoCalled = true; return { status: "ok" }; },
    });
    await maybeOfferDemo(ctx);
    assert.equal(demoCalled, false);
  });

  it("treats a returned {status:'error'} as a non-fatal failure, not a thrown exception", async () => {
    const { ctx, w } = stubCtx({
      confirmFn: async () => true,
      runDemoFn: async () => ({ status: "error", error: "network unavailable" }),
    });
    const result = await maybeOfferDemo(ctx);
    assert.equal(result.offered, true);
    assert.equal(result.ranDemo, false);
    assert.match(w.text, /Could not start the demo/);
  });

  it("swallows a thrown runDemoFn error without throwing past maybeOfferDemo", async () => {
    const { ctx, w } = stubCtx({
      confirmFn: async () => true,
      runDemoFn: async () => { throw new Error("boom"); },
    });
    const result = await maybeOfferDemo(ctx);
    assert.equal(result.offered, true);
    assert.equal(result.ranDemo, false);
    assert.match(w.text, /Could not start the demo/);
  });

  it("swallows a thrown confirmFn error without throwing", async () => {
    const { ctx } = stubCtx({ confirmFn: async () => { throw new Error("boom"); } });
    const result = await maybeOfferDemo(ctx);
    assert.equal(result.offered, false);
    assert.equal(result.ranDemo, false);
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
      isCliAvailableFn: () => false,
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
      isCliAvailableFn: () => false,
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
      isCliAvailableFn: () => false,
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

// ---------------------------------------------------------------------------
// validateForgeYamlShape — install receipt's forge.yaml status (Issue #1946)
// ---------------------------------------------------------------------------

describe("validateForgeYamlShape", () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(os.tmpdir(), "fd-yamlshape-"));
  });

  it("returns present:false, validShape:false when forge.yaml is absent", () => {
    assert.deepEqual(validateForgeYamlShape(cwd), { present: false, validShape: false });
  });

  it("returns present:true, validShape:true when all 3 required sections exist", () => {
    writeFileSync(join(cwd, "forge.yaml"), 'project:\n  owner: "x"\npaths:\n  root: "y"\nbranches:\n  default: "main"\n', "utf-8");
    assert.deepEqual(validateForgeYamlShape(cwd), { present: true, validShape: true });
  });

  it("returns present:true, validShape:false when a required section is missing", () => {
    writeFileSync(join(cwd, "forge.yaml"), 'project:\n  owner: "x"\npaths:\n  root: "y"\n', "utf-8");
    assert.deepEqual(validateForgeYamlShape(cwd), { present: true, validShape: false });
  });

  it("does not throw and does not leak file contents on a garbage file", () => {
    writeFileSync(join(cwd, "forge.yaml"), "not yaml at all {{{", "utf-8");
    const res = validateForgeYamlShape(cwd);
    assert.equal(res.present, true);
    assert.equal(res.validShape, false);
    assert.deepEqual(Object.keys(res).sort(), ["present", "validShape"]);
  });
});

// ---------------------------------------------------------------------------
// writeInstallReceipt — machine-readable install-receipt.json (Issue #1946)
// ---------------------------------------------------------------------------

describe("writeInstallReceipt", () => {
  let home, forgeHome, cwd;
  beforeEach(() => {
    home = mkdtempSync(join(os.tmpdir(), "fd-receipt-home-"));
    forgeHome = mkdtempSync(join(os.tmpdir(), "fd-receipt-forgehome-"));
    cwd = mkdtempSync(join(os.tmpdir(), "fd-receipt-cwd-"));
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
    writeFileSync(join(forgeHome, "commands", "two.md"), "---\ninstall: extras\n---\n# /two\n\nExtras command\n", "utf-8");
    writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "9.9.9" }), "utf-8");
  });

  function makeReceiptCtx(overrides = {}) {
    return makeCtx({
      home,
      forgeHome,
      cwd,
      env: {},
      platform: "linux",
      release: "",
      includeExtras: false,
      ...overrides,
    });
  }

  it("writes install-receipt.json under {home}/.forge/ with schemaVersion, timestamp, version, mode", async () => {
    const ctx = makeReceiptCtx();
    const res = await writeInstallReceipt(ctx, { forged: { hookStatus: "registered", preToolUseStatus: "registered", subagentStopEnforceStatus: null } });
    assert.equal(res.written, true);
    const receiptPath = join(home, ".forge", "install-receipt.json");
    assert.ok(existsSync(receiptPath));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf-8"));
    assert.equal(receipt.schemaVersion, 1);
    assert.match(receipt.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(receipt.forgedockVersion, "9.9.9");
    // no .git dir in forgeHome -> npm install mode
    assert.equal(receipt.installMode, "npm");
    assert.equal(receipt.hooks.sessionStart, "registered");
    assert.equal(receipt.hooks.preToolUse, "registered");
    assert.equal(receipt.hooks.subagentStopEnforce, null);
  });

  it("detects git-clone install mode when {forgeHome}/.git exists", async () => {
    mkdirSync(join(forgeHome, ".git"), { recursive: true });
    const ctx = makeReceiptCtx();
    await writeInstallReceipt(ctx, { forged: {} });
    const receipt = JSON.parse(readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8"));
    assert.equal(receipt.installMode, "git-clone");
  });

  it("tier reflects ctx.includeExtras (core by default, extras when set)", async () => {
    const ctxCore = makeReceiptCtx({ includeExtras: false });
    await writeInstallReceipt(ctxCore, { forged: {} });
    let receipt = JSON.parse(readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8"));
    assert.equal(receipt.tier, "core");
    assert.ok(!receipt.commands.list.includes("two"), "extras command excluded when tier is core");

    const ctxExtras = makeReceiptCtx({ includeExtras: true });
    await writeInstallReceipt(ctxExtras, { forged: {} });
    receipt = JSON.parse(readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8"));
    assert.equal(receipt.tier, "extras");
    assert.ok(receipt.commands.list.includes("two"), "extras command included when tier is extras");
  });

  it("commands list is sourced from findMarkdownFiles (not a duplicated literal list, ref #1633)", async () => {
    const ctx = makeReceiptCtx();
    await writeInstallReceipt(ctx, { forged: {} });
    const receipt = JSON.parse(readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8"));
    assert.equal(receipt.commands.count, 1);
    assert.deepEqual(receipt.commands.list, ["one"]);
  });

  it("captures platform info from detectEnvironment (platform/isWSL/shell)", async () => {
    const ctx = makeReceiptCtx({ platform: "linux", env: { SHELL: "/bin/bash" } });
    await writeInstallReceipt(ctx, { forged: {} });
    const receipt = JSON.parse(readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8"));
    assert.equal(receipt.platform.platform, "linux");
    assert.equal(receipt.platform.shell, "bash");
    assert.equal(receipt.platform.isWSL, false);
  });

  it("reflects forge.yaml presence/shape via validateForgeYamlShape, without copying file contents", async () => {
    writeFileSync(join(cwd, "forge.yaml"), 'project:\n  owner: "secret-org"\npaths:\n  root: "x"\nbranches:\n  default: "main"\n', "utf-8");
    const ctx = makeReceiptCtx();
    await writeInstallReceipt(ctx, { forged: {} });
    const receipt = JSON.parse(readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8"));
    assert.deepEqual(receipt.forgeYaml, { present: true, validShape: true });
    assert.ok(!JSON.stringify(receipt).includes("secret-org"), "forge.yaml field values must not leak into the receipt");
  });

  it("does not include process.env values or token-like strings (no PII/secrets)", async () => {
    const ctx = makeReceiptCtx({ env: { GH_TOKEN: "ghp_supersecrettoken1234567890", ANTHROPIC_API_KEY: "sk-ant-secret" } });
    await writeInstallReceipt(ctx, { forged: {} });
    const raw = readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8");
    assert.ok(!raw.includes("ghp_supersecrettoken1234567890"));
    assert.ok(!raw.includes("sk-ant-secret"));
  });

  it("is atomic: no stale .tmp file left after a successful write", async () => {
    const ctx = makeReceiptCtx();
    await writeInstallReceipt(ctx, { forged: {} });
    assert.ok(!existsSync(join(home, ".forge", "install-receipt.json.tmp")));
  });

  it("never throws: degrades to written:false when the target directory cannot be created", async () => {
    // Point ctx.home at a path whose parent is a FILE, not a directory —
    // mkdir(..., {recursive:true}) will fail with ENOTDIR, and the function
    // must swallow it rather than propagate.
    const blockerFile = join(mkdtempSync(join(os.tmpdir(), "fd-receipt-blocker-")), "im-a-file");
    writeFileSync(blockerFile, "x", "utf-8");
    const ctx = makeReceiptCtx({ home: join(blockerFile, "nested", "home") });
    const res = await writeInstallReceipt(ctx, { forged: {} });
    assert.equal(res.written, false);
  });

  it("never throws even when ctx.home is malformed (regression: path.join must not run before the try block)", async () => {
    // ctx.home = undefined would make an unguarded `join(ctx.home, ...)`
    // ahead of the try block throw synchronously (path.join rejects
    // non-string args), escaping writeInstallReceipt's own "never throws"
    // contract and propagating uncaught to runJourney()'s bare try/finally.
    const ctx = makeReceiptCtx({ home: undefined });
    await assert.doesNotReject(async () => {
      const res = await writeInstallReceipt(ctx, { forged: {} });
      assert.equal(res.written, false);
    });
  });

  it("works with a minimal summary (no forged data) — the relinkAndHint() call shape", async () => {
    const ctx = makeReceiptCtx();
    const res = await writeInstallReceipt(ctx, {});
    assert.equal(res.written, true);
    const receipt = JSON.parse(readFileSync(join(home, ".forge", "install-receipt.json"), "utf-8"));
    assert.equal(receipt.hooks.sessionStart, null);
    assert.equal(receipt.hooks.preToolUse, null);
    assert.equal(receipt.hooks.subagentStopEnforce, null);
  });
});
