/**
 * bin/tests/pre-tool-use.test.mjs
 *
 * Unit tests for the PreToolUse enforcement hook (issues #1250, #1323).
 * Tests PR target validation and fail-open behaviour.
 *
 * Run with: node --test bin/tests/pre-tool-use.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync as writeFileSyncTop } from "node:fs";
import osTop from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_PATH = resolve(__dirname, "..", "hooks", "pre-tool-use.mjs");

/**
 * Create a fresh temp directory that IS a ForgeDock-managed project (has a
 * `forge.yaml`), for project-scope-guard tests. Caller must clean up.
 * @returns {string} absolute path to the managed directory
 */
function makeManagedDir() {
  const dir = mkdtempSync(join(osTop.tmpdir(), "fd-ptu-managed-"));
  writeFileSyncTop(join(dir, "forge.yaml"), "project:\n  owner: test\n  repo: test\n", "utf-8");
  return dir;
}

/**
 * Shared managed directory used as the DEFAULT cwd for all hook subprocess
 * tests below (via runHook()'s default). This repo's checked-out worktree
 * does not itself contain a forge.yaml (it's gitignored), so a synthetic
 * managed directory is required for the existing pre-#1591 test suite to
 * keep exercising enforcement by default — only the explicit "unmanaged
 * directory" test below overrides `cwd` to a directory with no forge.yaml.
 */
const DEFAULT_MANAGED_DIR = makeManagedDir();
process.on("exit", () => {
  try { rmSync(DEFAULT_MANAGED_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Re-implement the pure logic from the hook for unit testing without spawning.
// ---------------------------------------------------------------------------

const FORBIDDEN_PR_BASES = ["main", "master"];

function extractFlag(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const eqRe = new RegExp(`${escaped}=([^\\s"']+|"[^"]*"|'[^']*')`);
  const eqM = command.match(eqRe);
  if (eqM) return eqM[1].replace(/^["']|["']$/g, "");
  const spaceRe = new RegExp(`${escaped}\\s+([^-\\s"'][^\\s"']*|"[^"]*"|'[^']*')`);
  const spaceM = command.match(spaceRe);
  if (spaceM) return spaceM[1].replace(/^["']|["']$/g, "");
  return null;
}

function checkPrTarget(command) {
  if (!/gh\s+pr\s+create/.test(command)) return null;
  const base = extractFlag(command, "--base") || extractFlag(command, "-B");
  if (!base) return null;
  if (FORBIDDEN_PR_BASES.includes(base.toLowerCase())) {
    return `BLOCKED: PR targets "${base}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: run the hook script as a subprocess with a JSON payload on stdin.
// Returns { exitCode, stdout, stderr }. Accepts an optional `cwd` so tests
// can exercise the project-scope guard (issue #1591) — defaults to
// DEFAULT_MANAGED_DIR, a synthetic directory with a forge.yaml so existing
// tests keep exercising enforcement without depending on this repo's own
// (gitignored) forge.yaml being present in the checkout.
// ---------------------------------------------------------------------------

function runHook(payload, opts = {}) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: "" },
    cwd: opts.cwd || DEFAULT_MANAGED_DIR,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ---------------------------------------------------------------------------
// PR target validation (pure logic)
// ---------------------------------------------------------------------------

describe("checkPrTarget — pure logic", () => {
  it("blocks PR targeting main", () => {
    const msg = checkPrTarget("gh pr create --base main --title foo");
    assert.ok(msg, "should return a block message");
    assert.match(msg, /BLOCKED/);
    assert.match(msg, /main/);
  });

  it("blocks PR targeting master", () => {
    const msg = checkPrTarget("gh pr create --base master --title foo");
    assert.ok(msg);
    assert.match(msg, /master/);
  });

  it("allows PR targeting staging", () => {
    assert.equal(checkPrTarget("gh pr create --base staging --title foo"), null);
  });

  it("allows PR targeting milestone/slug", () => {
    assert.equal(checkPrTarget("gh pr create --base milestone/my-feature --title foo"), null);
  });

  it("allows PR with no --base (uses default)", () => {
    assert.equal(checkPrTarget("gh pr create --title foo"), null);
  });

  it("ignores non-pr-create commands", () => {
    assert.equal(checkPrTarget("gh pr list --base main"), null);
    assert.equal(checkPrTarget("git push origin main"), null);
  });

  it("handles equals form --base=main", () => {
    const msg = checkPrTarget("gh pr create --base=main --title foo");
    assert.ok(msg);
    assert.match(msg, /main/);
  });

  it("handles case-insensitive MAIN", () => {
    const msg = checkPrTarget("gh pr create --base MAIN --title foo");
    assert.ok(msg);
  });

  // Issue #1591 — quoted-value equals form must still be recognized.
  it('handles quoted-value equals form --base="main"', () => {
    const msg = checkPrTarget('gh pr create --base="main" --title foo');
    assert.ok(msg);
    assert.match(msg, /main/);
  });
});

// ---------------------------------------------------------------------------
// Label transition state machine — pure logic (issue #2326)
//
// checkLabelTransition() in the real hook shells out to `gh issue view` to
// read current labels/comments before deciding — that network dependency
// can't be exercised via a subprocess-level `gh` shim on this host: gh
// ships as a real (non-.cmd) executable and the hook invokes it with
// execFileSync("gh", ...) and no `shell: true`, so on Windows a shim placed
// on PATH is never resolved the same way (see the identical constraint
// documented in bin/tests/router.test.mjs around its npm.cmd shims). The
// pure-logic re-implementation below mirrors checkPrTarget's existing
// pattern above: it duplicates the hook's decision logic (the widened
// LABEL_TRANSITIONS map, the evidence predicate, and the post-fetch
// decision branch of checkLabelTransition) so the actual behavioral change
// can be asserted directly, independent of the gh round-trip.
//
// To confirm this test suite is not vacuous: reverting bin/hooks/pre-tool-use.mjs
// to its pre-#2326 state (workflow:building/workflow:in-review/workflow:ready-to-build
// with no "workflow:invalid" successor, and no evidence predicate) and mirroring
// that revert into the duplicated map below makes "allows building -> invalid
// with reversal evidence" and "allows in-review -> invalid with reversal evidence"
// FAIL (transition rejected as not in the allowed-successors list at all) —
// confirmed manually via `git stash` against origin/staging before this fix.
// ---------------------------------------------------------------------------

const LABEL_TRANSITIONS = {
  "workflow:investigating": ["workflow:ready-to-build", "workflow:invalid", "workflow:decomposed"],
  "workflow:ready-to-build": ["workflow:building", "workflow:invalid"],
  "workflow:building": ["workflow:in-review", "workflow:ready-to-build", "workflow:invalid"],
  "workflow:in-review": ["workflow:merged", "workflow:building", "workflow:invalid"],
  "workflow:merged": [],
  "workflow:invalid": [],
  "workflow:decomposed": [],
};

const EVIDENCE_REQUIRED_FOR_INVALID_FROM = new Set([
  "workflow:ready-to-build",
  "workflow:building",
  "workflow:in-review",
]);

// Mirrors TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS in bin/hooks/pre-tool-use.mjs (#2332).
const TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function hasInvalidReversalEvidence(comments) {
  if (!Array.isArray(comments)) return false;
  return comments.some((c) => {
    const body = String((c && c.body) || "");
    if (!body.includes("FORGE:INVESTIGATOR")) return false;
    if (!/\*\*Verdict\*\*:\s*INVALID/i.test(body)) return false;
    const association = String((c && c.authorAssociation) || "").toUpperCase();
    return TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS.has(association);
  });
}

/**
 * Mirrors the post-fetch decision branch of checkLabelTransition(): given an
 * already-known current label + candidate comments (standing in for the
 * `gh issue view --json labels,comments` result), decide whether the
 * transition to newLabel is allowed. Returns null (allow) or a block message.
 */
function decideLabelTransition(currentWorkflowLabel, newLabel, comments) {
  const successors = LABEL_TRANSITIONS[currentWorkflowLabel];
  if (successors !== undefined && successors.length === 0) {
    return `BLOCKED: terminal state "${currentWorkflowLabel}"`;
  }
  const allowed = LABEL_TRANSITIONS[currentWorkflowLabel] || null;
  if (allowed === null) return null;
  if (!allowed.includes(newLabel)) {
    return `BLOCKED: "${currentWorkflowLabel}" -> "${newLabel}" not a legal transition`;
  }
  if (newLabel === "workflow:invalid" && EVIDENCE_REQUIRED_FOR_INVALID_FROM.has(currentWorkflowLabel)) {
    if (!hasInvalidReversalEvidence(comments)) {
      return `BLOCKED: workflow:invalid requires reversal evidence`;
    }
  }
  return null;
}

describe("label transition state machine — pure logic (#2326)", () => {
  const reversalComment = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report — CORRECTED\n\n**Verdict**: INVALID\n**Confidence**: HIGH',
    authorAssociation: "MEMBER",
  };
  const originalComment = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report\n\n**Verdict**: CONFIRMED\n**Confidence**: HIGH',
    authorAssociation: "MEMBER",
  };

  it("REJECTS workflow:building -> workflow:invalid with no evidence (still gated, not a removal)", () => {
    const msg = decideLabelTransition("workflow:building", "workflow:invalid", [originalComment]);
    assert.ok(msg, "must be blocked without a posted reversal");
    assert.match(msg, /evidence/);
  });

  it("ACCEPTS workflow:building -> workflow:invalid once a reversal comment is posted (the #2326 fix)", () => {
    const msg = decideLabelTransition("workflow:building", "workflow:invalid", [originalComment, reversalComment]);
    assert.equal(msg, null, "must be allowed once reversal evidence exists");
  });

  it("REJECTS workflow:in-review -> workflow:invalid with no evidence", () => {
    const msg = decideLabelTransition("workflow:in-review", "workflow:invalid", [originalComment]);
    assert.ok(msg);
    assert.match(msg, /evidence/);
  });

  it("ACCEPTS workflow:in-review -> workflow:invalid with reversal evidence", () => {
    const msg = decideLabelTransition("workflow:in-review", "workflow:invalid", [originalComment, reversalComment]);
    assert.equal(msg, null);
  });

  it("ACCEPTS workflow:ready-to-build -> workflow:invalid with reversal evidence", () => {
    const msg = decideLabelTransition("workflow:ready-to-build", "workflow:invalid", [reversalComment]);
    assert.equal(msg, null);
  });

  it("does not require evidence for workflow:investigating -> workflow:invalid (unchanged normal path)", () => {
    const msg = decideLabelTransition("workflow:investigating", "workflow:invalid", []);
    assert.equal(msg, null, "investigating -> invalid must stay evidence-free (Phase 1D's normal path)");
  });

  it("still blocks a plain unrelated illegal jump (investigating -> merged) — the original #1250 protection is intact", () => {
    const msg = decideLabelTransition("workflow:investigating", "workflow:merged", []);
    assert.ok(msg);
  });

  it("does not treat a comment merely containing FORGE:INVESTIGATOR text without an INVALID verdict as evidence", () => {
    const msg = decideLabelTransition("workflow:building", "workflow:invalid", [
      originalComment,
      { body: "<!-- FORGE:INVESTIGATOR -->\nsome unrelated note mentioning invalidation informally" },
    ]);
    assert.ok(msg, "a loosely-worded comment must not satisfy the evidence bar");
  });

  it("terminal states remain terminal (workflow:merged has no successors, including invalid)", () => {
    const msg = decideLabelTransition("workflow:merged", "workflow:invalid", [reversalComment]);
    assert.ok(msg);
    assert.match(msg, /terminal/);
  });
});

// ---------------------------------------------------------------------------
// gh CLI error fail-open/fail-closed split (#2347)
//
// checkLabelTransition()'s single `gh issue view` lookup also fetches the
// reversal-evidence comments when the attempted transition is to
// workflow:invalid (mayNeedEvidence). Before #2347, ANY `gh` error on that
// lookup returned null (allow) unconditionally — including when the error
// occurred while trying to fetch evidence for a workflow:invalid attempt,
// which silently bypassed the #2326/#2332 evidence gate. #2347 splits the
// catch behavior: fail-closed when mayNeedEvidence is true, fail-open
// (unchanged) otherwise.
//
// Mirrors the pattern above (and the file-level comment at ~line 150): the
// real hook's catch block wraps a live `execFileSync("gh", ...)` call that
// can't be shimmed via subprocess on this host, so this is a pure-logic
// re-implementation of just the catch branch's decision.
//
// To confirm this suite is not vacuous: reverting decideOnGhError below to
// its pre-#2347 form (`return null` unconditionally) makes "fails CLOSED
// when mayNeedEvidence is true" FAIL (would return null/allowed instead of
// a blocked message) — confirmed manually before this fix.
// ---------------------------------------------------------------------------

function decideOnGhError(mayNeedEvidence) {
  if (mayNeedEvidence) {
    return "BLOCKED: unable to verify workflow:invalid evidence (gh CLI error)";
  }
  return null;
}

describe("gh CLI error fail-open/fail-closed split (#2347)", () => {
  it("fails CLOSED when the attempted transition is workflow:invalid (mayNeedEvidence=true)", () => {
    const msg = decideOnGhError(true);
    assert.ok(msg, "a gh error while fetching reversal evidence must not silently allow workflow:invalid");
    assert.match(msg, /evidence/i);
  });

  it("stays fail-OPEN for ordinary (non-evidence-gated) transitions (mayNeedEvidence=false)", () => {
    const msg = decideOnGhError(false);
    assert.equal(msg, null, "gh errors on ordinary transitions must remain fail-open, unchanged");
  });
});

// ---------------------------------------------------------------------------
// Author-association check on reversal evidence (#2332)
//
// #2326 required marker+verdict text but never checked who posted it — on
// this public repo (confirmed live: `gh api repos/.../interaction-limits`
// returns `{}`, no restriction), any commenter with zero write access could
// forge a comment matching the marker+verdict regex and unlock
// workflow:invalid from a build-in-progress state. #2332 closes this by
// requiring the comment's `authorAssociation` (OWNER/MEMBER/COLLABORATOR)
// alongside the existing text match.
//
// To confirm this suite is not vacuous: temporarily reverting
// hasInvalidReversalEvidence() above to its pre-#2332 form (marker+verdict
// text only, no authorAssociation check) makes "REJECTS a forged reversal
// comment from an untrusted author" and its NONE/CONTRIBUTOR/missing-field
// variants below FAIL — the forged comment would incorrectly satisfy the
// evidence bar. Confirmed manually by commenting out the authorAssociation
// line and re-running this file: those tests fail; all others are
// unaffected. Restored before commit.
// ---------------------------------------------------------------------------

describe("label transition state machine — reversal evidence author check (#2332)", () => {
  const forgedByOutsider = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report — CORRECTED\n\n**Verdict**: INVALID\n**Confidence**: HIGH',
    authorAssociation: "NONE",
  };
  const forgedByContributor = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report — CORRECTED\n\n**Verdict**: INVALID\n**Confidence**: HIGH',
    authorAssociation: "CONTRIBUTOR",
  };
  const forgedByFirstTimer = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report — CORRECTED\n\n**Verdict**: INVALID\n**Confidence**: HIGH',
    authorAssociation: "FIRST_TIME_CONTRIBUTOR",
  };
  const forgedNoAssociationField = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report — CORRECTED\n\n**Verdict**: INVALID\n**Confidence**: HIGH',
    // authorAssociation intentionally absent — simulates a malformed/older gh response.
  };
  const legitimateByOwner = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report — CORRECTED\n\n**Verdict**: INVALID\n**Confidence**: HIGH',
    authorAssociation: "OWNER",
  };
  const legitimateByCollaborator = {
    body: '<!-- FORGE:INVESTIGATOR -->\n## Investigation Report — CORRECTED\n\n**Verdict**: INVALID\n**Confidence**: HIGH',
    authorAssociation: "COLLABORATOR",
  };

  it("REJECTS a forged reversal comment from an untrusted author (authorAssociation: NONE) — the #2332 fix", () => {
    const msg = decideLabelTransition("workflow:building", "workflow:invalid", [forgedByOutsider]);
    assert.ok(msg, "a NONE-association comment must not satisfy the evidence bar");
    assert.match(msg, /evidence/);
  });

  it("REJECTS a forged reversal comment from a CONTRIBUTOR (has contributed code, but no write access)", () => {
    const msg = decideLabelTransition("workflow:in-review", "workflow:invalid", [forgedByContributor]);
    assert.ok(msg);
    assert.match(msg, /evidence/);
  });

  it("REJECTS a forged reversal comment from a FIRST_TIME_CONTRIBUTOR", () => {
    const msg = decideLabelTransition("workflow:ready-to-build", "workflow:invalid", [forgedByFirstTimer]);
    assert.ok(msg);
    assert.match(msg, /evidence/);
  });

  it("REJECTS a reversal comment with authorAssociation missing entirely (fails toward requiring evidence, not toward accepting it)", () => {
    const msg = decideLabelTransition("workflow:building", "workflow:invalid", [forgedNoAssociationField]);
    assert.ok(msg, "a missing authorAssociation field must not be treated as trusted");
    assert.match(msg, /evidence/);
  });

  it("ACCEPTS a reversal comment from OWNER (legitimate identity, matches #2312 pattern)", () => {
    const msg = decideLabelTransition("workflow:building", "workflow:invalid", [legitimateByOwner]);
    assert.equal(msg, null, "an OWNER-authored reversal must still be accepted");
  });

  it("ACCEPTS a reversal comment from COLLABORATOR (no regression across the #1722 identity rotation)", () => {
    const msg = decideLabelTransition("workflow:in-review", "workflow:invalid", [legitimateByCollaborator]);
    assert.equal(msg, null, "a COLLABORATOR-authored reversal must still be accepted regardless of which gh identity that is");
  });

  it("does not hardcode a specific bot login anywhere in the trust set", () => {
    assert.deepEqual(
      [...TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS].sort(),
      ["COLLABORATOR", "MEMBER", "OWNER"],
      "trust set must be GitHub relationship tiers, not literal usernames"
    );
  });
});

// ---------------------------------------------------------------------------
// Hook process integration tests (subprocess execution)
// ---------------------------------------------------------------------------

describe("pre-tool-use hook — subprocess", () => {
  it("exits 0 for non-Bash tool calls (fail-open)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {},
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 for unrelated Bash commands (fail-open)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 2 and prints BLOCKED for gh pr create --base main", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base main --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for --base=master", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base=master --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 0 for gh pr create --base staging", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base staging --title foo" },
    });
    assert.equal(exitCode, 0);
  });

  // -------------------------------------------------------------------------
  // Regression tests for issue #1519 — extractFlag() must not misread
  // flag-shaped text embedded inside a quoted --title/--body value as a
  // real --base/-B flag. These run against the actual hook file via
  // runHook() (subprocess), not the duplicated pure-logic copy above.
  // -------------------------------------------------------------------------

  it("exits 0 when -B-shaped text appears inside a quoted --title value (#1519)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "Fix -B main thread bug" --body "desc"',
      },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 when --base-shaped text appears inside a quoted --body value (#1519)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command:
          'gh pr create --title "fix" --body "Discusses --base main config handling"',
      },
    });
    assert.equal(exitCode, 0);
  });

  it("still exits 2 for a real -B main flag alongside quoted args (#1519)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create -B main --title "Fix -B thing"',
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  // -------------------------------------------------------------------------
  // Regression tests for issue #1550 — extractFlag() must also recognize the
  // attached short-flag form (-Bvalue, no separating space), which `gh`
  // itself accepts as equivalent to `-B value`. Without this, a forbidden
  // PR base written as -Bmain bypassed the hard block entirely.
  // -------------------------------------------------------------------------

  it("exits 2 and prints BLOCKED for attached short-flag form -Bmain (#1550)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create -Bmain --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for attached short-flag form -Bmaster (#1550)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create -Bmaster --title foo" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 0 for attached short-flag form targeting an allowed base -Bstaging (#1550)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create -Bstaging --title foo" },
    });
    assert.equal(exitCode, 0);
  });

  // -------------------------------------------------------------------------
  // Regression tests for the quoted-decoy bypass (#1519 bug class, under-block
  // direction). A quoted --title/--body value that starts with the flag text
  // must NOT be treated as the flag — otherwise extraction short-circuits on
  // the decoy and misses a real forbidden `-B main` later in the command.
  // These run against the real hook via runHook() (subprocess).
  // -------------------------------------------------------------------------

  it("still exits 2 when a quoted --title decoy starts with -B but a real -B main follows (attached-form decoy)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "-Bstaging is fine" -B main',
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("still exits 2 when a quoted --title decoy starts with -B= but a real -B main follows (equals-form decoy)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "-B=staging is fine" -B main',
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("still exits 2 when a quoted --body decoy precedes a real -Bmain attached flag", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --body "-Bstaging safe" -Bmain',
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 0 when a quoted --body decoy starts with -Bmain but the real base is staging (no false over-block)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --body "-Bmain in the title text" -B staging',
      },
    });
    assert.equal(exitCode, 0);
  });

  // -------------------------------------------------------------------------
  // Regression tests for issue #1591 — the quoted-flag bypass. A single-word
  // token that was quoted (with no embedded whitespace) is functionally
  // identical to its unquoted form once the shell hands it to `gh`, so it
  // must be blocked the same way. Previously, `tokenizeCommand`'s whole-token
  // `quoted` boolean (true if ANY character was quoted) caused `extractFlag`
  // to skip these forms entirely.
  // -------------------------------------------------------------------------

  it('exits 2 for a quoted-value equals form --base="main" (#1591)', () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'gh pr create --base="main" --title foo' },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
    assert.match(stderr, /main/);
  });

  it('exits 2 for a fully-quoted equals form "--base=main" (#1591)', () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'gh pr create "--base=main" --title foo' },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
    assert.match(stderr, /main/);
  });

  it('exits 2 for a fully-quoted attached short-flag form "-Bmain" (#1591)', () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'gh pr create "-Bmain" --title foo' },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
    assert.match(stderr, /main/);
  });

  it('still exits 0 for a fully-quoted attached short-flag form targeting an allowed base "-Bstaging" (#1591, no over-block)', () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'gh pr create "-Bstaging" --title foo' },
    });
    assert.equal(exitCode, 0);
  });

  // -------------------------------------------------------------------------
  // Regression tests for the project-scope guard (issue #1591). The hook
  // installs into the user's global ~/.claude/settings.json, so it must
  // no-op entirely outside a ForgeDock-managed directory (one with a
  // forge.yaml or .forgedock marker) rather than enforcing pipeline rules
  // in every repo on the machine.
  // -------------------------------------------------------------------------

  it("exits 0 (no-op) for a forbidden PR base when cwd is NOT a ForgeDock-managed directory (#1591)", () => {
    const unmanagedDir = mkdtempSync(join(osTop.tmpdir(), "fd-ptu-unmanaged-"));
    try {
      const { exitCode } = runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "gh pr create --base main --title foo" },
        },
        { cwd: unmanagedDir },
      );
      assert.equal(exitCode, 0);
    } finally {
      rmSync(unmanagedDir, { recursive: true, force: true });
    }
  });

  it("still exits 2 for a forbidden PR base when cwd IS a ForgeDock-managed directory (#1591)", () => {
    const managedDir = makeManagedDir();
    try {
      const { exitCode, stderr } = runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "gh pr create --base main --title foo" },
        },
        { cwd: managedDir },
      );
      assert.equal(exitCode, 2);
      assert.match(stderr, /BLOCKED/);
    } finally {
      rmSync(managedDir, { recursive: true, force: true });
    }
  });

  it("exits 0 for non-PreToolUse events (wrong event type)", () => {
    const { exitCode } = runHook({
      hook_event_name: "SessionStart",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base main" },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 for empty stdin (fail-open)", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: "",
      encoding: "utf-8",
      timeout: 3000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(result.status, 0);
  });

  it("exits 0 for malformed JSON (fail-open)", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: "{ not json }",
      encoding: "utf-8",
      timeout: 3000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: Gist visibility guard (issue #1729)
// Tests for the --public block on gh gist create commands.
// ---------------------------------------------------------------------------

describe("pre-tool-use hook — gist visibility guard (#1729)", () => {
  it("exits 2 and prints BLOCKED for gh gist create --public", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh gist create --public -f file.md" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
    assert.match(stderr, /--public/);
  });

  it("exits 2 for gh gist create with --public after filename", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh gist create file.md --public" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for gh gist create --public= form", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh gist create --public=true -f file.md" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 0 for gh gist create without --public (default is secret)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh gist create -f file.md -d 'description'" },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 for gh gist list (not a create command)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh gist list --limit 100 --public" },
    });
    assert.equal(exitCode, 0);
  });

  it("exits 0 when FORGE_ALLOW_PUBLIC_GIST=1 env override is set", () => {
    // Spawn the hook with FORGE_ALLOW_PUBLIC_GIST=1 in env
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh gist create --public -f file.md" },
      }),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, NODE_OPTIONS: "", FORGE_ALLOW_PUBLIC_GIST: "1" },
      cwd: DEFAULT_MANAGED_DIR,
    });
    assert.equal(result.status, 0, "FORGE_ALLOW_PUBLIC_GIST=1 should allow --public");
  });

  it("exits 0 (no-op) for gist --public in an unmanaged directory (#1729)", () => {
    const unmanagedDir = mkdtempSync(join(osTop.tmpdir(), "fd-ptu-unmanaged-gist-"));
    try {
      const { exitCode } = runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "gh gist create --public -f file.md" },
        },
        { cwd: unmanagedDir },
      );
      assert.equal(exitCode, 0);
    } finally {
      rmSync(unmanagedDir, { recursive: true, force: true });
    }
  });

  it("exits 2 even when --public appears inside a larger pipeline command (#1729)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "echo content | gh gist create --public -f report.md -d 'findings'",
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Filesystem-root `find` guard (issue #2034)
// Tests for the deterministic block on `find` rooted at `/` or a bare
// Git-Bash drive mount (`/c`, `/d`, ...). #1984 was a narrow, single-call-
// site precursor fix (PATH-based `which` lookup removal + prose guardrail in
// commands/work-on.md); this rule is the systemic, deterministic follow-up.
// ---------------------------------------------------------------------------

describe("pre-tool-use hook — filesystem-root find guard (#2034)", () => {
  it("exits 2 and prints BLOCKED for find / -iname x", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find / -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
    assert.match(stderr, /find/);
  });

  it("exits 2 for find /c -name y (bare drive mount)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /c -name y" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find /d rooted at another drive mount, case-insensitive", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /D -maxdepth 6 -iname protocols.md" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it('exits 2 for find rooted at "/" appearing after && in a compound command', () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd /tmp && find / -iname classify-lane.sh" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  // Regression tests for a review finding on this PR (SEC-1, CONFIRMED HIGH):
  // `find` glued to a shell metacharacter with no separating whitespace
  // stayed fused into the adjacent token (e.g. "/tmp;find", "$(find") and
  // bypassed detection entirely, since tokenizeCommand() only splits on
  // whitespace and quotes. extractLogicalTokens() now also splits unquoted
  // tokens on `;`, `&`, `|`, `(`, `)`, `$`, and backtick.
  it("exits 2 for find / immediately after a semicolon with no space (cd /tmp;find /)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd /tmp;find / -name x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find / inside command substitution ($(find / ...))", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "for f in $(find / -type f); do echo $f; done" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find / inside backticks (legacy command substitution)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "for f in `find / -type f`; do echo $f; done" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find / glued to && with no space (echo hi&&find /c)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi&&find /c -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find / glued to a pipe with no space (echo hi|find /)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi|find / -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  // Regression tests for review finding SEC-1 (CONFIRMED MEDIUM, issue #2113):
  // FIND_ROOT_TOKEN_RE only matched a bare `/` or bare drive letter, so a
  // trailing-slash drive mount (`/c/`) or a dot/double-slash root variant
  // (`/.`, `/..`, `//`) reached the identical whole-drive scan but was
  // wrongly ALLOWED.
  it("exits 2 for find /c/ (trailing-slash drive mount)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /c/ -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find /. (dot root)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /. -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find /.. (double-dot root)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /.. -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find // (double-slash root)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find // -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  // Regression tests for review finding (issue #2213): the #2113 fix added
  // an optional trailing slash to the drive-letter branch of
  // FIND_ROOT_TOKEN_RE but not to the dot branch, so the bare trailing-slash
  // dot forms `/./` and `/../` still bypassed the guard despite being
  // directory-equivalent to `/.` and `/..`.
  it("exits 2 for find /./ (dot root with trailing slash)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /./ -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find /../ (double-dot root with trailing slash)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /../ -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  // Regression test for review finding SEC-2 (CONFIRMED LOW): command-name
  // matching was case-sensitive, so `Find /` or `FIND /` bypassed the guard
  // despite Windows resolving them to the same binary as `find`.
  it("exits 2 for Find / with a capitalized command name (case-insensitive match)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "Find / -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for FIND /C with fully uppercase command and drive letter", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "FIND /C -iname x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it('allows find "$REPO_PATH" -name z (scoped absolute path)', () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'find "$REPO_PATH" -name z' },
    });
    assert.equal(exitCode, 0);
  });

  it("allows find . -maxdepth 2 ... (relative path)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find . -maxdepth 2 -iname x" },
    });
    assert.equal(exitCode, 0);
  });

  it("allows find /c/Users/.../repo -maxdepth 2 -name x (scoped path under a drive mount)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /c/Users/itsmr/repo -maxdepth 2 -name x" },
    });
    assert.equal(exitCode, 0);
  });

  // Confirms the SEC-1 (#2113) regex widening for /c/, /., /.., // did not
  // regress scoped-path matching under a dot or double-slash-adjacent root.
  it("allows find /./repo -maxdepth 2 -name x (scoped path under a dot-prefixed root)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /./repo -maxdepth 2 -name x" },
    });
    assert.equal(exitCode, 0);
  });

  it("allows find /../repo -maxdepth 2 -name x (scoped path under a double-dot-prefixed root)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find /../repo -maxdepth 2 -name x" },
    });
    assert.equal(exitCode, 0);
  });

  it("allows commands that merely mention 'find /' inside a quoted --body value (no real find invocation)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh issue comment 1 --body "do not run find / to locate files"',
      },
    });
    // The literal text "find /" appears inside a single quoted --body value.
    // tokenizeCommand() preserves embedded whitespace for quoted arguments —
    // the whole quoted string becomes ONE token, not separate "find" and "/"
    // tokens — so this is never mistaken for a real `find` invocation. This
    // is the same quote-aware protection extractFlag() relies on elsewhere
    // in this file (issues #1519, #1591) and is essential here: pipeline
    // comments (like this issue's own investigation report) routinely quote
    // `find /...` examples in prose and must never trip this guard.
    assert.equal(exitCode, 0);
  });

  it("exits 0 (no-op elsewhere) for a non-find command", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assert.equal(exitCode, 0);
  });

  it("blocks find / even when cwd is NOT a ForgeDock-managed directory (cwd-independent, #2034)", () => {
    const unmanagedDir = mkdtempSync(join(osTop.tmpdir(), "fd-ptu-unmanaged-find-"));
    try {
      const { exitCode, stderr } = runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "find / -iname review-pr-agents -type d" },
        },
        { cwd: unmanagedDir },
      );
      assert.equal(exitCode, 2, "Rule 5 must fire regardless of forge.yaml presence");
      assert.match(stderr, /BLOCKED/);
    } finally {
      rmSync(unmanagedDir, { recursive: true, force: true });
    }
  });

  it("blocks find / when cwd IS a ForgeDock-managed directory too (consistent behavior)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "find / -iname pytest*" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  // Regression tests for a review finding on PR #2049 (#2059, CONFIRMED
  // MEDIUM): tokenizeCommand() sets a token's `quoted` flag to true the
  // moment ANY quote character appears in it, even a degenerate empty pair
  // (`""`, `''`) glued onto otherwise-unquoted text. extractLogicalTokens()
  // used that coarse flag alone to decide whether to skip the shell-
  // metacharacter split, so an empty-quote injection glued to a
  // metacharacter (e.g. `;""find`) fused `find` into the surrounding token
  // (`/tmp;find`) and bypassed detection. The fix requires the quoting to
  // also span embedded whitespace — the same discriminator extractFlag()
  // already uses for the identical decoy class (issues #1519, #1591).
  it('exits 2 for find / after a semicolon glued to an empty double-quote pair (cd /tmp;""find /)', () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'cd /tmp;""find / -name x' },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("exits 2 for find / after a semicolon glued to an empty single-quote pair (cd /tmp;''find /)", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd /tmp;''find / -name x" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it('exits 2 for find / glued to && with a degenerate single-char quote inside the command name ("f"ind)', () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'echo x&&"f"ind /' },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  // Regression test for a CONFIRMED HIGH finding surfaced during review of
  // this same fix (PR #2067, issue #2059): backslash-escaping is a separate,
  // unaddressed way to smuggle the literal token `find` past the guard.
  // `f\ind` is real bash for the plain word `find` (a backslash strips the
  // special meaning of the next character and collapses to it literally,
  // outside quotes). tokenizeCommand() now handles this the same way it
  // handles quoting.
  it('exits 2 for find / with a backslash-escaped command name (cd /tmp;f\\ind /)', () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd /tmp;f\\ind /" },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("still allows the multi-word quoted --body decoy after the embedded-whitespace fix (no false positive regression)", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh issue comment 1 --body "do not run find / to locate files"',
      },
    });
    // Genuine multi-word quoting (embedded whitespace) must still be treated
    // as inert argument text and left unsplit — only degenerate/empty
    // quoting with NO embedded whitespace loses the unsplit protection.
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// settings-hook.mjs — SubagentStop and PreToolUse wiring tests
// ---------------------------------------------------------------------------

import {
  installSubagentStopHook,
  removeSubagentStopHook,
  installPreToolUseHook,
  removePreToolUseHook,
  installSessionStartHook,
  SUBAGENT_STOP_MARKER,
  PRE_TOOL_USE_MARKER,
} from "../settings-hook.mjs";
import { writeFileSync, readFileSync } from "node:fs";
import os from "node:os";

describe("settings-hook — SubagentStop wiring", () => {
  let tmpDir, settingsPath;
  const before = () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "fd-sh-"));
    settingsPath = join(tmpDir, "settings.json");
  };
  const after = () => rmSync(tmpDir, { recursive: true, force: true });

  it("installs SubagentStop hook into fresh settings", () => {
    before();
    const res = installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    assert.equal(res.status, "installed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(parsed.hooks.SubagentStop));
    assert.match(JSON.stringify(parsed.hooks.SubagentStop), /interactive-engine\.mjs/);
    after();
  });

  it("is idempotent for SubagentStop", () => {
    before();
    installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    const res = installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    assert.equal(res.status, "already");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const count = (JSON.stringify(parsed).match(/interactive-engine\.mjs/g) || []).length;
    assert.equal(count, 1);
    after();
  });

  it("removes SubagentStop hook", () => {
    before();
    installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    const res = removeSubagentStopHook(settingsPath);
    assert.equal(res.status, "removed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.hooks.SubagentStop.length, 0);
    after();
  });

  it("reports absent when SubagentStop hook not installed", () => {
    before();
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), "utf-8");
    assert.equal(removeSubagentStopHook(settingsPath).status, "absent");
    after();
  });
});

describe("settings-hook — PreToolUse wiring", () => {
  let tmpDir, settingsPath;
  const before = () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "fd-sh-ptu-"));
    settingsPath = join(tmpDir, "settings.json");
  };
  const after = () => rmSync(tmpDir, { recursive: true, force: true });

  it("installs PreToolUse hook into fresh settings", () => {
    before();
    const res = installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    assert.equal(res.status, "installed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(parsed.hooks.PreToolUse));
    assert.match(JSON.stringify(parsed.hooks.PreToolUse), /pre-tool-use\.mjs/);
    after();
  });

  // Issue #1591 — the installed entry must carry matcher: "Bash" so Claude
  // Code's harness skips spawning this hook for non-Bash tool calls.
  it('installs PreToolUse hook with matcher: "Bash" (#1591)', () => {
    before();
    installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const entry = parsed.hooks.PreToolUse.find((e) =>
      JSON.stringify(e).includes(PRE_TOOL_USE_MARKER),
    );
    assert.ok(entry, "expected to find the installed PreToolUse entry");
    assert.equal(entry.matcher, "Bash");
    after();
  });

  it("is idempotent for PreToolUse", () => {
    before();
    installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    const res = installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    assert.equal(res.status, "already");
    after();
  });

  it("removes PreToolUse hook", () => {
    before();
    installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    const res = removePreToolUseHook(settingsPath);
    assert.equal(res.status, "removed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.hooks.PreToolUse.length, 0);
    after();
  });

  it("all three hooks coexist in same settings.json", () => {
    before();
    installSessionStartHook(settingsPath, "/fake/session-start.mjs");
    installSubagentStopHook(settingsPath, "/fake/interactive-engine.mjs");
    installPreToolUseHook(settingsPath, "/fake/pre-tool-use.mjs");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(parsed.hooks.SessionStart));
    assert.ok(Array.isArray(parsed.hooks.SubagentStop));
    assert.ok(Array.isArray(parsed.hooks.PreToolUse));
    assert.equal(parsed.hooks.SessionStart.length, 1);
    assert.equal(parsed.hooks.SubagentStop.length, 1);
    assert.equal(parsed.hooks.PreToolUse.length, 1);
    after();
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Attribution guard — blocks Claude Code default attribution from
// landing in a repo's commit/PR/issue history (subprocess integration).
// ---------------------------------------------------------------------------

describe("attribution guard — subprocess", () => {
  it("blocks a commit carrying a Co-Authored-By: Claude trailer", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command:
          'git commit -m "fix(x): thing" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
    assert.match(stderr, /ForgeDock/);
  });

  it("blocks a PR body with '🤖 Generated with [Claude Code]'", () => {
    const { exitCode, stderr } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command:
          'gh pr create --base staging --title foo --body "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr, /BLOCKED/);
  });

  it("blocks an issue comment carrying the anthropic co-author email", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'gh issue comment 12 --body "done\n\nnoreply@anthropic.com"',
      },
    });
    assert.equal(exitCode, 2);
  });

  it("allows a clean commit with no attribution", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'git commit -s -m "fix(x): thing (#42)"' },
    });
    assert.equal(exitCode, 0);
  });

  it("allows a PR body carrying the ForgeDock signature", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command:
          'gh pr create --base staging --title foo --body "Summary\n\n> ⚒️ Orchestrated with ForgeDock — state, scheduling, review, and memory on GitHub."',
      },
    });
    assert.equal(exitCode, 0);
  });

  it("does not fire on unrelated commands that mention Claude Code", () => {
    const { exitCode } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'grep -r "Generated with Claude Code" docs/' },
    });
    assert.equal(exitCode, 0);
  });

  it("honors FORGE_ALLOW_AI_ATTRIBUTION=1 operator override", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: 'git commit -m "x" -m "Co-Authored-By: Claude"',
        },
      }),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, NODE_OPTIONS: "", FORGE_ALLOW_AI_ATTRIBUTION: "1" },
      cwd: DEFAULT_MANAGED_DIR,
    });
    assert.equal(result.status ?? -1, 0);
  });
});
