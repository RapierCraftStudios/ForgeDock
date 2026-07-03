/**
 * bin/tests/journey.test.mjs — Unit tests for bin/journey.mjs.
 * Run with: node --test bin/tests/journey.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
});
