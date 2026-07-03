/**
 * bin/tests/tui.test.mjs
 *
 * Unit tests for exported ANSI string utilities from bin/tui.mjs.
 *
 * Covers:
 *   - stripAnsi: removes all CSI sequences, passthrough on plain strings.
 *   - truncateVisible: no-op when content fits, plain-text truncation,
 *     ANSI-decorated truncation mid-styled-run with no-token-leak assertion,
 *     trailing reset present after truncation, no spurious reset on no-truncation,
 *     boundary values (maxWidth=0, ANSI-only input).
 *
 * Run with: node --test bin/tests/tui.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the utilities under test. tui.mjs uses process.stdout.isTTY to decide
// whether to emit ANSI codes from color helpers — in a non-TTY test environment
// those helpers return plain text. truncateVisible and stripAnsi are pure string
// functions that operate on whatever input is provided, including literal ANSI
// sequences, so tests pass escape sequences directly.
//
// Use pathToFileURL to produce a valid file:// URL on Windows (raw C:\ paths are
// not valid ESM specifiers on Windows — see ERR_UNSUPPORTED_ESM_URL_SCHEME).
const { stripAnsi, truncateVisible, annotatedReviewScreen } = await import(
  pathToFileURL(join(__dirname, "..", "tui.mjs")).href
);

// Convenience: raw ANSI sequences for tests (no USE_ANSI dependency)
const ESC = "\x1b[";
const BOLD_OPEN  = "\x1b[1m";
const DIM_OPEN   = "\x1b[2m";
const RED_OPEN   = "\x1b[31m";
const GREEN_OPEN = "\x1b[32m";
const RESET      = "\x1b[0m";

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  it("returns plain string unchanged", () => {
    assert.equal(stripAnsi("hello world"), "hello world");
  });

  it("removes SGR sequences (bold, color)", () => {
    assert.equal(stripAnsi(`${BOLD_OPEN}hello${RESET}`), "hello");
  });

  it("removes multiple sequences in one string", () => {
    const decorated = `${RED_OPEN}foo${RESET} ${GREEN_OPEN}bar${RESET}`;
    assert.equal(stripAnsi(decorated), "foo bar");
  });

  it("handles empty string", () => {
    assert.equal(stripAnsi(""), "");
  });

  it("removes all CSI sequences including non-SGR (broadened regex — PR #488)", () => {
    // Non-SGR CSI: cursor movement \x1b[2A (move up 2)
    assert.equal(stripAnsi("abc\x1b[2Adef"), "abcdef");
  });
});

// ---------------------------------------------------------------------------
// truncateVisible — basic cases
// ---------------------------------------------------------------------------

describe("truncateVisible — no truncation", () => {
  it("passes through a plain string shorter than maxWidth", () => {
    assert.equal(truncateVisible("hello", 10), "hello");
  });

  it("passes through a plain string exactly at maxWidth", () => {
    assert.equal(truncateVisible("hello", 5), "hello");
  });

  it("passes through an ANSI string whose visible length is within budget", () => {
    const decorated = `${BOLD_OPEN}hi${RESET}`;
    const result = truncateVisible(decorated, 10);
    // Visual content is "hi" (2 chars) — well within budget; original ANSI tags preserved
    assert.equal(stripAnsi(result), "hi");
    // The result should be identical to the input (no tokens dropped, no extra tokens)
    assert.equal(result, decorated,
      "non-truncated ANSI string should pass through unchanged");
  });

  it("passes through empty string", () => {
    assert.equal(truncateVisible("", 5), "");
  });
});

describe("truncateVisible — plain-text truncation", () => {
  it("truncates a plain string to maxWidth", () => {
    const result = truncateVisible("hello world", 5);
    assert.equal(result, "hello");
  });

  it("does not add trailing reset to a plain-text-only truncation (no ANSI in result)", () => {
    const result = truncateVisible("hello world", 5);
    assert.ok(!result.includes(ESC),
      "plain truncation result must not contain ANSI sequences");
  });
});

// ---------------------------------------------------------------------------
// truncateVisible — ANSI-decorated truncation (core bug: #492)
// ---------------------------------------------------------------------------

describe("truncateVisible — ANSI-decorated truncation", () => {
  it("truncates visible text correctly when styled", () => {
    // "foo bar" wrapped in bold: visual length 7, truncate to 4 → "foo "
    const input = `${BOLD_OPEN}foo bar${RESET}`;
    const result = truncateVisible(input, 4);
    assert.equal(stripAnsi(result), "foo ",
      "visible text must be truncated to maxWidth");
  });

  it("does NOT leak style tokens from the cut region into the result — fix for #492", () => {
    // Construct a string where an open-color token appears after the cut point.
    // Input: "abc" (plain) + RED_OPEN + "xyz" (styled) + RESET
    // Visible chars: a(1) b(2) c(3) | cut | x y z
    // Truncate to 3 visible chars. The RED_OPEN token appears after position 3
    // (after the cut), so it must NOT appear in the result.
    const input = `abc${RED_OPEN}xyz${RESET}`;
    const result = truncateVisible(input, 3);

    // Visible text must be exactly "abc"
    assert.equal(stripAnsi(result), "abc",
      "visible text must be truncated to maxWidth");

    // The RED_OPEN token that was in the cut region must not appear in result
    assert.ok(!result.includes(RED_OPEN),
      "style tokens from the cut region must NOT appear in the result (fix for #492)");
  });

  it("does NOT leak open-style token from cut region when cut falls inside a styled run", () => {
    // Input: BOLD_OPEN + "foobar" + RESET — truncate to 3
    // The BOLD_OPEN is at position 0 (before any visible chars), so it IS in budget.
    // "bar" is in the cut region. The RESET token comes after the cut point,
    // so it should be suppressed from being forwarded — the post-loop reset guard
    // handles cleanup instead.
    const input = `${BOLD_OPEN}foobar${RESET}`;
    const result = truncateVisible(input, 3);

    assert.equal(stripAnsi(result), "foo",
      "visible text must be truncated to 3 chars");

    // The trailing RESET should come from the post-loop guard (PR #486), not from
    // the cut region token forwarding. Either way, the result must end with RESET.
    assert.ok(result.endsWith(RESET),
      "result must end with trailing reset (PR #486 guard) after truncating ANSI string");

    // Only one RESET should appear — it should not be duplicated
    const resetCount = (result.match(/\x1b\[0m/g) || []).length;
    assert.equal(resetCount, 1,
      "trailing reset must appear exactly once");
  });

  it("appends trailing reset when truncation leaves open ANSI sequences — PR #486 regression", () => {
    // Color opens before cut, reset would have come after; trailing guard must fire
    const input = `${GREEN_OPEN}hello world${RESET}`;
    const result = truncateVisible(input, 5);
    assert.equal(stripAnsi(result), "hello");
    assert.ok(result.endsWith(RESET),
      "trailing reset must be present after truncating a colored string (PR #486 regression)");
  });

  it("does NOT append an extra trailing reset when no truncation occurred", () => {
    const input = `${BOLD_OPEN}hi${RESET}`;
    // "hi" = 2 visible chars, budget = 10 → no truncation; input already has RESET
    const result = truncateVisible(input, 10);
    // Result should be identical to input — no extra resets appended
    assert.equal(result, input,
      "non-truncated ANSI string must be returned unchanged (no extra resets)");
    // Exactly one RESET in result (from the original input, not from the guard)
    const resetCount = (result.match(/\x1b\[0m/g) || []).length;
    assert.equal(resetCount, 1,
      "result should contain exactly one RESET — the original one from the input");
  });

  it("handles multiple style tokens where some are before and some are after the cut point", () => {
    // RED_OPEN + "ab" + GREEN_OPEN + "cde" + RESET — cut at 3
    // "ab" (2 chars) is in budget → RED_OPEN forwarded, "ab" included, GREEN_OPEN check:
    //   visible=2 < maxWidth=3 → GREEN_OPEN forwarded, then "c" (1 char) consumed → visible=3
    // Wait — "cde": remaining=1 after "ab", so only "c" goes in. Then at next ANSI token (RESET),
    //   visible=3, NOT < maxWidth(3) → RESET suppressed. Post-loop guard appends RESET.
    const input = `${RED_OPEN}ab${GREEN_OPEN}cde${RESET}`;
    const result = truncateVisible(input, 3);

    assert.equal(stripAnsi(result), "abc",
      "visible text must be exactly 3 chars");

    // GREEN_OPEN was encountered when visible=2 < maxWidth=3, so it IS included
    assert.ok(result.includes(GREEN_OPEN),
      "GREEN_OPEN (encountered before budget exhausted) should be in result");

    // RESET from the cut region was suppressed, but post-loop guard appends one
    assert.ok(result.endsWith(RESET),
      "trailing reset must be present");

    // The RESET should appear exactly once (from post-loop guard)
    const resetCount = (result.match(/\x1b\[0m/g) || []).length;
    assert.equal(resetCount, 1,
      "exactly one reset — from post-loop guard, not forwarded from cut region");
  });
});

// ---------------------------------------------------------------------------
// truncateVisible — boundary values (#506)
// ---------------------------------------------------------------------------

describe("truncateVisible — boundary values", () => {
  it("returns empty string when maxWidth is 0 (plain text input)", () => {
    // Zero budget means nothing fits — regardless of input content.
    assert.equal(truncateVisible("hello world", 0), "",
      "maxWidth=0 must return empty string for plain text input");
  });

  it("returns empty string when maxWidth is 0 (ANSI-decorated input)", () => {
    // Zero budget: no visible characters fit; ANSI tokens are suppressed too
    // because the loop never enters the visible < maxWidth branch.
    const input = `${BOLD_OPEN}hello${RESET}`;
    assert.equal(truncateVisible(input, 0), "",
      "maxWidth=0 must return empty string even when input contains ANSI sequences");
  });

  it("returns input unchanged when input contains only ANSI sequences (zero visible chars)", () => {
    // Input has zero visible characters — stripAnsi(input).length === 0.
    // Since 0 is never > maxWidth (10), no truncation occurs and no trailing reset
    // is appended by the guard. The result must be identical to the original input.
    const input = `${BOLD_OPEN}${RESET}`;
    const result = truncateVisible(input, 10);
    assert.equal(result, input,
      "ANSI-only input must be returned unchanged (no extra trailing reset)");
  });

  it("does NOT append a spurious trailing reset for ANSI-only input at any width", () => {
    // The trailing-reset guard fires only when stripAnsi(str).length >= maxWidth.
    // For ANSI-only input, visible length is 0 — the guard must never fire.
    const input = `${RED_OPEN}${RESET}`;
    const result = truncateVisible(input, 0);
    // maxWidth=0 with zero visible chars: nothing to truncate; result is ""
    assert.equal(result, "",
      "ANSI-only input with maxWidth=0 must return empty string, not a bare RESET");
  });

  it("preserves trailing RESET when visible length equals maxWidth exactly — fix for #519", () => {
    // off-by-one boundary bug: when visible === maxWidth, the loop guard
    // (visible < maxWidth) suppresses the original RESET token.  The post-loop
    // reset guard must catch this case via >= rather than >.
    //
    // Input: BOLD_OPEN + "hi" + RESET — visible chars = 2, maxWidth = 2.
    // The loop processes BOLD_OPEN (visible=0<2 → forwarded), "hi" (visible→2),
    // then RESET (visible=2 is NOT < maxWidth=2 → suppressed by loop guard).
    // Without the fix the result would be "\x1b[1mhi" — bold bleeds into next column.
    const input = `${BOLD_OPEN}hi${RESET}`;
    const result = truncateVisible(input, 2);

    // Visible text must be preserved exactly
    assert.equal(stripAnsi(result), "hi",
      "visible content must be preserved when visible length equals maxWidth");

    // The trailing RESET must be present — original was suppressed, guard must fire
    assert.ok(result.endsWith(RESET),
      "trailing RESET must be preserved when visible length === maxWidth (fix for #519)");

    // Exactly one RESET (from post-loop guard — original was suppressed)
    const resetCount = (result.match(/\x1b\[0m/g) || []).length;
    assert.equal(resetCount, 1,
      "trailing reset must appear exactly once — not duplicated");
  });
});

// ---------------------------------------------------------------------------
// annotatedReviewScreen extraFields
// ---------------------------------------------------------------------------

describe("annotatedReviewScreen extraFields", () => {
  it("non-TTY: description from extraFields is returned; medium conf not flagged low", async () => {
    // process.stdin.isTTY is false under node --test, so this exercises the non-TTY path.
    const draft = {
      project: {
        owner: { value: "o", confidence: "high", source: "s", why: "w" },
        repo: { value: "r", confidence: "high", source: "s", why: "w" },
        name: { value: "n", confidence: "medium", source: "s", why: "w" },
      },
      paths: {
        root: { value: "/p", confidence: "high", source: "s", why: "w" },
        worktreeBase: { value: "/p/w", confidence: "high", source: "s", why: "w" },
      },
      branches: {
        default: { value: "main", confidence: "high", source: "s", why: "w" },
        staging: { value: "main", confidence: "medium", source: "s", why: "w" },
      },
      meta: { remoteDetected: true },
    };
    const res = await annotatedReviewScreen(draft, {
      extraFields: {
        description: { value: "From README", confidence: "medium", source: "README.md", why: "First paragraph" },
      },
    });
    assert.equal(res.description, "From README");
    assert.ok(!res.lowConfidenceKeys.includes("description"));
  });

  it("non-TTY without extraFields: description stays empty and low", async () => {
    const draft = {
      project: { owner: { value: "o", confidence: "high", source: "s", why: "w" },
                 repo: { value: "r", confidence: "high", source: "s", why: "w" },
                 name: { value: "n", confidence: "medium", source: "s", why: "w" } },
      paths: { root: { value: "/p", confidence: "high", source: "s", why: "w" },
               worktreeBase: { value: "/p/w", confidence: "high", source: "s", why: "w" } },
      branches: { default: { value: "main", confidence: "high", source: "s", why: "w" },
                  staging: { value: "main", confidence: "medium", source: "s", why: "w" } },
      meta: { remoteDetected: true },
    };
    const res = await annotatedReviewScreen(draft, {});
    assert.equal(res.description, "");
    assert.ok(res.lowConfidenceKeys.includes("description"));
  });
});
