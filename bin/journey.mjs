/**
 * bin/journey.mjs — The five-act onboarding journey for ForgeDock.
 *
 * Acts (added across Tasks 4–8):
 *   preflight() → forge() → read() → review() → celebrate()
 *
 * This file owns forge.yaml generation (single source of truth, driven from
 * detection values) and orchestrates the existing modules:
 *   init-detect.mjs, init-enrich-api.mjs, tui.annotatedReviewScreen, registry.mjs
 */

import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { join, basename } from "path";

// ---------------------------------------------------------------------------
// forge.yaml generation (Task 4)
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");

/** Append the TODO flag for a low-confidence field. */
function todo(key, low) {
  return low.includes(key) ? `  # TODO(forgedock:${key}) — verify this value` : "";
}

/**
 * Ordered list of the 16 optional forge.yaml sections. Each entry is a
 * self-contained, fully-commented stub block (banner + example content).
 * This is the single source of truth for optional-section text, shared by
 * writeForgeYaml() (full-file generation for `npx forgedock init`) and
 * backfillForgeYaml() (append-only migration for existing files, #1982) —
 * keeping the two paths from drifting apart the same way full-generation
 * itself drifted from forge.yaml.example before #1983.
 *
 * `key` is the top-level YAML key the section introduces (used by
 * backfillForgeYaml() to detect whether a section is already present).
 * `block(v)` renders the stub text; blocks never end with a trailing
 * newline of their own — callers join them with `"\n\n"` to reproduce the
 * blank-line separation between sections.
 * @type {Array<{ key: string, block: (v: object) => string }>}
 */
const OPTIONAL_SECTIONS = [
  {
    key: "agents",
    block: () => `# =============================================================================
# AGENTS (OPTIONAL) — model overrides for pipeline agents.
# Commands: all commands with an "Agent model policy" line
# =============================================================================

# agents:
#   default_model: "sonnet"      # main orchestrator/agent model: "sonnet" | "opus" | "haiku"
#   subagent_model: "sonnet"     # model for child sub-agents (orchestrate, review-pr, ...)`,
  },
  {
    key: "repos",
    block: (v) => `# =============================================================================
# REPOS (OPTIONAL) — multi-repo configuration. Remove the # to enable.
# =============================================================================

# repos:
#   default:
#     repo: "${esc(v.owner)}/${esc(v.repo)}"
#     staging_branch: "${esc(v.stagingBranch)}"
#   satellites:
#     - prefix: "mcp"
#       repo: "${esc(v.owner)}/your-satellite-repo"
#       staging_branch: "main"`,
  },
  {
    key: "project_board",
    block: (v) => `# =============================================================================
# PROJECT BOARD (OPTIONAL) — GitHub Projects v2 integration.
# To find IDs: gh project list --owner ${esc(v.owner)}
# =============================================================================

# project_board:
#   owner: "${esc(v.owner)}"
#   project_number: 1
#   project_id: "PVT_kwHOxxxxxxxxxxxxxxxx"
#   field_ids:
#     status: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"`,
  },
  {
    key: "pipeline",
    block: () => `# =============================================================================
# PIPELINE (OPTIONAL) — tuning knobs for the /orchestrate batch engine.
# Commands: orchestrate
# =============================================================================

# pipeline:
#   stall_timeout_minutes: 15        # minutes an agent may sit idle before auto-resume
#   token_budget_per_batch: 900000   # per-batch token ceiling for the review-finding cascade
#   token_estimate_per_finding: 150000
#   narration: "terse"               # "terse" | "verbose"`,
  },
  {
    key: "services",
    block: () => `# =============================================================================
# SERVICES (OPTIONAL) — external service URLs for analytics/monitoring/GEO audit.
# Commands: analytics, geo-audit, autopilot (analytics snapshot)
# =============================================================================

# services:
#   domain: "acme.io"
#   gsc_property: "https://acme.io"
#   app_url: "https://acme.io"
#   api_url: "https://api.acme.io"
#   analytics:
#     umami:
#       url: "https://umami.acme.io"
#       website_id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#     clarity:
#       project_id: "xxxxxxxxxx"
#     ga4:
#       property_id: "000000000"`,
  },
  {
    key: "review",
    block: () => `# =============================================================================
# REVIEW (OPTIONAL) — context injected into review agent prompts.
# =============================================================================

# review:
#   tech_stack: "Node.js, TypeScript, PostgreSQL"
#   context: |
#     Describe your repo structure and any unusual conventions here.`,
  },
  {
    key: "verification",
    block: () => `# =============================================================================
# VERIFICATION (OPTIONAL) — health checks for quality gate / validate.
# =============================================================================

# verification:
#   health_endpoint: "https://api.example.com/health"
#   health_patterns:
#     - '"status": "ok"'`,
  },
  {
    key: "deploy",
    block: () => `# =============================================================================
# DEPLOY (OPTIONAL) — deployment model configuration.
# Commands: deploy-info, incident-response, rollback, work-on (Phase 3J)
# =============================================================================

# deploy:
#   workflow: "deploy.yml"           # GitHub Actions workflow filename used to trigger deploys
#   workflow_inputs:
#     services: "services"
#     reason: "reason"
#   secrets_backend: "sops"          # sops | aws-sm | vault | ci-env | none`,
  },
  {
    key: "autopilot",
    block: () => `# =============================================================================
# AUTOPILOT (OPTIONAL) — configuration for the /autopilot autonomous deploy loop.
# Commands: autopilot
# =============================================================================

# autopilot:
#   ops_issue_label: "autopilot-ops"
#   headless: false                  # opt-in to unattended fixing; default: false
#   approve:
#     p0: needs-human
#     p1: needs-human
#     p2: auto
#     p3: auto
#   budget:
#     per_cycle_fixes: 3
#     per_cycle_tokens: null`,
  },
  {
    key: "billing",
    block: () => `# =============================================================================
# BILLING (OPTIONAL) — financial integrity checks in /security-audit.
# Commands: security-audit (Phase 4 — Financial Integrity)
# =============================================================================

# billing:
#   enabled: false`,
  },
  {
    key: "devdocs",
    block: () => `# =============================================================================
# DEVDOCS (OPTIONAL) — path to the devdocs knowledge tree.
# Commands: docs init
# =============================================================================

# devdocs:
#   path: "devdocs"`,
  },
  {
    key: "adaptive_scripts",
    block: () => `# =============================================================================
# ADAPTIVE_SCRIPTS (OPTIONAL) — per-repo scripts ForgeDock learns and updates.
# Commands: work-on (script discovery), optimize (script generation)
# =============================================================================

# adaptive_scripts:
#   enabled: true
#   directory: ".forgedock/scripts"
#   commit: false`,
  },
  {
    key: "learned",
    block: () => `# =============================================================================
# LEARNED (OPTIONAL) — agent-writable patterns captured across sessions.
# Commands: work-on (Phase 0B reads; Phase 1D writes)
# =============================================================================

# learned:
#   branch_targets:
#     staging: "develop"
#   test_commands:
#     - "pnpm typecheck"
#   label_map:
#     "workflow:investigating": "needs-triage"
#   commit_style: "conventional-with-scope"`,
  },
  {
    key: "index",
    block: () => `# =============================================================================
# INDEX (OPTIONAL) — per-commit code index for scripts/code-index.sh.
# Commands: work-on:investigate, work-on/build/architect, review-pr
# =============================================================================

# index:
#   languages: "Python,JavaScript,TypeScript,Go"
#   cache_dir: ".forge/index"
#   enabled: true`,
  },
  {
    key: "attribution",
    block: () => `# =============================================================================
# ATTRIBUTION (OPTIONAL) — opt-in growth features (PR/annotation footer links).
# Commands: work-on/review, review-pr
# =============================================================================

# attribution:
#   pr_footer: true
#   annotation_link: true`,
  },
  {
    key: "pattern_feeds",
    block: () => `# =============================================================================
# PATTERN_FEEDS (OPTIONAL) — subscribe to external pattern card repositories.
# Commands: scripts/build-knowledge-index.mjs, quality-gate, optimize
# =============================================================================

# pattern_feeds:
#   feeds:
#     - slug: "forge-core"
#       repo: "RapierCraftStudios/forge-patterns"
#       ref: "abc1234def5678..."   # REQUIRED: pinned commit SHA — never a branch name
#       path: "cards"
#       stacks: ["node", "bash", "gha"]
#       priority: "LOW"
#   enabled: true`,
  },
];

/**
 * Write forge.yaml from reviewed values.
 * @param {{owner:string,repo:string,name:string,description:string,root:string,
 *          worktreeBase:string,defaultBranch:string,stagingBranch:string}} v
 *   Exactly the object annotatedReviewScreen resolves with.
 * @param {string[]} lowConfidenceKeys - keys to flag with # TODO comments.
 * @param {string} outputPath
 * @returns {{ todoCount: number }}
 */
export function writeForgeYaml(v, lowConfidenceKeys, outputPath) {
  const low = lowConfidenceKeys;
  const header = `# forge.yaml — ForgeDock Configuration
#
# Auto-generated by: npx forgedock
# Fields marked with TODO comments below were guessed — verify them.
#
# Required sections: project, paths, branches
# Optional sections: agents, repos, project_board, pipeline, services, review,
#   verification, deploy, autopilot, billing, devdocs, adaptive_scripts,
#   learned, index, attribution, pattern_feeds
#
# See docs/CONFIG.md for full reference.

# =============================================================================
# PROJECT (REQUIRED)
# =============================================================================

project:
  name: "${esc(v.name)}"${todo("name", low)}
  owner: "${esc(v.owner)}"${todo("owner", low)}
  repo: "${esc(v.repo)}"${todo("repo", low)}
  description: "${esc(v.description)}"${todo("description", low)}

# =============================================================================
# PATHS (REQUIRED)
# =============================================================================

paths:
  root: "${esc(v.root)}"${todo("root", low)}
  worktree_base: "${esc(v.worktreeBase)}"${todo("worktreeBase", low)}

# =============================================================================
# BRANCHES (REQUIRED)
# =============================================================================

branches:
  default: "${esc(v.defaultBranch)}"${todo("defaultBranch", low)}
  staging: "${esc(v.stagingBranch)}"${todo("stagingBranch", low)}
  feature_pattern: "milestone/{slug}"`;

  const content = [header, ...OPTIONAL_SECTIONS.map((s) => s.block(v))].join("\n\n") + "\n";
  // Atomic write: write to a temp file first, then rename into place.
  // If the write fails (e.g. ENOSPC), the original file is untouched and
  // any partial .tmp is cleaned up — no corrupt or missing forge.yaml.
  const tmpPath = outputPath + ".tmp";
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, outputPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
  const todoCount = (content.match(/# TODO\(forgedock:/g) || []).length;
  return { todoCount };
}

/**
 * Backfill any of the 16 optional forge.yaml sections missing from an
 * existing config file (#1982). Additive only — never edits, reorders, or
 * removes existing content. Required sections, already-present optional
 * sections, and any hand-edited content are left byte-for-byte untouched;
 * only trailing whitespace at the very end of the file is trimmed before
 * appending. Follows the same atomic temp+rename write pattern as
 * writeForgeYaml() (ref: #1396 — a non-atomic write here could corrupt the
 * user's forge.yaml on disk-full).
 *
 * A section counts as "present" if its top-level key appears either active
 * (`key:` at column 0 — the user enabled it) or as the standard commented
 * stub (`# key:`) anywhere in the file. Detection is intentionally strict
 * about indentation (no arbitrary leading whitespace) so a same-named key
 * nested under an unrelated section can never produce a false "present".
 *
 * @param {string} cwd - directory containing forge.yaml
 * @returns {{ present: boolean, added: string[], alreadyPresent: string[] }}
 *   `present: false` means no forge.yaml exists at cwd — added/alreadyPresent
 *   are both empty; the caller should direct the user to `npx forgedock init`
 *   instead of migrate.
 */
export function backfillForgeYaml(cwd) {
  const outputPath = join(cwd, "forge.yaml");
  if (!existsSync(outputPath)) {
    return { present: false, added: [], alreadyPresent: [] };
  }
  const raw = readFileSync(outputPath, "utf-8");

  // Best-effort values for the blocks that interpolate project identity
  // (repos/project_board examples) — read from the existing file's REQUIRED
  // sections so backfilled examples reference this project rather than a
  // generic placeholder. Falls back to placeholders if unset/unparseable;
  // these only ever land inside commented-out example text.
  const v = {
    owner: raw.match(/^\s*owner:\s*"([^"]*)"/m)?.[1] || "your-org",
    repo: raw.match(/^\s*repo:\s*"([^"]*)"/m)?.[1] || "your-repo",
    stagingBranch: raw.match(/^\s*staging:\s*"([^"]*)"/m)?.[1] || "staging",
  };

  const added = [];
  const alreadyPresent = [];
  const newBlocks = [];
  for (const section of OPTIONAL_SECTIONS) {
    const isActive = new RegExp(`^${section.key}:`, "m").test(raw);
    const isStub = new RegExp(`^#\\s?${section.key}:`, "m").test(raw);
    if (isActive || isStub) {
      alreadyPresent.push(section.key);
    } else {
      added.push(section.key);
      newBlocks.push(section.block(v));
    }
  }

  if (added.length === 0) {
    return { present: true, added, alreadyPresent };
  }

  const trimmedRaw = raw.replace(/\s+$/, "");
  const content = `${trimmedRaw}\n\n${newBlocks.join("\n\n")}\n`;

  const tmpPath = outputPath + ".tmp";
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, outputPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }

  return { present: true, added, alreadyPresent };
}

/** Maps manual-flow value keys to their location in a ConfigDraft. */
const DRAFT_KEY_PATHS = {
  owner: ["project", "owner"],
  repo: ["project", "repo"],
  name: ["project", "name"],
  root: ["paths", "root"],
  worktreeBase: ["paths", "worktreeBase"],
  defaultBranch: ["branches", "default"],
  stagingBranch: ["branches", "staging"],
};

/**
 * Compute which fields accepted in the `--manual` init flow should be flagged
 * low-confidence (and so get a `# TODO(forgedock:<field>)` comment).
 *
 * A field counts as low-confidence when detection scored it "low" AND the
 * user accepted the detected value unchanged (didn't type over the default).
 * `description` is special-cased: it has no draft entry, so it counts as low
 * when detection found nothing (empty) and the user also left it empty.
 *
 * Pure — no I/O, safe to unit test directly.
 *
 * @param {import('./init-detect.mjs').ConfigDraft} draft
 * @param {{ value: string, source: string }} description
 * @param {{owner:string,repo:string,name:string,description:string,root:string,
 *          worktreeBase:string,defaultBranch:string,stagingBranch:string}} values
 *   The values accepted from the manual prompts.
 * @returns {string[]}
 */
export function manualLowConfidenceKeys(draft, description, values) {
  const keys = [];
  for (const [key, path] of Object.entries(DRAFT_KEY_PATHS)) {
    const field = path.reduce(
      (node, k) => (node && typeof node === "object" ? node[k] : undefined),
      draft,
    );
    if (field && field.confidence === "low" && values[key] === field.value) {
      keys.push(key);
    }
  }
  if (!description.value && !values.description) {
    keys.push("description");
  }
  return keys;
}

/**
 * Back up an existing file to <name>.bak (timestamped if .bak exists).
 * @returns {{ backupName: string } | null} null when the file didn't exist.
 */
/**
 * Back up an existing file to <name>.bak, keeping `.bak` as the newest copy.
 *
 * Regression fix (forge#1850): the previous implementation left the bare
 * `.bak` untouched once created, so only the FIRST-ever clobber's content
 * ever lived there — every later overwrite rotated the (by then already
 * stubbed) current file into a timestamped sibling instead. The net effect
 * was that the newest-looking backup (by filename/mtime) was the most
 * stubbed one, while the one recoverable good copy sat forever under the
 * unindicated bare name. A user restoring "the .bak" or "the newest backup"
 * got garbage either way.
 *
 * Fixed behavior: before writing the current file into `.bak`, rotate any
 * existing `.bak` out to a timestamped file first. `.bak` therefore always
 * holds the immediately-prior state (the best next guess for "undo my last
 * run"), and the full chronological history is preserved in timestamped
 * files — nothing is ever silently buried.
 *
 * @returns {{ backupName: string } | null} null when the file didn't exist.
 */
export function backupExisting(outputPath) {
  if (!existsSync(outputPath)) return null;
  const baseBak = outputPath + ".bak";
  if (existsSync(baseBak)) {
    // Guard against two rotations landing on the same millisecond timestamp
    // (e.g. rapid successive calls in tests, or a fast disk) silently
    // clobbering an already-rotated generation.
    let rotatedPath = `${baseBak}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let suffix = 1;
    while (existsSync(rotatedPath)) {
      rotatedPath = `${baseBak}.${new Date().toISOString().replace(/[:.]/g, "-")}-${suffix++}`;
    }
    renameSync(baseBak, rotatedPath);
  }
  renameSync(outputPath, baseBak);
  return { backupName: basename(baseBak) };
}

/**
 * Lightweight forge.yaml presence/shape check for the install receipt
 * (Issue #1946) — no YAML parser dependency, mirrors the regex-based
 * approach already used by resolveLabelsRepo() in bin/forgedock.mjs. Only
 * checks that the three REQUIRED top-level section keys are present; never
 * reads field values or copies file contents into the caller's result.
 * @param {string} cwd
 * @returns {{ present: boolean, validShape: boolean }}
 */
export function validateForgeYamlShape(cwd) {
  const p = join(cwd, "forge.yaml");
  if (!existsSync(p)) return { present: false, validShape: false };
  try {
    const raw = readFileSync(p, "utf-8");
    const validShape = /^project:/m.test(raw) && /^paths:/m.test(raw) && /^branches:/m.test(raw);
    return { present: true, validShape };
  } catch {
    return { present: true, validShape: false };
  }
}

// ---------------------------------------------------------------------------
// Description detection (moved from forgedock.mjs init(), Task 4)
// ---------------------------------------------------------------------------

function firstParagraph(content) {
  const lines = content.split("\n");
  let started = false;
  const out = [];
  for (const line of lines) {
    if (!started && line.match(/^#/)) continue;
    if (!started && line.trim() === "") continue;
    if (!started && line.match(/^[!<\[`|]/)) continue;
    if (!started && line.match(/^---/)) continue;
    if (!started) started = true;
    if (line.trim() === "") break;
    out.push(line.trim());
  }
  if (out.length === 0) return "";
  return out
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .slice(0, 200)
    .trim();
}

/**
 * Detect a project description from README.md, falling back to CLAUDE.md.
 * @returns {{ value: string, source: 'README.md'|'CLAUDE.md'|'' }}
 */
export function detectDescription(cwd) {
  for (const file of ["README.md", "CLAUDE.md"]) {
    try {
      const p = join(cwd, file);
      if (!existsSync(p)) continue;
      const value = firstParagraph(readFileSync(p, "utf-8").slice(0, 2048));
      if (value) return { value, source: file };
    } catch {
      // best-effort only
    }
  }
  return { value: "", source: "" };
}

// ---------------------------------------------------------------------------
// Journey context (Task 5)
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from "child_process";
import os from "os";
import {
  renderMark, ember, shimmer, revealRows, moltenBar, fixCard,
  colorMode, motionEnabled, CHROME_STOPS, HERO_MARK, COMPACT_MARK, sleep,
} from "./cinema.mjs";
import { detectEnvironment, wslPathToWindows } from "./env-detect.mjs";

// ---------------------------------------------------------------------------
// URL opener (default openFn implementation — injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Open a URL in the system default browser. Best-effort: errors are swallowed
 * so the caller's journey continues even when no browser is available.
 *
 * Platform dispatch:
 *   Linux   → xdg-open
 *   macOS   → open
 *   Windows → start (via shell)
 */
export function openUrl(url) {
  try {
    if (process.platform === "win32") {
      spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    } else if (process.platform === "darwin") {
      spawnSync("open", [url], { detached: true, stdio: "ignore" });
    } else {
      spawnSync("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
  } catch {
    // Best-effort — if the browser can't be opened, the journey continues.
  }
}

/**
 * Build the shared journey context. Every act takes this as its first arg.
 * All process-touching values are injectable for tests.
 */
export function makeCtx(overrides = {}) {
  const env = overrides.env ?? process.env;
  const stdout = overrides.stdout ?? process.stdout;
  const argv = overrides.argv ?? process.argv.slice(2);
  const nodeVersion = overrides.nodeVersion ?? process.versions.node;
  const enrichFn = overrides.enrichFn ?? enrich;
  const isCliAvailableFn = overrides.isCliAvailableFn ?? isClaudeCliAvailable;
  const openFn = overrides.openFn ?? openUrl;
  const confirmFn = overrides.confirmFn ?? confirm;
  const platform = overrides.platform ?? process.platform;
  let release = overrides.release;
  if (release === undefined) {
    try {
      release = os.release();
    } catch {
      release = "";
    }
  }
  return {
    cwd: process.cwd(),
    home: env.HOME || env.USERPROFILE || os.homedir(),
    forgeHome: "",
    argv,
    env,
    stdout,
    mode: colorMode(env, stdout),
    motion: motionEnabled(argv, env, stdout),
    nodeVersion,
    platform,
    release,
    linkStrategy: "symlink",
    enrichFn,
    isCliAvailableFn,
    openFn,
    confirmFn,
    exec: (cmd, args) =>
      execFileSync(cmd, args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      }).trim(),
    startedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Act I — Ignition: hero mark + preflight checks (Task 5)
// ---------------------------------------------------------------------------

const dimLine = (ctx, s) => (ctx.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);

/**
 * Render the hero banner and run preflight checks. Failures render fix cards
 * and the journey continues — advisory, never fatal. Includes informational
 * Platform/WSL/Shell rows (via env-detect.mjs) after the pass/fail checks —
 * those three always report `ok: true`, they surface state rather than gate it.
 * @returns {Promise<{ checks: Array<{name, ok, detail, fix?}>, ghReady: boolean }>}
 */
export async function preflight(ctx) {
  const { stdout: w } = ctx;
  w.write("\n");
  await shimmer(HERO_MARK, CHROME_STOPS, { mode: ctx.mode, motion: ctx.motion, writer: w });
  w.write("\n  " + ember("F O R G E D O C K", ctx.mode) + "\n");
  w.write("  " + dimLine(ctx, `──── ${getLogoTagline("install")} ────────────────────`) + "\n\n");

  const rows = [
    {
      label: "Node",
      run: async () => {
        const major = Number(ctx.nodeVersion.split(".")[0]);
        return major >= 18
          ? { ok: true, detail: `v${ctx.nodeVersion}` }
          : { ok: false, detail: `v${ctx.nodeVersion} — need ≥18`, fix: ["Upgrade Node: https://nodejs.org/"] };
      },
    },
    {
      label: "git",
      run: async () => {
        try {
          const v = ctx.exec("git", ["--version"]);
          return { ok: true, detail: v.replace(/^git version\s*/, "") };
        } catch {
          return { ok: false, detail: "not found", fix: ["Install git: https://git-scm.com/downloads"] };
        }
      },
    },
    {
      label: "Claude Code",
      run: async () => {
        const claudeDir = join(ctx.home, ".claude");
        return existsSync(claudeDir)
          ? { ok: true, detail: "~/.claude found" }
          : { ok: false, detail: "~/.claude not found", fix: ["Install Claude Code: https://claude.com/claude-code"] };
      },
    },
    {
      label: "GitHub CLI",
      run: async () => {
        try {
          ctx.exec("gh", ["--version"]);
        } catch {
          return {
            ok: false,
            detail: "not found",
            fix: ["Install gh: https://cli.github.com/", "Windows: winget install GitHub.cli"],
          };
        }
        try {
          ctx.exec("gh", ["auth", "status"]);
          return { ok: true, detail: "authenticated" };
        } catch {
          return { ok: false, detail: "not authenticated", fix: ["Run: gh auth login"] };
        }
      },
    },
  ];

  // Environment reveal rows (platform/WSL/shell) — informational only, never
  // fail the preflight. Appended after the existing 4 checks so `named[3]`
  // (GitHub CLI, used for `ghReady` below) keeps its index.
  const envInfo = detectEnvironment({ platform: ctx.platform, env: ctx.env, release: ctx.release });
  rows.push(
    {
      label: "Platform",
      run: async () => {
        const wslNote = envInfo.isWSL ? ` (WSL${envInfo.wslDistro ? `: ${envInfo.wslDistro}` : ""})` : "";
        return { ok: true, detail: `${envInfo.platformLabel}${wslNote} (${envInfo.shell})` };
      },
    },
    {
      label: "WSL",
      run: async () => ({
        ok: true,
        detail: envInfo.isWSL ? envInfo.wslDistro || "detected" : "not detected",
      }),
    },
    {
      label: "Shell",
      run: async () => ({ ok: true, detail: envInfo.shell }),
    },
  );

  const results = await revealRows(rows, { mode: ctx.mode, motion: ctx.motion, writer: w });
  const named = rows.map((r, i) => ({ name: r.label, ...results[i] }));
  return { checks: named, ghReady: named[3].ok };
}

// ---------------------------------------------------------------------------
// Act II — Forging: command symlinks + SessionStart hook (Task 6)
// ---------------------------------------------------------------------------

import { mkdir, symlink, readlink, lstat, readdir, rename, copyFile, readFile, writeFile, unlink, rm, open } from "fs/promises";
import { compareVersions } from "./registry.mjs";
import { relative, dirname as pathDirname, isAbsolute } from "path";
import {
  installSessionStartHook,
  installSubagentStopHook,
  installPreToolUseHook,
  removeSubagentStopEnforceHook,
} from "./settings-hook.mjs";

/**
 * Parse the `install:` tier from a command spec's YAML frontmatter block.
 *
 * Reads the first 512 bytes of the file synchronously (large enough to reach
 * any realistic frontmatter block without loading the full spec into memory).
 * Strips a leading UTF-8 BOM if present — BOM-prefixed files would cause the
 * frontmatter regex to miss the leading `---` delimiter.
 *
 * Tier values:
 *   'core'     — install for all users (default when key is absent or on any error)
 *   'extras'   — opt-in, not installed by default; use `npx forgedock install --extras` (#1257)
 *   'internal' — ForgeDock development only; never installed to user machines
 *
 * Fail-open: any read error, malformed frontmatter, or unrecognised value falls
 * back to `'core'` so the command is installed rather than silently excluded.
 *
 * @param {string} filePath - Absolute path to the .md command spec.
 * @returns {'core' | 'extras' | 'internal'}
 */
export function parseInstallTier(filePath) {
  try {
    // Read the file as UTF-8. readFileSync is already imported from "fs" at the
    // top of this module — no require() needed in this ESM file. For large specs
    // only the first 512 bytes are relevant (frontmatter fits comfortably within
    // that budget), but readFileSync is simpler and safe for the file sizes here.
    let content = readFileSync(filePath, "utf-8");
    // Strip BOM — a BOM-prefixed file would shift the leading `---` off the
    // start of the string and cause the frontmatter regex to miss it entirely.
    // (Ref: review-finding #657 — parseFrontmatter silently falls back on BOM files)
    content = content.replace(/^\uFEFF/, "");

    // Match YAML frontmatter block: must start at position 0.
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return "core";

    const raw = match[1];
    for (const line of raw.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      if (key !== "install") continue;
      const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (val === "internal" || val === "extras" || val === "core") return val;
      return "core"; // unrecognised value → default
    }
    return "core"; // key absent
  } catch {
    return "core"; // any read/parse error → fail-open
  }
}

/** Recursively find installable .md files, sorted (moved from forgedock.mjs).
 *
 * Files with `install: internal` in their YAML frontmatter are excluded — they
 * are ForgeDock-development-only specs that must never reach user machines.
 * Files with `install: core` (or no `install:` key) are included. Files with
 * `install: extras` are excluded from the default install surface; they are
 * available via `npx forgedock install --extras` (implemented in #1257).
 *
 * @param {string} dir - Directory to search recursively.
 * @param {{ includeExtras?: boolean }} [opts] - Options.
 *   includeExtras: when true, also include `install: extras` specs (opt-in tier).
 */
export async function findMarkdownFiles(dir, opts = {}) {
  const { includeExtras = false } = opts;
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findMarkdownFiles(full, opts)));
    } else if (entry.name.endsWith(".md")) {
      const tier = parseInstallTier(full);
      if (tier === "core" || (includeExtras && tier === "extras")) {
        results.push(full);
      }
      // 'internal' is always excluded from the install surface
    }
  }
  return results.sort();
}

/** Load the copied-commands ownership manifest (missing/corrupt → empty). */
async function loadCopiedManifest(manifestPath) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
      return { version: 1, files: parsed.files };
    }
  } catch {
    // missing or corrupt → start fresh
  }
  return { version: 1, files: {} };
}

/** Save the manifest atomically (mkdir recursive + .tmp+rename). */
async function saveCopiedManifest(manifestPath, manifest) {
  await mkdir(pathDirname(manifestPath), { recursive: true });
  // Suffix the tmp sibling with this process's PID so concurrent forge()
  // invocations never share the same tmp path — mirrors the fix already
  // applied to the copy-file branch in this same function (forge#2542).
  const tmpPath = manifestPath + "." + process.pid + ".tmp";
  try {
    await writeFile(tmpPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  } catch (writeErr) {
    await unlink(tmpPath).catch(() => {});
    throw writeErr;
  }
  try {
    await rename(tmpPath, manifestPath);
  } catch (renameErr) {
    await unlink(tmpPath).catch(() => {});
    throw renameErr;
  }
}

// Age (ms) below which a pid-suffixed manifest tmp sibling is assumed to be a
// concurrent forge()'s in-flight write and left untouched. Anything older is a
// crash-orphan (SIGKILL/OOM/power loss between writeFile and rename) that no
// future pid-matched run and no other cleanup path will ever reclaim
// (forge#2612). Generous relative to real write→rename latency.
const STALE_MANIFEST_TMP_AGE_MS = 60_000;

// Age (ms) above which a held manifest lock file is assumed to be a
// crash-orphan (the holder died between acquiring the lock and releasing it)
// rather than a live concurrent holder, and is safe to reclaim. Deliberately
// shorter than STALE_MANIFEST_TMP_AGE_MS (60s, forge#2612) rather than
// matching it: the lock's critical section (one readFile+JSON.parse, an
// in-memory loop, one writeFile+rename) is far lighter than the write this
// process guards against staleness in the tmp-sweep case, so a live holder
// should never legitimately hold this lock anywhere near that long. Not set
// as low as the original 10s either — that left too little headroom under
// slow I/O (AV scanning, network home dirs, loaded CI), which could plausibly
// exceed 10s and trigger premature reclaim of a still-live lock (review
// finding on PR #2654, forge#2655). 30s is a documented middle ground: 3x the
// original headroom, still 2x shorter than the tmp precedent.
const STALE_MANIFEST_LOCK_AGE_MS = 30_000;

// Bounded retry/backoff for acquireManifestLock (forge#2637). Total worst-case
// wait is small (a few hundred ms) — long enough to let a concurrent holder's
// short critical section finish, short enough that a stuck/foreign lock never
// meaningfully delays a forge() run before falling back to unlocked behavior.
const MANIFEST_LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 150];

/**
 * Acquire an exclusive lock guarding the manifest's final read→merge→write
 * critical section (forge#2637). Uses `fs.open(lockPath, 'wx')` — O_EXCL
 * create — as a zero-dependency mutual-exclusion primitive: the call fails
 * with EEXIST if another process already holds the lock, and succeeds
 * atomically otherwise (no separate exists-check + create races).
 *
 * On contention, retries with the bounded backoff schedule above. Each retry
 * also opportunistically busts a stale lock (older than
 * STALE_MANIFEST_LOCK_AGE_MS — a crash-orphan from a holder that died before
 * releasing) so a hard-killed process can never permanently deadlock future
 * runs.
 *
 * Never throws. Returns the open file handle on success, or `null` if the
 * lock could not be acquired after all retries — callers MUST treat `null`
 * as "proceed without the lock" (this file's manifest-save path is
 * best-effort/never-abort by design; the lock narrows the race window, it is
 * not a hard correctness requirement).
 */
async function acquireManifestLock(manifestPath) {
  const lockPath = manifestPath + ".lock";
  for (let attempt = 0; attempt <= MANIFEST_LOCK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await open(lockPath, "wx");
    } catch (err) {
      if (err?.code !== "EEXIST") return null; // unexpected error (e.g. EACCES) — proceed unlocked
      // Contended — opportunistically reclaim a stale (crash-orphaned) lock.
      let reclaimed = false;
      try {
        const st = await lstat(lockPath);
        if (Date.now() - st.mtimeMs >= STALE_MANIFEST_LOCK_AGE_MS) {
          // Re-stat immediately before deleting and only unlink if it's
          // provably the SAME file we just judged stale (matching inode +
          // mtime) — a plain lstat-then-unlink-by-path has a window where
          // the original holder releases and a brand-new live holder
          // acquires a fresh lock at this same path in between; unlinking
          // by path alone would then delete that new holder's live lock,
          // reproducing the exact race this lock exists to prevent, one
          // layer down (review finding on PR #2654). If the file changed
          // (or vanished) between the two stats, leave it alone — some
          // other process has since claimed or released the path — and let
          // the next retry iteration re-evaluate from scratch.
          try {
            const st2 = await lstat(lockPath);
            if (st2.ino === st.ino && st2.mtimeMs === st.mtimeMs) {
              await unlink(lockPath).catch(() => {});
              reclaimed = true;
            }
          } catch {
            // vanished between the two stats — already released, nothing to reclaim
          }
        }
      } catch {
        // lock file vanished between the failed open and this stat (the
        // holder released it) — fall through to the next attempt/retry.
      }
      // A successful reclaim just proved the path is free — retry open()
      // immediately instead of waiting out the full backoff delay for this
      // iteration (review finding on PR #2654, forge#2656). Still counts as
      // a used attempt (loop counter still advances), it just skips the
      // sleep.
      if (reclaimed) continue;
      if (attempt === MANIFEST_LOCK_RETRY_DELAYS_MS.length) return null; // retries exhausted
      await new Promise((resolve) => setTimeout(resolve, MANIFEST_LOCK_RETRY_DELAYS_MS[attempt]));
    }
  }
  return null;
}

/**
 * Release a lock acquired by acquireManifestLock() (forge#2637). Closes the
 * handle and removes the lock file. Never throws — same best-effort contract
 * as the rest of the manifest-save path; a failure to release cleanly is
 * recovered by the next contender's stale-lock reclaim in
 * acquireManifestLock() rather than by this function succeeding.
 */
async function releaseManifestLock(manifestPath, handle) {
  if (!handle) return;
  await handle.close().catch(() => {});
  await unlink(manifestPath + ".lock").catch(() => {});
}

/**
 * Best-effort sweep of crash-orphaned pid-suffixed manifest tmp siblings
 * (forge#2612). saveCopiedManifest() writes to `manifestPath.<pid>.tmp` then
 * renames it into place; if the process is hard-killed in that window the
 * pid-suffixed tmp is orphaned permanently — no future run reuses that exact
 * pid (unlike the old shared literal `.tmp` name any run would overwrite) and
 * no other cleanup path scans this directory. Removes siblings matching
 * `<manifest-basename>.<digits>.tmp` that are older than
 * STALE_MANIFEST_TMP_AGE_MS (so a concurrent forge()'s in-flight tmp is never
 * deleted) and are not this process's own live tmp. Never throws —
 * housekeeping only, same never-abort contract as the manifest-save guard.
 */
async function sweepStaleManifestTmps(manifestPath) {
  const dir = pathDirname(manifestPath);
  const base = basename(manifestPath);
  const liveTmp = base + "." + process.pid + ".tmp";
  // Match only `<base>.<digits>.tmp` — the exact pid-suffixed shape. The legacy
  // plain `<base>.tmp` (no digit segment) is intentionally excluded so a
  // foreign/legacy sibling is never reclaimed here.
  const stalePattern = new RegExp(
    "^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.\\d+\\.tmp$",
  );
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return; // dir missing/unreadable — nothing to reclaim
  }
  const now = Date.now();
  await Promise.all(
    entries.map(async (name) => {
      if (name === liveTmp || !stalePattern.test(name)) return;
      const full = join(dir, name);
      try {
        const st = await lstat(full);
        if (now - st.mtimeMs < STALE_MANIFEST_TMP_AGE_MS) return; // maybe in-flight
        await unlink(full);
      } catch {
        // best-effort — ignore races / permission errors
      }
    }),
  );
}

const isLinkPermissionError = (err) => err.code === "EPERM" || err.code === "EACCES";

/**
 * Verify a freshly created symlink is actually readable by *this* process
 * before trusting it. `fs.symlink()` can return successfully (no EPERM/
 * EACCES — so `isLinkPermissionError()` never fires) while still producing a
 * link the OS refuses to resolve for this security/runtime context. The
 * concrete case this guards against (forge#2620): installing under Git Bash
 * (MSYS2) on Windows creates an MSYS-style symlink; the reparse point itself
 * is written successfully, but a native Windows process (the Node binary
 * behind Claude Code) later hits `"The path cannot be traversed because it
 * contains an untrusted mount point"` when it tries to read through it. That
 * failure surfaces at *read* time, not at *creation* time, and with an error
 * code (`UNKNOWN`/`EIO`, not `EPERM`/`EACCES`) that the existing permission
 * gate doesn't recognize — so the copy-fallback path never engaged and a
 * dead, unreadable link was left in place.
 *
 * Reading the link back immediately after creating it catches this (and any
 * other silently-broken-symlink case) regardless of the specific error code
 * involved, without needing to enumerate every possible OS/runtime error.
 *
 * @param {string} target - Path to the symlink just created.
 * @returns {Promise<boolean>} true if the symlink resolves and is readable.
 */
export async function isSymlinkTraversable(target) {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically install `target` as a symlink to `file`, verifying the result is
 * readable by *this* process. Single source of truth for the correctness
 * invariants that previously lived as near-verbatim copies at every symlink
 * call site (forge#2667):
 *
 * - The symlink is first created at a tmp sibling suffixed with this
 *   process's PID, then rename()d onto target. symlink() is exclusive-create,
 *   so two concurrent forge() invocations installing the same path would
 *   collide with an uncaught EEXIST on a shared literal path — the PID
 *   suffix guarantees they never share one (forge#2542, forge#2599,
 *   forge#2600, forge#2631). rename() atomically replaces any existing
 *   target, including on Windows.
 * - The tmp sibling is unlinked on every failure path so a rename failure
 *   (or any rethrow) never orphans it (forge#2612).
 * - After a successful rename, the link is read back via
 *   isSymlinkTraversable(): fs.symlink() can succeed while producing a link
 *   this runtime cannot resolve (MSYS symlink + native Windows "untrusted
 *   mount point" — forge#2620). Such a dead link is unlinked before
 *   returning so the caller can fall back to a copy.
 *
 * Callers keep their own `wantSymlink` guard and site-specific bookkeeping
 * (counters, manifest mutation, copy fall-through) around the result.
 *
 * @param {string} file   - Symlink target (the source file to link to).
 * @param {string} target - Path where the symlink is installed.
 * @returns {Promise<"linked"|"unreadable"|"denied">}
 *   "linked"     — symlink atomically installed at target and traversable.
 *   "unreadable" — symlink was created but not readable back (forge#2620);
 *                  the dead link has already been unlinked, so target may be
 *                  absent on return. Caller should restore/fall back to a copy.
 *   "denied"     — EPERM/EACCES from symlink/rename (no symlink installed;
 *                  e.g. Windows without Developer Mode). Caller should fall
 *                  back to a copy.
 *   Any other error (EEXIST on the tmp path, ENOSPC, rename failures, …) is
 *   rethrown after tmp cleanup.
 */
async function atomicSymlinkInstall(file, target) {
  const tmpTarget = target + "." + process.pid + ".tmp";
  try {
    await symlink(file, tmpTarget);
    try {
      await rename(tmpTarget, target);
    } catch (renameErr) {
      await unlink(tmpTarget).catch(() => {});
      throw renameErr;
    }
    if (await isSymlinkTraversable(target)) return "linked";
    await unlink(target).catch(() => {});
    return "unreadable";
  } catch (linkErr) {
    if (!isLinkPermissionError(linkErr)) throw linkErr;
    return "denied";
  }
}

/**
 * Allowlist of universal pipeline-agent scripts installed to
 * ~/.claude/scripts/ by forge() (linkPipelineScripts()) and cleaned up by
 * forgedock.mjs's uninstall(). This is the single source of truth for both
 * directions — re-export from forgedock.mjs rather than duplicating it.
 *
 * Deliberately narrow (forge#715): project-specific/internal tooling that
 * lives in scripts/ (verify-*.sh, doctor-pipeline-state.sh, gen-logo.mjs,
 * the self-dogfooding *.mjs analysis scripts, etc.) must NOT be copied here
 * — only scripts meant to be invoked generically by command specs without
 * knowing ForgeDock's own install path belong in this set.
 */
export const PIPELINE_SCRIPTS = new Set([
  "classify-lane.sh",
  "transition-label.sh",
  "validate-pr-target.sh",
]);

/**
 * Recursively walk targetDir and remove any symlink whose target begins with
 * commandsDir (i.e. a ForgeDock-managed link) but whose target file no longer
 * exists on disk. These are "orphaned" symlinks left behind when a command is
 * renamed or deleted.
 *
 * Safety invariant: only symlinks whose readlink() result starts with
 * commandsDir + "/" are touched. User-owned symlinks and third-party links are
 * never removed.
 *
 * @param {string} targetDir   - ~/.claude/commands (installed commands root)
 * @param {string} commandsDir - FORGE_HOME/commands (source commands root)
 * @returns {Promise<number>} Number of orphaned symlinks removed.
 */
async function pruneOrphanedSymlinks(targetDir, commandsDir) {
  const prefix = commandsDir + "/";
  let pruned = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return; // targetDir doesn't exist yet — nothing to prune
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await readlink(full);
        } catch {
          continue; // can't read link — skip
        }
        // Only manage links that point into our commandsDir
        if (!target.startsWith(prefix)) continue;
        // Check whether the target file still exists
        try {
          await lstat(target);
          // target exists — not orphaned
        } catch (err) {
          if (err.code !== "ENOENT") continue; // unexpected error — skip to be safe
          // target is gone → orphaned symlink
          try {
            await unlink(full);
            pruned++;
          } catch (unlinkErr) {
            if (unlinkErr.code !== "ENOENT") throw unlinkErr;
            // already gone — race condition, that's fine
          }
        }
      }
    }
  }

  await walk(targetDir);
  return pruned;
}

/**
 * Remove leftover extensionless entries at the top level of targetDir left
 * behind by prior `npx forgedock <command>` runs (forge#2620). Those older
 * ephemeral invocations created extensionless symlinks/directories (e.g.
 * `orchestrate`, `pipeline-health`) pointing into the npx download cache
 * (`%LocalAppData%\npm-cache\_npx\...` / `~/.npm/_npx/...`). Those cache
 * targets are routinely evicted by npx/npm cache cleanup or OS temp
 * cleanup, leaving dead entries that collide on the base command name with
 * the real `{name}.md` file this installer is about to create —
 * `mkdir(..., {recursive:true})` throws when a same-named non-directory
 * file already occupies that path segment.
 *
 * Conservative by design — must run BEFORE the main install loop so stale
 * entries are cleared before any mkdir/symlink attempt can collide with
 * them this run (pruneOrphanedSymlinks above only catches entries that
 * point *into commandsDir*, and runs after the loop; this catches the
 * separate npx-cache-origin case pre-emptively). Only removes a top-level
 * entry when its basename has no file extension (`.md` files and dotfiles
 * are never touched) AND it is a symlink whose target either no longer
 * exists or resolves into a known ephemeral cache path
 * (`isEphemeralCachePath`). Real command directories (e.g. `work-on/`)
 * created by this installer are plain directories containing `.md` files,
 * never symlinks — untouched by either condition.
 *
 * @param {string} targetDir - ~/.claude/commands
 * @returns {Promise<number>} Number of stale entries removed.
 */
// Matches a Windows drive-relative path like "C:foo" (drive letter + colon,
// NOT followed by a path separator) — as opposed to a drive-absolute path
// like "C:\foo" or "C:/foo", which path.isAbsolute() already recognizes
// correctly. A drive-relative target resolves relative to that drive's own
// current working directory, which Node has no API to query — there is no
// way to compute the correct absolute path here (review finding on PR #2658,
// forge#2659). Deliberately narrow: only fires when isAbsolute() has already
// said "no" and the string still starts with `<letter>:` immediately
// followed by a non-separator character. Platform-gated (review finding
// forge#2663): on POSIX, `:` has no special meaning in filenames, so a
// literal relative target like `C:foo` is a perfectly valid path component
// and must NOT be misclassified as an unresolvable Windows drive-relative
// path — only apply this heuristic on win32.
const WINDOWS_DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/;

export async function pruneStaleExtensionlessEntries(targetDir) {
  let pruned = 0;
  let entries;
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return pruned;
    throw err;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.includes(".")) continue; // has an extension (or is a dotfile) — never touch
    if (!entry.isSymbolicLink()) continue; // only manage symlinks here — real dirs/files are left alone
    const full = join(targetDir, name);
    let linkTarget;
    try {
      linkTarget = await readlink(full);
    } catch {
      continue; // unreadable link metadata — skip rather than guess
    }
    // readlink() returns whatever string was stored at symlink-creation time.
    // A relative target is defined (POSIX) relative to the symlink's own
    // containing directory (targetDir, since full = join(targetDir, name)) —
    // not the process cwd, which is what a raw lstat(linkTarget) would use.
    //
    // Two shapes isAbsolute() alone misclassifies as "relative" and would
    // otherwise be wrongly joined onto targetDir:
    //   - Windows drive-relative ("C:foo") — see WINDOWS_DRIVE_RELATIVE_RE
    //     above; unresolvable here, so the entry is left untouched. Only
    //     meaningful on win32 (review finding forge#2663) — on POSIX, `:` is
    //     just an ordinary filename character, so this check is skipped
    //     there and the target falls through to normal relative resolution.
    //   - Shell-style tilde ("~/foo", "~\foo", or bare "~") — expand against
    //     os.homedir() first, matching shell semantics (review finding on
    //     PR #2658, forge#2660).
    if (process.platform === "win32" && WINDOWS_DRIVE_RELATIVE_RE.test(linkTarget)) continue; // can't resolve without the drive's own cwd — leave alone
    let effectiveTarget = linkTarget;
    if (effectiveTarget === "~" || effectiveTarget.startsWith("~/") || effectiveTarget.startsWith("~\\")) {
      effectiveTarget = join(os.homedir(), effectiveTarget.slice(1));
    }
    const resolvedTarget = isAbsolute(effectiveTarget) ? effectiveTarget : join(targetDir, effectiveTarget);
    let targetMissing = false;
    try {
      await lstat(resolvedTarget);
    } catch (err) {
      if (err.code !== "ENOENT") continue; // unexpected error — skip to be safe
      targetMissing = true;
    }
    if (targetMissing || isEphemeralCachePath(linkTarget)) {
      try {
        await unlink(full);
        pruned++;
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }
  return pruned;
}

/**
 * Detect whether `p` sits inside a known ephemeral npm/npx/pnpm/yarn cache
 * directory rather than a durable install location (global npm install,
 * local repo clone, or a project's own `node_modules`).
 *
 * Used to warn when `ctx.forgeHome` — and therefore the SessionStart hook
 * script path baked into `~/.claude/settings.json` — resolves somewhere that
 * can be silently pruned later (`npm cache clean`, OS temp cleanup, npx's
 * own eviction), which would break context injection with no error surfaced.
 *
 * Matching is path-SEGMENT based (split on `/` and `\`), never a bare
 * substring match — this keeps the check conservative and avoids false
 * positives on a real install whose path merely contains one of these
 * strings (e.g. a project directory named `npx-utils` or `my-dlx-tool`).
 *
 * Recognized shapes:
 *   - npm's npx cache: a `_npx` segment — covers both
 *     `~/.npm/_npx/<hash>/node_modules/<pkg>` (POSIX) and
 *     `%LocalAppData%\npm-cache\_npx\<hash>\node_modules\<pkg>` (Windows).
 *   - pnpm's dlx cache: a `dlx` segment — pnpm's ephemeral `dlx` subdir,
 *     distinct from `node_modules/.pnpm/` (pnpm's persistent
 *     content-addressable store used by ordinary local installs, which must
 *     NOT be flagged here).
 *   - yarn (Berry) dlx: a segment matching `/^xfs-/i` — `yarn dlx` builds its
 *     throwaway project in a temp directory created via `xfs.mktempPromise()`,
 *     which yarn names with an `xfs-` prefix.
 *
 * @param {string} p - Absolute path to test (typically `ctx.forgeHome`).
 * @returns {boolean}
 */
export function isEphemeralCachePath(p) {
  if (!p || typeof p !== "string") return false;
  const segments = p.split(/[\\/]/).filter(Boolean);
  return segments.some(
    (seg) => seg === "_npx" || seg === "dlx" || /^xfs-/i.test(seg),
  );
}

// ---------------------------------------------------------------------------
// Act 0/I.5 — Persist Home: copy the toolset into a stable ~/.forge/ (#1943)
// ---------------------------------------------------------------------------

/**
 * The four top-level directories that make up ForgeDock's installable
 * payload. Kept as a single list so persistHome() and its tests agree on
 * exactly what gets copied.
 */
const PERSIST_HOME_DIRS = ["bin", "commands", "scripts", "templates"];

/**
 * Detect whether `dir` is a git working tree — has a `.git` entry at all,
 * regardless of whether it's a directory (ordinary clone) or a file (git
 * worktree, whose `.git` is a pointer file back to the main repo's `.git`
 * dir). Both shapes mean "this is a stable, user-owned git checkout" for
 * persistHome()'s purposes — neither should ever be copied into ~/.forge/.
 *
 * Uses lstatSync (not existsSync) so the check reflects the real entry on
 * disk rather than following symlinks, mirroring the detection *style* of
 * resolveRealForgeHome() in bin/forgedock.mjs (which additionally has to
 * distinguish file-vs-directory to resolve worktrees to their main repo
 * root — a distinction persistHome() doesn't need, since both shapes skip
 * identically here).
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isGitWorkingTree(dir) {
  try {
    lstatSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copy `srcDir` into `destDir`, content-comparing existing files
 * before overwriting so unchanged bytes are never rewritten (same idempotency
 * discipline as forge()'s command-linking loop and linkPipelineScripts() —
 * forge#1916). A missing `srcDir` is treated as "nothing to copy" rather than
 * an error, since not every ForgeDock release necessarily ships every one of
 * PERSIST_HOME_DIRS.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {Promise<{ copied: number, unchanged: number }>}
 */
async function copyDirIfChanged(srcDir, destDir) {
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { copied: 0, unchanged: 0 };
    throw err;
  }

  await mkdir(destDir, { recursive: true });

  let copied = 0;
  let unchanged = 0;

  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (entry.isDirectory()) {
      const sub = await copyDirIfChanged(srcPath, destPath);
      copied += sub.copied;
      unchanged += sub.unchanged;
      continue;
    }
    if (!entry.isFile()) continue; // symlinks/sockets/etc. — not expected in this payload

    let needsCopy = true;
    try {
      const [src, dst] = await Promise.all([readFile(srcPath), readFile(destPath)]);
      if (src.equals(dst)) needsCopy = false;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // destPath missing — needs copy, needsCopy stays true.
    }

    if (needsCopy) {
      await copyFile(srcPath, destPath);
      copied++;
    } else {
      unchanged++;
    }
  }

  return { copied, unchanged };
}

/**
 * Recursively delete entries in `destDir` that no longer exist in `srcDir`.
 * The mirror-image of copyDirIfChanged(): that function is additive-only (it
 * copies new/changed files but never removes anything), so a file dropped or
 * renamed upstream would otherwise linger in the persisted `~/.forge/` copy
 * forever (forge#2133). A missing `srcDir` or `destDir` is treated as
 * "nothing to reconcile" rather than an error — mirrors copyDirIfChanged()'s
 * own ENOENT handling.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {Promise<{ removed: number }>}
 */
async function removeOrphans(srcDir, destDir) {
  let destEntries;
  try {
    destEntries = await readdir(destDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0 };
    throw err;
  }

  let srcNames = null;
  try {
    const srcEntries = await readdir(srcDir, { withFileTypes: true });
    srcNames = new Set(srcEntries.map((e) => e.name));
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    // srcDir missing entirely (ENOENT), or the corresponding source path changed
    // type and is no longer a directory — e.g. a symlink-to-file replacing what
    // used to be a real directory (ENOTDIR) — every dest entry is an orphan.
    // Treating both the same way keeps this a per-path fail-open instead of
    // letting an uncaught ENOTDIR escape to persistHome()'s single outer catch,
    // which would otherwise silently skip the *entire* persist for one bad path
    // (forge#2227).
    srcNames = new Set();
  }

  let removed = 0;
  for (const entry of destEntries) {
    const destPath = join(destDir, entry.name);
    if (!srcNames.has(entry.name)) {
      await rm(destPath, { recursive: true, force: true });
      removed++;
      continue;
    }
    if (entry.isDirectory()) {
      const sub = await removeOrphans(join(srcDir, entry.name), destPath);
      removed += sub.removed;
    }
  }
  return { removed };
}

/**
 * Copy ForgeDock's own installable payload (bin/, commands/, scripts/,
 * templates/) from wherever the package currently resolved — npm global
 * install, npx/dlx cache, or any other non-git extraction — into a stable
 * `{ctx.home}/.forge/` home, and point `ctx.forgeHome` at it for the rest of
 * the journey. This is what makes `~/.claude/commands/` symlinks and the
 * SessionStart hook's baked-in script path survive npm/npx cache eviction
 * (issue #1943) — before this, both were built directly from the ephemeral
 * source location and broke silently once that cache was pruned.
 *
 * Skipped entirely when `ctx.forgeHome` is a git working tree (see
 * isGitWorkingTree() above): a git clone (or worktree) is already a stable,
 * user-owned location. Copying it into ~/.forge/ would silently disconnect
 * `git pull`/`npx forgedock update` from what's actually linked into
 * ~/.claude/commands/ — the regression issue #1943's Acceptance Criteria #5
 * explicitly calls out.
 *
 * Content-compares before overwriting (see copyDirIfChanged() above) so
 * steady-state re-runs (every `npx forgedock` invocation) don't rewrite
 * byte-identical files.
 *
 * IMPORTANT: consumes `ctx.forgeHome` exactly as already resolved by the
 * caller — it must never re-derive its own "where does ForgeDock actually
 * live" path. Re-deriving risks reintroducing the worktree-leakage
 * regression fixed by resolveRealForgeHome() (forge#1700): a worktree-scoped
 * FORGE_HOME baked into a persisted copy would dangle once the worktree is
 * removed.
 *
 * Fail-open: any filesystem error (permission denied, disk full, etc.) is
 * caught and reported via the returned `skipped`/`reason` fields rather than
 * thrown. Callers must treat a `skipped: true` result as "fall back to the
 * original ctx.forgeHome" — the pre-existing ephemeral-FORGE_HOME behavior.
 *
 * @param {{ forgeHome: string, home: string }} ctx
 * @returns {Promise<{
 *   forgeHome: string,
 *   migrated: boolean,
 *   skipped: boolean,
 *   reason?: string,
 *   version: string,
 *   filesCopied?: number,
 *   filesUnchanged?: number,
 *   filesRemoved?: number,
 * }>}
 */
export async function persistHome(ctx) {
  const source = ctx.forgeHome;
  const persistedHome = join(ctx.home, ".forge");

  if (isGitWorkingTree(source)) {
    return {
      forgeHome: source,
      migrated: false,
      skipped: true,
      reason: "git working tree — linked directly from the clone, not persisted",
      version: "",
    };
  }

  // Read the source package's version up front — best-effort, never fatal.
  // A missing/unreadable package.json degrades to an empty version string
  // rather than aborting the whole persist step.
  let version = "";
  try {
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf-8"));
    version = pkg.version || "";
  } catch {
    // proceed with version === ""
  }

  // Downgrade guard (forge#2133): if a newer version is already persisted at
  // ~/.forge/version than the source package we're about to copy from, skip
  // the copy entirely rather than silently overwriting newer files with
  // older ones. This happens when a stale resolved package (e.g. a plain
  // `npx forgedock update` that resolved an old global install) runs after
  // ~/.forge/ was already refreshed to a newer version by some other path
  // (e.g. `npx forgedock@latest`). Both `version` and the persisted value
  // must be non-empty for the guard to apply — an unreadable/missing
  // ~/.forge/version is treated as "no guard needed" so first-run persist
  // is never blocked.
  const persistedVersionPath = join(persistedHome, "version");
  let existingPersistedVersion = "";
  let persistedVersionFileExists = true;
  try {
    existingPersistedVersion = readFileSync(persistedVersionPath, "utf-8").trim();
  } catch {
    // missing/unreadable — proceed, nothing to guard against. Tracked
    // separately from existingPersistedVersion's "" default so the
    // versionChanged check below (a fresh persist with no prior version
    // file) is still correctly treated as "changed" even when the source
    // package's own version also resolves to "" (e.g. missing package.json).
    persistedVersionFileExists = false;
  }
  if (
    version &&
    existingPersistedVersion &&
    compareVersions(version, existingPersistedVersion) < 0
  ) {
    return {
      forgeHome: persistedHome,
      migrated: false,
      skipped: true,
      reason: `refusing to downgrade ~/.forge/ from v${existingPersistedVersion} to v${version} — source package is older than what's already persisted`,
      version: existingPersistedVersion,
    };
  }

  try {
    await mkdir(persistedHome, { recursive: true });

    let filesCopied = 0;
    let filesUnchanged = 0;
    let filesRemoved = 0;
    for (const name of PERSIST_HOME_DIRS) {
      const res = await copyDirIfChanged(join(source, name), join(persistedHome, name));
      filesCopied += res.copied;
      filesUnchanged += res.unchanged;
      const pruned = await removeOrphans(join(source, name), join(persistedHome, name));
      filesRemoved += pruned.removed;
    }

    // Also persist package.json itself (not just PERSIST_HOME_DIRS) — several
    // callers read `{forgeHome}/package.json` directly (readForgedockVersion()
    // in this file, used by writeInstallReceipt() — forge#1946) and expect it
    // to resolve relative to whatever ctx.forgeHome currently points at. Once
    // this function reassigns ctx.forgeHome to the persisted copy, those
    // callers would otherwise find no package.json there and silently degrade
    // to an empty version string. Copying it keeps ~/.forge a complete
    // drop-in stand-in for the original forgeHome, not just a commands/hooks
    // mirror. Missing source package.json (unusual layout) is a no-op, same
    // as any other PERSIST_HOME_DIRS entry.
    try {
      const [src, dst] = await Promise.all([
        readFile(join(source, "package.json")),
        readFile(join(persistedHome, "package.json")).catch(() => null),
      ]);
      if (!dst || !src.equals(dst)) {
        await copyFile(join(source, "package.json"), join(persistedHome, "package.json"));
        filesCopied++;
      } else {
        filesUnchanged++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // source package.json missing — nothing to persist, not an error.
    }

    // Write ~/.forge/version — content-compared like everything else here so
    // an unchanged version doesn't touch the file's mtime on every re-run.
    // Reuses persistedVersionPath/existingPersistedVersion read above for the
    // downgrade guard rather than re-reading the same file a second time. A
    // version file that didn't exist yet (persistedVersionFileExists: false)
    // always counts as "changed", regardless of whether the source's own
    // version happens to also be "" (e.g. missing package.json) — otherwise
    // "" !== "" would wrongly read as unchanged on a fresh, never-persisted
    // ~/.forge/.
    let versionChanged = !persistedVersionFileExists || existingPersistedVersion !== version;
    if (versionChanged) {
      const tmpVersionPath = persistedVersionPath + ".tmp";
      try {
        writeFileSync(tmpVersionPath, version + "\n", "utf-8");
        renameSync(tmpVersionPath, persistedVersionPath);
      } catch (err) {
        try { unlinkSync(tmpVersionPath); } catch { /* best-effort cleanup */ }
        throw err;
      }
    }

    return {
      forgeHome: persistedHome,
      migrated: filesCopied > 0 || filesRemoved > 0 || versionChanged,
      skipped: false,
      version,
      filesCopied,
      filesUnchanged,
      filesRemoved,
    };
  } catch (err) {
    // Fail-open (forge#383): a permission error, disk-full, etc. must never
    // abort install/update — fall back to the original, un-persisted forgeHome.
    return {
      forgeHome: source,
      migrated: false,
      skipped: true,
      reason: `error: ${err && err.message ? err.message : String(err)}`,
      version,
    };
  }
}

/**
 * Link the PIPELINE_SCRIPTS allowlist from {forgeHome}/scripts/ into
 * ~/.claude/scripts/, using the same symlink-first / copy-fallback strategy
 * as command installation (isLinkPermissionError-gated). Flat set, no
 * subdirectories, no ownership manifest needed — three well-known filenames.
 *
 * Restores the linkScripts() step (commit 9bf382a, forge#677) that was
 * silently dropped when install moved from the legacy install()/update()
 * flow to this journey-based forge() (forge#1885).
 *
 * @param {{forgeHome: string, home: string, linkStrategy?: string}} ctx
 * @returns {Promise<{installed: number, updated: number, skipped: number, copied: number, total: number}>}
 */
async function linkPipelineScripts(ctx) {
  const scriptsSourceDir = join(ctx.forgeHome, "scripts");
  const scriptsTargetDir = join(ctx.home, ".claude", "scripts");
  const wantSymlink = ctx.linkStrategy !== "copy";

  await mkdir(scriptsTargetDir, { recursive: true });

  let installed = 0, updated = 0, skipped = 0, copied = 0;

  for (const name of PIPELINE_SCRIPTS) {
    const file = join(scriptsSourceDir, name);
    if (!existsSync(file)) continue; // source missing (unusual package layout) — skip silently

    const target = join(scriptsTargetDir, name);
    let existed = false;
    let alreadyCorrect = false;

    try {
      const stats = await lstat(target);
      existed = true;
      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) alreadyCorrect = true;
      } else if (stats.isFile() && !wantSymlink) {
        // Copy-fallback path (Windows without Developer Mode): content-compare
        // before unlinking/recopying, matching the sibling linkCommands() loop
        // and the legacy linkScripts() this restores (forge#1916).
        const [src, dst] = await Promise.all([readFile(file), readFile(target)]);
        if (src.equals(dst)) alreadyCorrect = true;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    if (alreadyCorrect) {
      skipped++;
      continue;
    }

    if (existed) {
      await unlink(target).catch((err) => {
        if (err.code !== "ENOENT") throw err;
      });
    }

    let linked = false;
    if (wantSymlink) {
      linked = (await atomicSymlinkInstall(file, target)) === "linked";
    }
    if (!linked) {
      await copyFile(file, target);
      copied++;
    } else if (existed) {
      updated++;
    } else {
      installed++;
    }
  }

  return { installed, updated, skipped, copied, total: PIPELINE_SCRIPTS.size };
}

// Windows -> WSL UNC probing in detectCrossEnvInstall() below hits a real
// blocking syscall per distro/root: fs.existsSync() on a stopped WSL
// distro's UNC path triggers Windows to synchronously spin up that distro's
// VM before the stat resolves, which can take multiple seconds. Bound both
// how many distros get probed and how long the loop is willing to keep
// probing before giving up (forge#1917).
const CROSS_ENV_PROBE_MAX_DISTROS = 5;
const CROSS_ENV_PROBE_BUDGET_MS = 3000;

/**
 * Detect whether this repo is also installed from the "other" environment —
 * WSL vs native Windows — for the SAME physical repo (forge#1893).
 *
 * ForgeDock installs are always global (`~/.claude` — see #1589's split-brain
 * finding: there is no per-repo install state), so there is no per-repo
 * install record to compare directly. Instead: when the repo itself is
 * reachable from both sides, the *other* environment's home directory is
 * directly derivable, and its `.claude/forgedock` manifest dir (written by
 * `forge()` below) tells us whether ForgeDock has ever run there.
 *
 * Two directions:
 *   - WSL → Windows: well-defined. If `ctx.cwd` is under
 *     `/mnt/<drive>/Users/<user>/...`, that's a live bind mount onto the
 *     Windows drive — the Windows home for that same user is
 *     `/mnt/<drive>/Users/<user>`, directly checkable through the mount, no
 *     cross-OS trickery needed.
 *   - Windows → WSL: best-effort. If `ctx.cwd` is under
 *     `<drive>:\Users\<user>\...`, enumerate installed WSL distros
 *     (`wsl -l -q`) and probe each one's
 *     `\\wsl.localhost\<distro>\home\<user>\.claude\forgedock` (falling back
 *     to the older `\\wsl$\<distro>\...` UNC root), guessing the Linux
 *     username equals the Windows username. A wrong guess only produces a
 *     false NEGATIVE (silently skips a real conflict) — never a false
 *     positive, matching this feature's "no false positives" requirement.
 *
 * Never throws — any failure (WSL not installed, `wsl -l -q` unavailable,
 * an inaccessible/slow UNC path, or a `cwd` that doesn't match either shape)
 * degrades to "no conflict". The Windows -> WSL probe loop is additionally
 * bounded by `CROSS_ENV_PROBE_MAX_DISTROS` and `CROSS_ENV_PROBE_BUDGET_MS` —
 * exceeding either bound also degrades to "no conflict" rather than
 * continuing to block (forge#1917).
 *
 * @param {{ cwd: string, exec: (cmd: string, args: string[]) => string }} ctx
 * @param {import('./env-detect.mjs').EnvironmentInfo} envInfo
 * @param {{ existsSyncFn?: (p: string) => boolean, nowFn?: () => number }} [deps] - inject
 *   for tests; `existsSyncFn` defaults to the real `fs.existsSync`, `nowFn` defaults to
 *   `Date.now`.
 * @returns {{ conflict: boolean, otherPath: string | null, direction: "windows" | "wsl" | null }}
 */
export function detectCrossEnvInstall(ctx, envInfo, deps = {}) {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const nowFn = deps.nowFn ?? Date.now;
  const none = { conflict: false, otherPath: null, direction: null };

  try {
    const cwd = String(ctx.cwd ?? "");

    if (envInfo.isWSL) {
      const m = cwd.match(/^(\/mnt\/[a-z])\/Users\/([^/]+)/i);
      if (!m) return none;
      const windowsHomeOnMount = `${m[1]}/Users/${m[2]}`;
      const checkPath = `${windowsHomeOnMount}/.claude/forgedock`;
      if (existsSyncFn(checkPath)) {
        return { conflict: true, otherPath: wslPathToWindows(checkPath) ?? checkPath, direction: "windows" };
      }
      return none;
    }

    if (envInfo.platform === "win32") {
      const m = cwd.match(/^([a-zA-Z]):[\\/]Users[\\/]([^\\/]+)/i);
      if (!m) return none;
      const user = m[2];

      let distros = [];
      try {
        const raw = ctx.exec("wsl", ["-l", "-q"]);
        // `wsl -l -q` prints its distro list as UTF-16LE. `ctx.exec` decodes
        // process output as UTF-8, so ASCII characters come back interleaved
        // with NUL bytes (e.g. "Ubuntu" -> "U\0b\0u\0n\0t\0u\0"). Strip them
        // before splitting into lines.
        distros = raw
          .replace(/\0/g, "")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        return none; // WSL not installed, or `wsl` isn't on PATH — no conflict possible.
      }

      // Bound worst-case blocking time: cap how many distros get probed, and
      // stop probing once the wall-clock budget is exhausted. Each existsSync
      // call below is a real blocking syscall — a stopped WSL distro auto-
      // starts its VM synchronously to service the UNC stat, which can take
      // multiple seconds. Checking the deadline before every probe (not just
      // once per distro) stops the delay from compounding once the budget
      // is gone; it can't preempt a single already-in-flight call, but it
      // does bound the total across distros/roots (forge#1917).
      const probeDeadline = nowFn() + CROSS_ENV_PROBE_BUDGET_MS;
      for (const distro of distros.slice(0, CROSS_ENV_PROBE_MAX_DISTROS)) {
        if (nowFn() > probeDeadline) break;
        for (const root of [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`]) {
          if (nowFn() > probeDeadline) break;
          const checkPath = `${root}\\home\\${user}\\.claude\\forgedock`;
          try {
            if (existsSyncFn(checkPath)) {
              return { conflict: true, otherPath: checkPath, direction: "wsl" };
            }
          } catch {
            // Inaccessible/unresponsive UNC path — treat as not found, try the next one.
          }
        }
      }
      return none;
    }

    return none;
  } catch {
    return none;
  }
}

/**
 * Final manifest save for forge(): locked re-read → replay this run's
 * `manifestOps` → write. Returns true on success, false on any failure —
 * never throws, because manifest housekeeping must never abort the caller's
 * receipt or the hook installation.
 */
async function saveManifestWithMerge(manifestPath, manifestOps) {
  try {
    // Re-read-and-merge (forge#2614): another concurrent forge() invocation
    // may have saved its own manifest.files adds/deletes since this run's
    // initial load above. Re-reading the on-disk manifest right before this
    // run's own save and replaying only this run's own ops (manifestOps)
    // onto that fresh copy — rather than blindly overwriting with the
    // run-start in-memory snapshot — means this run's save can no longer
    // silently drop the other run's changes. loadCopiedManifest() never
    // throws (missing/corrupt on-disk manifest resolves to an empty one),
    // so this stays within the surrounding never-abort contract.
    //
    // Lock the re-read→merge→write sequence itself (forge#2637): #2614
    // narrowed the race from "whole run duration" to this critical section,
    // but left it unprotected — a third concurrent forge() could still land
    // its own save inside the gap between this run's re-read and its own
    // write-rename completing. acquireManifestLock() is best-effort: on
    // failure to acquire (contention exhausted retries, or an unexpected
    // error) it returns null and this run proceeds unlocked, same as
    // before — the lock narrows the window further, it does not change the
    // never-abort contract.
    const lockHandle = await acquireManifestLock(manifestPath);
    try {
      const mergedManifest = await loadCopiedManifest(manifestPath);
      for (const { rel, op } of manifestOps) {
        if (op === "add") {
          mergedManifest.files[rel] = true;
        } else {
          delete mergedManifest.files[rel];
        }
      }
      await saveCopiedManifest(manifestPath, mergedManifest);
    } finally {
      await releaseManifestLock(manifestPath, lockHandle);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-file branch for forge(): a manifest-tracked regular file — a copy we
 * made on a previous run, ours to manage. First try upgrading it to a
 * symlink (Developer Mode enabled since), preserving atomicSymlinkInstall()'s
 * tri-state "linked"/"unreadable"/"denied" contract (forge#2620 / ADR #2667)
 * exactly; on "denied", fall through to content-compare + copy.
 * Returns counter deltas for forge() to fold in.
 */
async function upgradeManagedCopy(file, target, rel, { wantSymlink, recordDelete }) {
  let upgraded = false;
  let restoredAsCopy = false;
  if (wantSymlink) {
    const result = await atomicSymlinkInstall(file, target);
    if (result === "linked") {
      upgraded = true;
      recordDelete(rel);
    } else if (result === "unreadable") {
      // Symlink was created but is not readable back (forge#2620) —
      // the helper already removed the dead link. Restore a real copy
      // so the command stays readable. Keep the manifest entry (still
      // copy-managed, not symlink-managed) and do NOT fall through to
      // the generic copy-comparison below — the copy is already done.
      await copyFile(file, target);
      restoredAsCopy = true;
    }
    // "denied" — no symlink installed; fall through to content-compare.
  }
  if (upgraded || restoredAsCopy) {
    return { updatedDelta: 1, skippedDelta: 0 };
  }
  const [src, dst] = await Promise.all([readFile(file), readFile(target)]);
  if (src.equals(dst)) {
    return { updatedDelta: 0, skippedDelta: 1 };
  }
  await copyFile(file, target);
  return { updatedDelta: 1, skippedDelta: 0 };
}

/**
 * Per-file branch for forge(): a regular file not in the manifest — a copy
 * from a pre-manifest ForgeDock version, or a stale copy that was never
 * adopted. `rel` here is always enumerated from `files` (ForgeDock's own
 * commandsDir listing) — every path this branch touches is a
 * ForgeDock-managed command file, never an arbitrary user file, so there is
 * no "user-customized" case to protect. Content-compare: if it matches
 * source, adopt it into the manifest silently (it was ours all along). If it
 * differs, it's stale — overwrite it and adopt it into the manifest too,
 * mirroring the manifest-tracked branch, so future runs take the
 * manifest-aware fast path.
 *
 * Never throws. Returns an effects object forge() folds into its counters:
 * `handled: false` means every repair attempt failed and forge() should
 * print the per-file WARNING (terminal/progress-bar state stays in forge()).
 * `backedUpDelta` is mutated in place as backup/rollback progresses so a
 * mid-sequence failure still reports any backup that remains on disk
 * (forge#2559).
 */
async function adoptOrRepairUnmanagedCopy(file, target, rel, { recordCopy }) {
  const effects = { handled: false, updatedDelta: 0, skippedDelta: 0, backedUpDelta: 0 };
  try {
    const [src, dst] = await Promise.all([readFile(file), readFile(target)]);
    if (src.equals(dst)) {
      recordCopy(rel);
      effects.skippedDelta++;
      effects.handled = true;
    } else {
      // Write to a .tmp sibling and atomically rename onto target — never
      // open target itself for a direct overwrite. copyFile() is not
      // atomic: a mid-write failure (AV lock / ENOSPC / process kill)
      // would otherwise leave target truncated/corrupted rather than
      // simply stale, which the WARNING in forge() cannot distinguish. This
      // mirrors the .tmp+rename swap already used for symlink installs
      // (lines ~1573-1579, ~1601-1607).
      //
      // Unlike those symlink-based branches — where symlink() is itself
      // exclusive-create and therefore naturally races out a concurrent
      // writer — copyFile() has no such semantics: two concurrent
      // forge() invocations (e.g. an overlapping `doctor --fix` run, or
      // a file watcher) targeting the same file would both write
      // through the same shared `target + ".tmp"` path and could
      // interleave or clobber each other before either rename() runs.
      // Suffix the tmp sibling with this process's PID so concurrent
      // invocations never share a path (forge#2542).
      const tmpTarget = target + "." + process.pid + ".tmp";
      try {
        await copyFile(file, tmpTarget);
      } catch (copyErr) {
        // A copyFile failure (disk full mid-copy, AV lock, permission
        // error) can still leave a partially-written .tmp sibling on
        // disk even though the write itself threw. The sibling
        // rename() failure just below already cleans up tmpTarget
        // on its own failure path (renameErr) — mirror that here so a
        // copyFile failure doesn't orphan the .tmp file instead
        // (forge#2540). Best-effort: never let the cleanup itself mask
        // or replace the original copyErr being rethrown.
        await unlink(tmpTarget).catch(() => {});
        throw copyErr;
      }
      // Preserve the pre-existing content before it's replaced, mirroring
      // half of the confirm+backup convention used by the forge.yaml
      // overwrite path (bin/forgedock.mjs ~990-1021 / journey.mjs
      // review(), both via backupExisting()). A confirmation prompt is
      // deliberately NOT added: this branch also runs non-interactively
      // inside `doctor --fix`'s automated repair (bin/forgedock.mjs
      // runInstallRepairOnce() -> forge(ctx())), so pausing per-file for
      // input would break that flow. Placed here — after the .tmp write
      // has already succeeded, before the final rename — rather than
      // before copyFile (as the forge.yaml path does), so a copyFile
      // failure never backs up (and thereby displaces) a target that's
      // about to remain untouched (see the .tmp-write-failure test,
      // forge#2498). backupExisting()'s rename is itself atomic, so this
      // ordering carries none of the non-atomic-write risk that forge#1396
      // flagged for the old backup-then-writeFileSync forge.yaml path.
      //
      // Note: backupExisting() below is a *synchronous* rename
      // (target -> target+".bak"); the tmpTarget -> target rename just
      // after it is a separate, async filesystem operation. Between
      // the two, target genuinely does not exist on disk for a
      // sub-millisecond window. Only a hard process kill (not any
      // catchable JS error) can land exactly there — any catchable
      // failure of the second rename is already handled by the
      // rollback block below — and recovery in that rare case is via
      // the surviving target+".bak" on the next forge() run (forge#2558).
      const backup = backupExisting(target);
      if (backup) effects.backedUpDelta++;
      try {
        await rename(tmpTarget, target);
      } catch (renameErr) {
        await unlink(tmpTarget).catch(() => {});
        if (backup) {
          // The final rename failed AFTER backupExisting() already moved
          // the original file to target+".bak" — target no longer exists
          // on disk at this point. Without this rollback the user's file
          // would simply vanish (present only as .bak) while the WARNING
          // in forge() implies it merely "could not be repaired". Restore
          // the prior content so a failed repair is a no-op, matching the
          // pre-backup invariant that a rename failure never removes the
          // existing file (see the .tmp-write-failure test, forge#2498).
          // WIRE:PROVEN — manual: reasoned, not exercised by an automated
          // test. This branch requires rename(tmp, target) to fail on the
          // exact call immediately after backupExisting()'s own rename of
          // the same target succeeded — an OS-level race with no portable
          // way to force deterministically (the sibling renameErr catches
          // for the symlink-relink paths above, lines ~1576/~1604, are the
          // same kind of defensive OS-failure branch and are likewise
          // untested for the same reason). Verified by code inspection:
          // rename() is fs/promises' rename. The rollback rename's own
          // outcome is captured explicitly rather than assumed — if it
          // also fails (e.g. .bak itself is locked), target+".bak" is
          // left in place as the only remaining copy of the prior
          // content, so backedUpDelta must NOT be decremented in that
          // case; it correctly reflects "a backup file still exists on
          // disk" (forge#2559). Only on confirmed rollback success does
          // the decrement keep the counter consistent with the restored
          // on-disk state before renameErr is rethrown to the outer catch.
          let rollbackOk = true;
          await rename(target + ".bak", target).catch(() => { rollbackOk = false; });
          if (rollbackOk) effects.backedUpDelta--;
        }
        throw renameErr;
      }
      recordCopy(rel);
      effects.updatedDelta++;
      effects.handled = true;
    }
  } catch { /* readFile/copyFile/rename failure — fall through to warning */ }
  return effects;
}

/**
 * Per-file branch for forge(): target does not exist yet (ENOENT from
 * lstat) — fresh install. Symlink-first, copy-fallback; a successful link
 * also drops any stale manifest record for the path.
 * Returns counter deltas for forge() to fold in.
 */
async function installFreshCommandFile(file, target, rel, { wantSymlink, manifest, recordCopy, recordDelete }) {
  let linked = false;
  if (wantSymlink) {
    linked = (await atomicSymlinkInstall(file, target)) === "linked";
    if (linked && manifest.files[rel]) {
      // Symlinks work now and the old copy is gone — drop the stale record.
      recordDelete(rel);
    }
  }
  if (!linked) {
    // Windows without Developer Mode/admin, or symlink unreadable — copy.
    await copyFile(file, target);
    recordCopy(rel);
    return { installedDelta: 0, copiedDelta: 1 };
  }
  return { installedDelta: 1, copiedDelta: 0 };
}

/**
 * Act II receipt: render forge()'s summary lines, advisories, and hook
 * statuses. Pure reporting — mechanical move of the forge() tail; reads
 * `results` and writes to ctx.stdout, mutates nothing.
 */
function renderForgeReceipt(ctx, results) {
  const { stdout: w } = ctx;
  const {
    installed, updated, skipped, copied, backedUp, pruned, total,
    staleExtensionlessPruned, scriptsResult, manifestSaveFailed,
    hookStatus, settingsPath, preToolUseStatus, subagentStopEnforceStatus,
  } = results;

  const glyph = (ok) => (ctx.mode === "none" ? (ok ? "✔" : "!") : `\x1b[38;2;255;179;71m${ok ? "✔" : "!"}\x1b[0m`);
  const headlineVerb = copied > 0 ? "installed" : "linked";
  const backupNote = backedUp > 0 ? `, ${backedUp} backed up` : "";
  const headlineDetail = copied > 0
    ? `(new ${installed}, copied ${copied}, updated ${updated}${backupNote}, unchanged ${skipped})`
    : `(new ${installed}, updated ${updated}${backupNote}, unchanged ${skipped})`;
  w.write(`  ${glyph(true)} ${total} slash commands ${headlineVerb} ${dimLine(ctx, headlineDetail)}\n`);
  if (pruned > 0) {
    w.write(`  ${glyph(true)} ${pruned} orphaned symlink${pruned === 1 ? "" : "s"} removed ${dimLine(ctx, "(commands deleted or renamed since last install)")}\n`);
  }
  if (staleExtensionlessPruned > 0) {
    w.write(`  ${glyph(true)} ${staleExtensionlessPruned} stale extensionless entr${staleExtensionlessPruned === 1 ? "y" : "ies"} removed ${dimLine(ctx, "(leftover from prior npx forgedock runs)")}\n`);
  }
  if (copied > 0) {
    w.write(`  ${glyph(false)} ${copied} copied (not linked) ${dimLine(ctx, "— enable Windows Developer Mode for live-updating links")}\n`);
  }
  if (scriptsResult.total > 0) {
    const scriptsChanged = scriptsResult.installed + scriptsResult.updated + scriptsResult.copied;
    const scriptsDetail = scriptsChanged > 0
      ? `(new ${scriptsResult.installed}, updated ${scriptsResult.updated}, copied ${scriptsResult.copied}, unchanged ${scriptsResult.skipped})`
      : `(unchanged ${scriptsResult.skipped})`;
    w.write(`  ${glyph(true)} ${scriptsResult.total} pipeline scripts linked into ~/.claude/scripts ${dimLine(ctx, scriptsDetail)}\n`);
  }
  if (manifestSaveFailed) {
    w.write("  " + dimLine(ctx, "manifest not saved — re-runs may warn about copied files") + "\n");
  }
  if (hookStatus === "skipped-malformed") {
    w.write(`  ${glyph(false)} SessionStart hook NOT registered — ${settingsPath} is not valid JSON\n`);
    w.write(fixCard([`Fix the JSON in ${settingsPath}, then re-run: npx forgedock install`], ctx.mode) + "\n");
  } else {
    w.write(`  ${glyph(true)} SessionStart hook ${hookStatus === "already" ? "active" : "registered"} ${dimLine(ctx, settingsPath)}\n`);
  }

  // Persisted-home / ephemeral-cache advisory (forge#1895, extended #1943):
  // runJourney() calls persistHome(ctx) right before forge() and stashes its
  // result on ctx.persistHomeResult; when persistHome() actually ran (i.e.
  // wasn't skipped), ctx.forgeHome above has ALREADY been reassigned to the
  // stable ~/.forge/ copy, so report that outcome instead of the raw
  // ephemeral-cache warning. Direct forge() callers that never set
  // ctx.persistHomeResult (e.g. relinkAndHint() in bin/forgedock.mjs) fall
  // through to the original ephemeral-cache-only check unchanged.
  const persistResult = ctx.persistHomeResult;
  if (persistResult && !persistResult.skipped) {
    if (persistResult.migrated) {
      w.write(`  ${glyph(true)} toolset migrated to persisted home ${dimLine(ctx, persistResult.forgeHome)}\n`);
    } else {
      w.write(`  ${glyph(true)} persisted home already current ${dimLine(ctx, `v${persistResult.version || "unknown"} at ${persistResult.forgeHome}`)}\n`);
    }
  } else if (persistResult && persistResult.skipped && !isEphemeralCachePath(ctx.forgeHome)) {
    // Skipped for a reason OTHER than "still ephemeral" — today that's always
    // the git-working-tree exemption (Acceptance Criteria #5). Informational,
    // not a warning: this is the expected, correct state for a git-clone install.
    w.write(`  ${dimLine(ctx, `persisted home skipped — ${persistResult.reason || "not applicable"}`)}\n`);
  } else if (hookStatus !== "skipped-malformed" && isEphemeralCachePath(ctx.forgeHome)) {
    // Either persistHome() was never run (no ctx.persistHomeResult), or it
    // ran but failed and left ctx.forgeHome pointing at the original
    // ephemeral source (fail-open — see persistHome()'s error branch).
    w.write(`  ${glyph(false)} FORGE_HOME resolves inside an ephemeral cache directory ${dimLine(ctx, ctx.forgeHome)}\n`);
    w.write(fixCard([
      "This path (npx/pnpm dlx/yarn dlx cache) can be pruned by npm/npx/pnpm/yarn",
      "or OS temp cleanup. If that happens, the SessionStart hook silently stops",
      "injecting ForgeDock context — no error is shown.",
      "Mitigation: npm install -g forgedock  (or re-run npx forgedock periodically).",
    ], ctx.mode, "warning") + "\n");
  }

  // Cross-environment install advisory (forge#1893): warn when this repo is
  // reachable from both WSL and native Windows and BOTH sides already have a
  // ForgeDock install. Each environment's install is fully independent (see
  // #1589 — installs are always global, never per-repo), so running from
  // both silently leaves forge.yaml/hook paths pointing at whichever side ran
  // most recently, clobbering the other's config with no error surfaced.
  // Advisory only — never fails the install.
  const envInfo = detectEnvironment({ platform: ctx.platform, env: ctx.env, release: ctx.release });
  const crossEnv = detectCrossEnvInstall(ctx, envInfo);
  if (crossEnv.conflict) {
    const otherLabel = crossEnv.direction === "windows" ? "a native Windows" : "a WSL";
    w.write(`  ${glyph(false)} ${otherLabel} ForgeDock install detected for this repo ${dimLine(ctx, crossEnv.otherPath)}\n`);
    w.write(fixCard([
      `This repo is reachable from both WSL and native Windows, and ${otherLabel}`,
      "install already exists. Each side's install is independent — running",
      "forgedock from both can leave forge.yaml and hook paths pointing at",
      "whichever environment ran last, silently overwriting the other's config.",
      "Mitigation: pick one environment for this repo, or sync forge.yaml manually.",
    ], ctx.mode, "warning") + "\n");
  }

  // Report enforcement hook status.
  if (preToolUseStatus !== null) {
    w.write(`  ${glyph(true)} PreToolUse enforcement hook ${preToolUseStatus === "already" ? "active" : "registered"} ${dimLine(ctx, "(branch/label enforcement)")}\n`);
  } else {
    w.write("  " + dimLine(ctx, "PreToolUse hook skipped — requires Claude Code v2.1.163+") + "\n");
  }
  // "skipped-malformed" and "absent" are intentionally silent here:
  // - skipped-malformed: installSessionStartHook() above reads the same
  //   settingsPath and already prints the malformed-JSON fix-card, so a
  //   second message would just repeat the same signal.
  // - absent: the expected steady state (nothing to remove) — this
  //   function only reports state *changes*, not no-ops.
  if (subagentStopEnforceStatus === "removed") {
    w.write(`  ${glyph(true)} SubagentStop enforcement hook removed ${dimLine(ctx, "(non-functional — see forge#1527)")}\n`);
  }
}

/**
 * Act II: link commands into ~/.claude/commands with a molten progress line,
 * then register the SessionStart hook.
 * Symlink semantics preserved verbatim from the original install():
 * regular files are skipped with a warning; changed links updated atomically.
 * On Windows without Developer Mode (symlink → EPERM/EACCES) each command is
 * copied instead, and recorded in a manifest so re-runs can tell ForgeDock's
 * own copies apart from user-owned files. ctx.linkStrategy ("symlink" default)
 * can be set to "copy" to skip all symlink attempts (deterministic tests).
 */
export async function forge(ctx) {
  const { stdout: w } = ctx;
  const commandsDir = join(ctx.forgeHome, "commands");
  const targetDir = join(ctx.home, ".claude", "commands");
  const manifestPath = join(ctx.home, ".claude", "forgedock", "copied-commands.json");
  const wantSymlink = ctx.linkStrategy !== "copy";

  w.write("\n  " + ember("Forging commands", ctx.mode) + " " + dimLine(ctx, `into ${targetDir}`) + "\n\n");
  await mkdir(targetDir, { recursive: true });

  // Clear stale extensionless entries from prior `npx forgedock` runs before
  // the install loop below can collide with them (forge#2620).
  const staleExtensionlessPruned = await pruneStaleExtensionlessEntries(targetDir);

  const manifest = await loadCopiedManifest(manifestPath);
  // Reclaim crash-orphaned pid-suffixed tmp siblings left by prior hard-killed
  // runs (forge#2612). Best-effort — must never abort the forge receipt/hook.
  await sweepStaleManifestTmps(manifestPath).catch(() => {});
  let manifestChanged = false;
  // This run's own manifest mutations, tracked as a replayable diff
  // (forge#2614). #2599/#2609 fixed the tmp-file *write-path* race (two
  // concurrent forge() runs no longer collide on the same tmp filename) but
  // left the manifest's logical *content* racy: each run loads the manifest
  // into memory once, mutates its own copy across the whole run, then writes
  // the entire in-memory object back at the end — a classic last-writer-wins
  // race on manifest.files. Recording this run's own adds/deletes here (instead
  // of relying on the run-start in-memory snapshot) lets the final save re-read
  // the on-disk manifest and replay only these ops onto it, so a concurrent
  // run's own adds/deletes made after this run's initial load are preserved
  // rather than silently overwritten.
  const manifestOps = [];

  const files = await findMarkdownFiles(commandsDir, { includeExtras: !!ctx.includeExtras });
  let installed = 0, updated = 0, skipped = 0, copied = 0, backedUp = 0;
  const barWidth = 24;
  let barShown = false;

  const recordCopy = (rel) => {
    if (!manifest.files[rel]) {
      manifest.files[rel] = true;
      manifestChanged = true;
    }
    manifestOps.push({ rel, op: "add" });
  };
  // Mirror of recordCopy for removals — keeps manifest.files, manifestChanged,
  // and the replayable manifestOps diff (forge#2614) mutating as one unit so
  // the in-memory manifest and the final merge-save replay never diverge.
  const recordDelete = (rel) => {
    delete manifest.files[rel];
    manifestChanged = true;
    manifestOps.push({ rel, op: "delete" });
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = relative(commandsDir, file);
    const target = join(targetDir, rel);
    await mkdir(pathDirname(target), { recursive: true });

    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          skipped++;
        } else {
          let relinked = false;
          if (wantSymlink) {
            relinked = (await atomicSymlinkInstall(file, target)) === "linked";
            if (relinked) updated++;
          }
          if (!relinked) {
            // Can't (or shouldn't) re-link — replace the managed link with a copy.
            // unlink first: copyFile onto a symlink writes THROUGH the link.
            // (target may already be gone here if atomicSymlinkInstall()
            // returned "unreadable" and its own cleanup already removed it —
            // tolerate ENOENT.)
            await unlink(target).catch((err) => {
              if (err.code !== "ENOENT") throw err;
            });
            await copyFile(file, target);
            updated++; // replaces an existing managed entry
            recordCopy(rel);
          }
        }
      } else if (manifest.files[rel]) {
        const eff = await upgradeManagedCopy(file, target, rel, { wantSymlink, recordDelete });
        updated += eff.updatedDelta;
        skipped += eff.skippedDelta;
      } else {
        const eff = await adoptOrRepairUnmanagedCopy(file, target, rel, { recordCopy });
        updated += eff.updatedDelta;
        skipped += eff.skippedDelta;
        backedUp += eff.backedUpDelta;
        if (!eff.handled) {
          // Terminal/progress-bar state stays here — helpers never touch
          // barShown or write to the stream.
          if (barShown) { w.write("\x1b[1A\x1b[2K"); barShown = false; }
          w.write(`  WARNING: ${rel} could not be repaired — remove it manually to let ForgeDock manage it\n`);
          skipped++;
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const eff = await installFreshCommandFile(file, target, rel, { wantSymlink, manifest, recordCopy, recordDelete });
      installed += eff.installedDelta;
      copied += eff.copiedDelta;
    }

    if (ctx.motion) {
      if (barShown) w.write("\x1b[1A\x1b[2K");
      w.write(`  ${moltenBar(i + 1, files.length, { width: barWidth, mode: ctx.mode })}  ${i + 1}/${files.length}  ${dimLine(ctx, "/" + rel.replace(/\.md$/, ""))}\n`);
      barShown = true;
    }
  }
  if (barShown) w.write("\x1b[1A\x1b[2K");

  // Prune orphaned symlinks: links that point into commandsDir but whose
  // target file no longer exists (e.g. after a command is renamed or deleted).
  const pruned = await pruneOrphanedSymlinks(targetDir, commandsDir);

  // Link the small set of universal pipeline-agent scripts (forge#1885).
  const scriptsResult = await linkPipelineScripts(ctx);

  const hookScript = join(ctx.forgeHome, "bin", "hooks", "session-start.mjs");
  const settingsPath = join(ctx.home, ".claude", "settings.json");
  const { status: hookStatus } = installSessionStartHook(settingsPath, hookScript);

  // Install enforcement hooks (#1250): PreToolUse (branch/label validation)
  // and SubagentStop interactive engine adapter. Both are idempotent and
  // always installed (fail-open if settings.json is malformed, same
  // contract as SessionStart hook).
  const preToolUseScript = join(ctx.forgeHome, "bin", "hooks", "pre-tool-use.mjs");
  const subagentStopScript = join(ctx.forgeHome, "bin", "hooks", "interactive-engine.mjs");
  const { status: preToolUseStatus } = installPreToolUseHook(settingsPath, preToolUseScript);
  installSubagentStopHook(settingsPath, subagentStopScript);

  // SubagentStop annotation-verifier hook (#1250) is NOT installed: its
  // trigger condition (a `FORGE:PHASE_START` marker in the transcript) is
  // never emitted anywhere in the pipeline, so it always exits 0 with zero
  // enforcement effect while still spawning a process + reading the
  // transcript on every SubagentStop (forge#1527). Actively clean up any
  // prior installation instead of installing it.
  const { status: subagentStopEnforceStatus } = removeSubagentStopEnforceHook(settingsPath);

  // Housekeeping — must never abort the receipt or the hook.
  // saveManifestWithMerge() owns the locked re-read → replay-manifestOps →
  // save sequence (forge#2614/forge#2637) and never throws.
  let manifestSaveFailed = false;
  if (manifestChanged) {
    manifestSaveFailed = !(await saveManifestWithMerge(manifestPath, manifestOps));
  }

  renderForgeReceipt(ctx, {
    installed, updated, skipped, copied, backedUp, pruned, total: files.length,
    staleExtensionlessPruned, scriptsResult, manifestSaveFailed,
    hookStatus, settingsPath, preToolUseStatus, subagentStopEnforceStatus,
  });

  return { installed, updated, skipped, copied, backedUp, pruned, total: files.length, hookStatus, preToolUseStatus, subagentStopEnforceStatus, scriptsResult };
}

// ---------------------------------------------------------------------------
// Act III — Reading your repository (Task 8)
// ---------------------------------------------------------------------------

import { detectConfig } from "./init-detect.mjs";
import { enrich, resolveEnrichBackend } from "./init-enrich.mjs";
import { isClaudeCliAvailable } from "./runner.mjs";
import { annotatedReviewScreen, box, confirm, getLogoTagline } from "./tui.mjs";

const badgeOf = (field) => field.confidence;

/**
 * Act III: detect the repo, show each field as a reveal row with its
 * confidence badge, optionally AI-enrich. Detection runs first (it is fast);
 * rows are display pacing, not fake latency.
 */
export async function read(ctx) {
  const { stdout: w } = ctx;
  w.write("\n  " + ember("Reading your repository", ctx.mode) + "\n\n");

  let draft = await detectConfig(ctx.cwd);
  const description = detectDescription(ctx.cwd);

  const rows = [
    { label: "owner/repo", run: async () => ({ ok: true, detail: `${draft.project.owner.value}/${draft.project.repo.value}`, badge: badgeOf(draft.project.owner) }) },
    { label: "default branch", run: async () => ({ ok: true, detail: draft.branches.default.value, badge: badgeOf(draft.branches.default) }) },
    { label: "staging branch", run: async () => ({ ok: true, detail: draft.branches.staging.value, badge: badgeOf(draft.branches.staging) }) },
    { label: "project name", run: async () => ({ ok: true, detail: draft.project.name.value, badge: badgeOf(draft.project.name) }) },
    {
      label: "description",
      run: async () => description.value
        ? { ok: true, detail: `"${description.value.slice(0, 40)}${description.value.length > 40 ? "…" : ""}"`, badge: "medium" }
        : { ok: true, detail: "none found", badge: "low" },
    },
  ];
  await revealRows(rows, { mode: ctx.mode, motion: ctx.motion, writer: w });

  const enrichBackend = resolveEnrichBackend({
    cwd: ctx.cwd,
    env: ctx.env,
    isCliAvailableFn: ctx.isCliAvailableFn,
  });

  if (enrichBackend !== "none") {
    try {
      w.write("  " + dimLine(ctx, "✦ enriching with AI…") + "\n");
      const enriched = await ctx.enrichFn(draft, { backend: enrichBackend, cwd: ctx.cwd, env: ctx.env });
      if (enriched && typeof enriched === "object") draft = enriched;
    } catch {
      w.write("  " + dimLine(ctx, "✦ AI enrichment unavailable — continuing with detection only") + "\n");
    }
  } else {
    w.write("  " + dimLine(ctx, "✦ no Claude Code CLI or ANTHROPIC_API_KEY — skipping AI enrichment") + "\n");
  }

  return { draft, description };
}

// ---------------------------------------------------------------------------
// Act IV — The Review (Task 8)
// ---------------------------------------------------------------------------

/**
 * Act IV: the single interaction. Non-TTY + existing config aborts to protect
 * the file; non-TTY + fresh config writes detection values with TODO flags
 * (annotatedReviewScreen's non-TTY path returns them directly).
 *
 * Overwrite protection (forge#1850, regression of #578): a TTY session with
 * an existing forge.yaml must give EXPLICIT default-No consent before any
 * backup or write happens — the review screen's own "Overwrite Mode" banner
 * is advisory, not consent. This restores the #578 gate via ctx.confirmFn
 * (defaults to tui.mjs's confirm(), which is non-TTY-safe on its own —
 * belt-and-suspenders with the explicit isTTY check above it).
 */
export async function review(ctx, draft, description) {
  const { stdout: w } = ctx;
  const outputPath = join(ctx.cwd, "forge.yaml");
  const hasExisting = existsSync(outputPath);

  if (hasExisting && process.stdin.isTTY !== true) {
    w.write("\n  forge.yaml already exists — non-interactive run, aborting to protect it.\n");
    w.write("  " + dimLine(ctx, "Run interactively (or delete forge.yaml) to regenerate.") + "\n");
    return { written: false, todoCount: 0, backupName: null, aborted: true };
  }

  if (hasExisting) {
    const confirmed = await ctx.confirmFn(
      "forge.yaml already exists. Overwrite it? A backup will be created.",
      false,
    );
    if (!confirmed) {
      w.write("\n  Overwrite cancelled — forge.yaml left untouched.\n");
      return { written: false, todoCount: 0, backupName: null, aborted: true };
    }
  }

  const extraFields = description.value
    ? { description: { value: description.value, confidence: "medium", source: description.source, why: `First paragraph of ${description.source}` } }
    : {};

  const accepted = await annotatedReviewScreen(draft, {
    hasExistingConfig: hasExisting,
    showSources: ctx.argv.includes("--verbose"),
    extraFields,
  });

  // Hard-fail on unresolved identity placeholders when OVERWRITING an
  // existing config (forge#1850 spec item 4): never destroy a working
  // forge.yaml in favor of one that can't address a repo. A brand-new
  // (non-existing) config is allowed to write placeholders — that's the
  // existing, already-flagged (# TODO comments) greenfield-setup path, and
  // there's nothing valuable to lose. Checked AFTER the review screen so an
  // interactive edit that fixes the field still passes.
  if (hasExisting && (accepted.owner === "your-github-org" || accepted.repo === "your-repo-name")) {
    w.write("\n  Could not determine the GitHub owner/repo for this project.\n");
    w.write("  " + dimLine(ctx, "Run this inside the target git repository, or edit those fields before accepting.") + "\n");
    return { written: false, todoCount: 0, backupName: null, aborted: true };
  }

  const backup = backupExisting(outputPath);
  if (backup) w.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);

  const { todoCount } = writeForgeYaml(accepted, accepted.lowConfidenceKeys, outputPath);
  return { written: true, todoCount, backupName: backup ? backup.backupName : null, aborted: false };
}

// ---------------------------------------------------------------------------
// Act V — Forged (Task 8)
// ---------------------------------------------------------------------------

/**
 * Act V: quench flash on the compact mark, receipt with real elapsed time,
 * next-steps box.
 */
export function celebrate(ctx, summary) {
  const { stdout: w } = ctx;
  const elapsed = Math.round((Date.now() - ctx.startedAt) / 1000);
  const mark = renderMark("compact", ctx.mode);

  w.write("\n");
  w.write(mark[0] + "\n");
  w.write(mark[1] + "   " + ember("Forged.", ctx.mode) + " " + dimLine(ctx, `install → config in ${elapsed}s`) + "\n");
  w.write(mark[2] + "\n");
  w.write(mark[3] + "\n\n");

  const glyph = ctx.mode === "none" ? "✔" : "\x1b[38;2;255;179;71m✔\x1b[0m";
  if (summary.written) {
    const todoNote = summary.todoCount > 0 ? `${summary.todoCount} field${summary.todoCount === 1 ? "" : "s"} flagged # TODO` : "all fields detected";
    w.write(`  ${glyph} forge.yaml written          ${dimLine(ctx, todoNote)}\n`);
  }
  if (summary.total !== undefined) {
    const hookNote = summary.hookStatus === "skipped-malformed" ? "hook NOT active — see fix above" : "Claude Code knows this repo";
    w.write(`  ${glyph} ${summary.total} commands · hook ${summary.hookStatus === "skipped-malformed" ? "skipped" : "active"}   ${dimLine(ctx, hookNote)}\n`);
  }
  if (summary.scriptsResult && summary.scriptsResult.total > 0) {
    w.write(`  ${glyph} ${summary.scriptsResult.total} pipeline scripts   ${dimLine(ctx, "~/.claude/scripts — classify-lane, transition-label, validate-pr-target")}\n`);
  }
  w.write("\n");
  if (summary.isMinimal) {
    w.write("  " + dimLine(ctx, "see docs/CONFIG.md for optional sections") + "\n");
  }
  w.write(
    box(
      [
        `  1. install GitHub App       — github.com/apps/rapiercraft-forgedock`,
        `  2. run npx forgedock labels setup — bootstrap GitHub labels`,
        `  3. run npx forgedock doctor     — verify the install is green`,
        `  4. open claude in this repo`,
        `  5. run /issue <title> then /work-on <number>`,
        `  6. run npx forgedock run-issue <N> — drive an issue via the durable engine`,
        `  7. run npx forgedock watch      — monitor pipeline state`,
      ],
      { title: "what's next" },
    ),
  );
  w.write("  " + dimLine(ctx, "not for you? npx forgedock uninstall removes everything · full command list: npx forgedock help") + "\n");
  w.write("  " + dimLine(ctx, "docs: github.com/RapierCraftStudios/ForgeDock · ⭐ a star is the whole marketing budget") + "\n\n");
}

// ---------------------------------------------------------------------------
// Act V.5 — Connect: GitHub App install prompt (Issue #1719)
// ---------------------------------------------------------------------------

const GITHUB_APP_URL = "https://github.com/apps/rapiercraft-forgedock/installations/new";

/**
 * Act V.5: prompt the user to install the ForgeDock GitHub App on their
 * account. Non-blocking — declining or non-interactive mode both continue
 * the journey without error.
 *
 * Uses ctx.openFn (injectable for tests) to open the URL in the default
 * browser, and ctx.confirmFn (injectable for tests) to ask for consent. In
 * non-TTY environments (piped stdin, --fast) confirm() resolves immediately
 * to false (the defaultValue), so no prompt is shown.
 *
 * IMPORTANT: installing the app today only registers it against the
 * account/org — it does NOT mint a bot token, does NOT auto-refresh
 * anything, and does NOT change which `gh` auth pipeline commands use.
 * Minting an installation token requires the app's private key, which only
 * RapierCraft Studios (the app owner) holds — an end user's installation
 * cannot self-serve a token without a hosted minting backend, which does
 * not exist yet (forge#1890). Keep this prompt's copy honest about that
 * until such a backend ships — see docs/CONFIG.md "GitHub App Install".
 *
 * @returns {Promise<{ opened: boolean }>}
 */
export async function connect(ctx) {
  const { stdout: w } = ctx;
  w.write("\n  " + ember("Connect to GitHub", ctx.mode) + "\n\n");

  const yes = await ctx.confirmFn(
    "Install the ForgeDock GitHub App on this account/org?",
    false,
  );

  if (yes) {
    ctx.openFn(GITHUB_APP_URL);
    w.write(
      `  \x1b[38;2;255;179;71m✔\x1b[0m Opening ${GITHUB_APP_URL}\n` +
      `  ${ctx.mode === "none" ? "" : "\x1b[2m"}This registers the app only — it does not create a bot token yet.\x1b[22m\n` +
      `  ${ctx.mode === "none" ? "" : "\x1b[2m"}Pipeline commands keep using your personal \`gh\` auth. See docs/CONFIG.md.\x1b[22m\n`,
    );
    return { opened: true };
  }

  w.write(`  ${ctx.mode === "none" ? "" : "\x1b[2m"}Skipped — install anytime: ${GITHUB_APP_URL}\x1b[22m\n`);
  return { opened: false };
}

// ---------------------------------------------------------------------------
// Install Receipt (Issue #1946) — machine-readable record of what an
// install/update actually did, so drift debugging can read a receipt instead
// of re-deriving state from scratch.
// ---------------------------------------------------------------------------

/**
 * Read the installed forgedock package version from {forgeHome}/package.json.
 * Best-effort — returns "" on any read/parse failure. Duplicated (rather than
 * imported) from bin/forgedock.mjs's getVersion() to avoid a circular import:
 * forgedock.mjs already imports from journey.mjs.
 * @param {string} forgeHome
 * @returns {string}
 */
function readForgedockVersion(forgeHome) {
  try {
    const pkg = JSON.parse(readFileSync(join(forgeHome, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

/**
 * Write a machine-readable install-receipt.json to {ctx.home}/.forge/ after a
 * successful install (runJourney) or update (bin/forgedock.mjs's
 * relinkAndHint — shared by both update() branches: the git-clone
 * fast-forward path and the npm version-check path). Note: re-running
 * `npx forgedock install` on an already-managed-active repo takes the
 * statusScreen() short-circuit instead of runJourney()/relinkAndHint() — that
 * path does not refresh the receipt (it also does not touch forge() or
 * anything else, so this is consistent with the rest of that short-circuit's
 * no-op behavior, not a gap specific to this feature). See docs/CONFIG.md
 * "Install Receipt" for the schema.
 *
 * Deliberately narrow field set — no PII/secrets: no process.env values, no
 * GitHub tokens, no forge.yaml file contents (only a presence/shape boolean
 * from validateForgeYamlShape()). Absolute paths (forgeHome/cwd) ARE included
 * for drift debugging; they are not secrets, matching existing precedent
 * (ctx.cwd/ctx.home already appear in on-disk state such as registry.json's
 * path-keyed entries).
 *
 * Never throws: any failure (permission denied, disk full, malformed
 * forgeHome) degrades to a silent no-op, matching every other housekeeping
 * step in forge() (manifest save, hook install) — a receipt write must never
 * fail the install/update it merely records.
 *
 * @param {object} ctx - Journey context (forgeHome, home, cwd, platform, env,
 *   release, includeExtras — see makeCtx()).
 * @param {{ forged?: Awaited<ReturnType<typeof forge>> }} summary
 *   `forged` is forge()'s return value (hook statuses, script results). The
 *   caller does not need to pass `reviewed` — forgeYaml status is recomputed
 *   independently via validateForgeYamlShape() so this works identically
 *   whether called from runJourney() (after Act III/IV) or relinkAndHint()
 *   (which never reaches Act III/IV).
 * @returns {Promise<{ written: boolean, path: string }>}
 */
export async function writeInstallReceipt(ctx, summary = {}) {
  // Computed inside the try block (not before it): ctx.home is expected to
  // always be a string in production (makeCtx()/ctx() both default it via
  // env.HOME || env.USERPROFILE || os.homedir()), but this function's own
  // contract is "never throws" — join() on a malformed ctx.home must degrade
  // to written:false, not escape uncaught to the CLI entrypoint.
  let receiptPath = join(os.homedir(), ".forge", "install-receipt.json");
  try {
    receiptPath = join(ctx.home, ".forge", "install-receipt.json");
    const { forged = {} } = summary;
    const envInfo = detectEnvironment({ platform: ctx.platform, env: ctx.env, release: ctx.release });
    const installMode = existsSync(join(ctx.forgeHome, ".git")) ? "git-clone" : "npm";
    const tier = ctx.includeExtras ? "extras" : "core";

    const commandsDir = join(ctx.forgeHome, "commands");
    let commands = [];
    if (existsSync(commandsDir)) {
      try {
        const files = await findMarkdownFiles(commandsDir, { includeExtras: !!ctx.includeExtras });
        commands = files.map((f) => relative(commandsDir, f).replace(/\.md$/, "").replace(/\\/g, "/"));
      } catch {
        commands = [];
      }
    }

    const receipt = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      forgedockVersion: readForgedockVersion(ctx.forgeHome),
      installMode,
      forgeHome: ctx.forgeHome,
      cwd: ctx.cwd,
      platform: {
        platform: envInfo.platform,
        platformLabel: envInfo.platformLabel,
        isWSL: envInfo.isWSL,
        wslDistro: envInfo.wslDistro,
        shell: envInfo.shell,
      },
      tier,
      commands: { count: commands.length, list: commands },
      hooks: {
        sessionStart: forged.hookStatus ?? null,
        preToolUse: forged.preToolUseStatus ?? null,
        subagentStopEnforce: forged.subagentStopEnforceStatus ?? null,
      },
      forgeYaml: validateForgeYamlShape(ctx.cwd),
    };

    await mkdir(join(ctx.home, ".forge"), { recursive: true });
    const tmpPath = receiptPath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(receipt, null, 2) + "\n", "utf-8");
    await rename(tmpPath, receiptPath);
    return { written: true, path: receiptPath };
  } catch {
    // Best-effort only — a receipt write failure must never fail install/update.
    return { written: false, path: receiptPath };
  }
}

// ---------------------------------------------------------------------------
// Act V.6 — Proactive demo offer (Issue #1945)
// ---------------------------------------------------------------------------

/**
 * Act V.6: after a fresh (non-update) install, proactively offer the
 * risk-free interactive demo (`bin/demo.mjs`, issue #1145) instead of leaving
 * it as an undiscoverable opt-in buried in help text.
 *
 * Modeled directly on `connect()` above: `ctx.confirmFn` defaults to
 * `false` and is already non-TTY-safe (see `tui.mjs`'s `confirm()` — a
 * non-interactive stdin resolves immediately to the default, no prompt is
 * shown). No separate `--fast`/non-TTY guard is needed here for the same
 * reason `connect()` doesn't need one.
 *
 * `ctx.runDemoFn` is injectable (defaults to a dynamic `import("./demo.mjs")`
 * wrapper, the same call shape `demo()` in bin/forgedock.mjs already uses) so
 * tests can stub it without spawning real `git clone`/network calls.
 * `runDemo()` reports failure via a returned `{status: "error"}` rather than
 * throwing (see bin/demo.mjs), so both the returned status and a thrown
 * exception are treated as "could not start the demo" here.
 *
 * Never throws past this function: a failed dynamic import, a thrown error,
 * or an error status from `runDemo()` must not turn an otherwise-successful
 * install into a non-zero exit — same best-effort posture as `openUrl()`.
 *
 * Only ever called from genuinely fresh/reconfigure flows (`runJourney()`
 * below, and `initFlow()` in bin/forgedock.mjs) — `npx forgedock update`
 * calls `relinkAndHint()` instead of `celebrate()`/this function, so the
 * repair path is structurally excluded already.
 *
 * @param {{confirmFn: Function, forgeHome: string, cwd: string, stdout: object,
 *          mode: string, runDemoFn?: Function}} ctx
 * @returns {Promise<{ offered: boolean, ranDemo: boolean }>}
 */
export async function maybeOfferDemo(ctx) {
  const { stdout: w } = ctx;
  const dim = (s) => (ctx.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);

  let yes = false;
  try {
    yes = await ctx.confirmFn("Run the interactive demo now?", false);
  } catch {
    return { offered: false, ranDemo: false };
  }

  if (!yes) {
    w.write("  " + dim("Skipped — try it anytime: npx forgedock demo") + "\n");
    return { offered: true, ranDemo: false };
  }

  const runDemoFn = ctx.runDemoFn ?? (async (opts) => {
    const { runDemo } = await import("./demo.mjs");
    return runDemo(opts);
  });

  try {
    const result = await runDemoFn({ forgeHome: ctx.forgeHome, cwd: ctx.cwd });
    if (result && result.status === "error") {
      w.write("  " + dim(`Could not start the demo — try it later: npx forgedock demo (${result.error || "unknown error"})`) + "\n");
      return { offered: true, ranDemo: false };
    }
    return { offered: true, ranDemo: true };
  } catch {
    // Best-effort — a failed demo run must not fail the install itself.
    w.write("  " + dim("Could not start the demo — try it later: npx forgedock demo") + "\n");
    return { offered: true, ranDemo: false };
  }
}

// ---------------------------------------------------------------------------
// The full journey (Task 8)
// ---------------------------------------------------------------------------

/**
 * Acts I→V. Returns the process exit code.
 * SIGINT: restore cursor, summarize partial state, exit 130.
 */
export async function runJourney(ctx) {
  const onSigint = () => {
    ctx.stdout.write("\x1b[0m\x1b[?25h\n  Interrupted. Partial state: commands may be installed; config not written.\n  Finish anytime with: npx forgedock init\n");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    await preflight(ctx);
    // Persist the toolset into ~/.forge/ before linking anything (#1943): when
    // not skipped (git-clone installs are exempt), reassign ctx.forgeHome so
    // every symlink/hook path forge() creates below originates from the
    // stable copy, not the ephemeral npm/npx/git source. Stashed on ctx so
    // forge()'s reporting block can surface the outcome (see isEphemeralCachePath
    // advisory extension above).
    const persistResult = await persistHome(ctx);
    ctx.persistHomeResult = persistResult;
    if (!persistResult.skipped) {
      ctx.forgeHome = persistResult.forgeHome;
    }
    const forged = await forge(ctx);
    const { draft, description } = await read(ctx);
    const reviewed = await review(ctx, draft, description);
    const connected = await connect(ctx);
    celebrate(ctx, { ...reviewed, ...connected, total: forged.total, hookStatus: forged.hookStatus, scriptsResult: forged.scriptsResult });
    await writeInstallReceipt(ctx, { forged });
    if (!reviewed.aborted) await maybeOfferDemo(ctx);
    return reviewed.aborted ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
