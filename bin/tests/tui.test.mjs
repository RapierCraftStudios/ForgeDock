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
 *   - runSteps: ordering, skip, failure-stop, non-TTY plain output, elapsed-time line.
 *   - renderLogo: plain-text fallback when NO_COLOR is set / non-TTY environment.
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
const { stripAnsi, truncateVisible, runSteps, renderLogo, annotatedReviewScreen } = await import(
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

  it("removes OSC sequences terminated by BEL (forge#2490 — untrusted body sanitization)", () => {
    // OSC 8 hyperlink: \x1b]8;;URL\x07 text \x1b]8;;\x07
    assert.equal(stripAnsi("abc\x1b]8;;https://evil.example\x07def"), "abcdef");
  });

  it("removes OSC sequences terminated by ST (\\x1b\\\\)", () => {
    assert.equal(stripAnsi("abc\x1b]0;window title\x1b\\def"), "abcdef");
  });

  it("removes an unterminated OSC sequence to end of string", () => {
    // A truncated/malformed OSC (no BEL/ST before EOF) must not leak through.
    assert.equal(stripAnsi("abc\x1b]52;c;evilpayload"), "abc");
  });

  it("removes DCS sequences terminated by ST (forge#2548 — DCS/APC/PM/SOS gap)", () => {
    assert.equal(stripAnsi("abc\x1bPsome-dcs-payload\x1b\\def"), "abcdef");
  });

  it("removes DCS sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x1bPsome-dcs-payload\x07def"), "abcdef");
  });

  it("removes an unterminated DCS sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x1bPsome-dcs-payload"), "abc");
  });

  it("removes APC sequences terminated by ST, incl. Kitty graphics protocol (\\x1b_G...)", () => {
    assert.equal(stripAnsi("abc\x1b_Gsome-apc-payload\x1b\\def"), "abcdef");
  });

  it("removes APC sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x1b_Gsome-apc-payload\x07def"), "abcdef");
  });

  it("removes an unterminated APC sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x1b_Gsome-apc-payload"), "abc");
  });

  it("removes PM sequences terminated by ST", () => {
    assert.equal(stripAnsi("abc\x1b^some-pm-payload\x1b\\def"), "abcdef");
  });

  it("removes PM sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x1b^some-pm-payload\x07def"), "abcdef");
  });

  it("removes an unterminated PM sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x1b^some-pm-payload"), "abc");
  });

  it("removes SOS sequences terminated by ST", () => {
    assert.equal(stripAnsi("abc\x1bXsome-sos-payload\x1b\\def"), "abcdef");
  });

  it("removes SOS sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x1bXsome-sos-payload\x07def"), "abcdef");
  });

  it("removes an unterminated SOS sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x1bXsome-sos-payload"), "abc");
  });

  it("removes mixed OSC + DCS sequences in one string", () => {
    assert.equal(stripAnsi("a\x1b]8;;url\x07b\x1bPdcs\x1b\\c"), "abc");
  });

  it("removes mixed CSI + APC sequences in one string", () => {
    assert.equal(stripAnsi("\x1b[1ma\x1b_Gapc\x07b\x1b[0m"), "ab");
  });

  // -------------------------------------------------------------------------
  // C1 single-byte introducer forms (forge#2549 — 8-bit equivalents of the
  // 7-bit two-byte OSC/DCS/APC/PM/SOS introducers extended in forge#2548)
  // -------------------------------------------------------------------------

  it("removes C1 OSC (0x9d) sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x9d52;c;payload\x07def"), "abcdef");
  });

  it("removes C1 OSC (0x9d) sequences terminated by C1 ST (0x9c)", () => {
    assert.equal(stripAnsi("abc\x9d0;window title\x9cdef"), "abcdef");
  });

  it("removes an unterminated C1 OSC (0x9d) sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x9d52;c;evilpayload"), "abc");
  });

  it("removes C1 DCS (0x90) sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x90some-dcs-payload\x07def"), "abcdef");
  });

  it("removes C1 DCS (0x90) sequences terminated by C1 ST (0x9c)", () => {
    assert.equal(stripAnsi("abc\x90some-dcs-payload\x9cdef"), "abcdef");
  });

  it("removes an unterminated C1 DCS (0x90) sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x90some-dcs-payload"), "abc");
  });

  it("removes C1 APC (0x9f) sequences terminated by BEL, incl. Kitty graphics protocol", () => {
    assert.equal(stripAnsi("abc\x9fsome-apc-payload\x07def"), "abcdef");
  });

  it("removes C1 APC (0x9f) sequences terminated by C1 ST (0x9c)", () => {
    assert.equal(stripAnsi("abc\x9fsome-apc-payload\x9cdef"), "abcdef");
  });

  it("removes an unterminated C1 APC (0x9f) sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x9fsome-apc-payload"), "abc");
  });

  it("removes C1 PM (0x9e) sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x9esome-pm-payload\x07def"), "abcdef");
  });

  it("removes C1 PM (0x9e) sequences terminated by C1 ST (0x9c)", () => {
    assert.equal(stripAnsi("abc\x9esome-pm-payload\x9cdef"), "abcdef");
  });

  it("removes an unterminated C1 PM (0x9e) sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x9esome-pm-payload"), "abc");
  });

  it("removes C1 SOS (0x98) sequences terminated by BEL", () => {
    assert.equal(stripAnsi("abc\x98some-sos-payload\x07def"), "abcdef");
  });

  it("removes C1 SOS (0x98) sequences terminated by C1 ST (0x9c)", () => {
    assert.equal(stripAnsi("abc\x98some-sos-payload\x9cdef"), "abcdef");
  });

  it("removes an unterminated C1 SOS (0x98) sequence to end of string", () => {
    assert.equal(stripAnsi("abc\x98some-sos-payload"), "abc");
  });

  it("removes mixed C1 OSC + 7-bit DCS sequences in one string", () => {
    assert.equal(stripAnsi("a\x9d8;;url\x07b\x1bPdcs\x1b\\c"), "abc");
  });

  it("removes mixed CSI + C1 APC sequences in one string", () => {
    assert.equal(stripAnsi("\x1b[1ma\x9fapc\x07b\x1b[0m"), "ab");
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
// runSteps — non-TTY / no-ANSI mode (uses _forceNoAnsi: true)
//
// All tests use a mock writable stream to capture output without requiring a
// real TTY. _forceNoAnsi: true forces the non-TTY code path regardless of
// the test runner's TTY state.
// ---------------------------------------------------------------------------

/**
 * Create a lightweight writable stream mock that collects written chunks.
 * @returns {{ write(chunk: string): void, output(): string, isTTY: boolean }}
 */
function makeStream() {
  const chunks = [];
  return {
    isTTY: false, // non-TTY
    write(chunk) { chunks.push(chunk); },
    output() { return chunks.join(""); },
  };
}

describe("runSteps — non-TTY: ordering and success", () => {
  it("runs steps in order and prints ✔ for each", async () => {
    const order = [];
    const stream = makeStream();
    const result = await runSteps([
      { label: "Step A", run: async () => { order.push("A"); } },
      { label: "Step B", run: async () => { order.push("B"); } },
      { label: "Step C", run: async () => { order.push("C"); } },
    ], { stream, _forceNoAnsi: true });

    assert.deepEqual(order, ["A", "B", "C"], "steps must run in order A→B→C");
    assert.equal(result.ok, true, "result.ok must be true on success");
  });

  it("prints ✔ <label> for each completed step", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "Alpha", run: async () => {} },
      { label: "Beta",  run: async () => {} },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(out.includes("✔ Alpha\n"), "output must include ✔ Alpha");
    assert.ok(out.includes("✔ Beta\n"),  "output must include ✔ Beta");
  });

  it("prints elapsed-time summary line on success", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "Only step", run: async () => {} },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(
      /✔ Done in \d+\.\d+s/.test(out),
      "output must include '✔ Done in X.Xs' elapsed summary",
    );
  });

  it("returns { ok: true, elapsed } on success", async () => {
    const stream = makeStream();
    const result = await runSteps([
      { label: "Fast step", run: async () => {} },
    ], { stream, _forceNoAnsi: true });

    assert.equal(result.ok, true);
    assert.equal(typeof result.elapsed, "number", "elapsed must be a number (ms)");
    assert.ok(result.elapsed >= 0, "elapsed must be non-negative");
  });
});

describe("runSteps — non-TTY: skip behavior", () => {
  it("marks a step as skipped (—) when step.skip() is called", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "Optional step", run: async (step) => { step.skip("not needed"); } },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(out.includes("— Optional step — not needed\n"),
      "skipped step must print '— <label> — <reason>'");
  });

  it("prints '— <label>' (no reason suffix) when skip() called with no argument", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "No reason", run: async (step) => { step.skip(); } },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(out.includes("— No reason\n"),
      "skip with no reason must print '— <label>' with no trailing dash");
  });

  it("continues to next step after a skip", async () => {
    const order = [];
    const stream = makeStream();
    await runSteps([
      { label: "First",  run: async (step) => { step.skip("skip"); order.push("skip"); } },
      { label: "Second", run: async () => { order.push("second"); } },
    ], { stream, _forceNoAnsi: true });

    assert.deepEqual(order, ["skip", "second"],
      "execution must continue after a skipped step");
  });
});

describe("runSteps — non-TTY: failure behavior", () => {
  it("stops on first thrown error and returns ok: false", async () => {
    const order = [];
    const stream = makeStream();
    const err = new Error("boom");
    const result = await runSteps([
      { label: "OK step",   run: async () => { order.push("ok"); } },
      { label: "Bad step",  run: async () => { order.push("bad"); throw err; } },
      { label: "Last step", run: async () => { order.push("last"); } },
    ], { stream, _forceNoAnsi: true });

    assert.deepEqual(order, ["ok", "bad"], "run must stop after the failing step");
    assert.equal(result.ok, false, "result.ok must be false");
    assert.equal(result.failedStep, 1, "failedStep must be the index of the bad step");
    assert.equal(result.error, err, "result.error must be the thrown error");
  });

  it("prints ✖ <label> — <message> on failure", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "Crash step", run: async () => { throw new Error("connection refused"); } },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(out.includes("✖ Crash step — connection refused\n"),
      "failure output must include '✖ <label> — <message>'");
  });

  it("does NOT print a stack trace on failure", async () => {
    const stream = makeStream();
    const err = new Error("oops");
    await runSteps([
      { label: "Erroring step", run: async () => { throw err; } },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(!out.includes("at "), "stack trace lines ('at ...') must not appear in output");
  });

  it("prints elapsed-time failure summary line", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "Fail", run: async () => { throw new Error("err"); } },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(
      /✖ Failed in \d+\.\d+s/.test(out),
      "output must include '✖ Failed in X.Xs' elapsed summary on failure",
    );
  });

  it("returns elapsed on failure", async () => {
    const stream = makeStream();
    const result = await runSteps([
      { label: "Fail", run: async () => { throw new Error("err"); } },
    ], { stream, _forceNoAnsi: true });

    assert.equal(typeof result.elapsed, "number");
    assert.ok(result.elapsed >= 0);
  });
});

describe("runSteps — non-TTY: no ANSI escape codes in output", () => {
  it("output contains no ANSI CSI sequences", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "Step 1", run: async () => {} },
      { label: "Step 2", run: async (step) => { step.skip("skipping"); } },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(!/\x1b\[/.test(out),
      "non-TTY output must contain no ANSI escape sequences");
  });

  it("failure output contains no ANSI CSI sequences", async () => {
    const stream = makeStream();
    await runSteps([
      { label: "Bad step", run: async () => { throw new Error("nope"); } },
    ], { stream, _forceNoAnsi: true });

    const out = stream.output();
    assert.ok(!/\x1b\[/.test(out),
      "non-TTY failure output must contain no ANSI escape sequences");
  });
});

describe("runSteps — non-TTY: step.progress() is a no-op", () => {
  it("does not throw when step.progress() is called", async () => {
    const stream = makeStream();
    await assert.doesNotReject(
      () => runSteps([
        {
          label: "Progress step",
          run: async (step) => {
            for (let i = 0; i <= 10; i++) step.progress(i, 10);
          },
        },
      ], { stream, _forceNoAnsi: true }),
      "step.progress() must not throw in non-TTY mode",
    );
  });
});

describe("runSteps — non-TTY: step.note() is a no-op", () => {
  it("does not throw when step.note() is called", async () => {
    const stream = makeStream();
    await assert.doesNotReject(
      () => runSteps([
        {
          label: "Note step",
          run: async (step) => { step.note("loading config…"); },
        },
      ], { stream, _forceNoAnsi: true }),
      "step.note() must not throw in non-TTY mode",
    );
  });
});

// ---------------------------------------------------------------------------
// renderLogo — fallback chain (NO_COLOR / non-TTY environment)
//
// In the test runner, process.stdout.isTTY is false (non-TTY), so USE_ANSI
// and USE_TRUECOLOR in tui.mjs are both false. renderLogo() must return plain
// text with no ANSI escape codes in this environment.
// ---------------------------------------------------------------------------

describe("renderLogo — plain-text fallback in non-TTY/NO_COLOR environment", () => {
  it("returns a non-empty string", () => {
    const result = renderLogo({});
    assert.ok(typeof result === "string" && result.length > 0,
      "renderLogo() must return a non-empty string");
  });

  it("contains no ANSI escape sequences in non-TTY environment (USE_TRUECOLOR=false)", () => {
    // In the test runner process.stdout.isTTY is false, so USE_ANSI and
    // USE_TRUECOLOR are both false. renderLogo() must return plain text only.
    const result = renderLogo({});
    assert.ok(!result.includes("\x1b["),
      "renderLogo() must not contain ANSI escape sequences when USE_TRUECOLOR is false");
  });

  it("includes 'ForgeDock' in the plain-text output", () => {
    const result = renderLogo({});
    assert.ok(result.includes("ForgeDock"),
      "plain-text output must include the word 'ForgeDock'");
  });

  it("includes version string when version is provided", () => {
    const result = renderLogo({ version: "1.2.3" });
    assert.ok(result.includes("1.2.3"),
      "plain-text output must include the provided version string");
  });

  it("includes tagline in the plain-text output", () => {
    const result = renderLogo({});
    assert.ok(result.includes("GitHub as a knowledge graph for AI agents"),
      "plain-text output must include the tagline");
  });

  it("works with no arguments (version defaults to empty string)", () => {
    assert.doesNotThrow(() => renderLogo(),
      "renderLogo() must not throw when called with no arguments");
    const result = renderLogo();
    assert.ok(result.includes("ForgeDock"),
      "renderLogo() with no args must still include 'ForgeDock'");
  });
});

// ---------------------------------------------------------------------------
// renderLogo — context-based tagline selection
// ---------------------------------------------------------------------------

describe("renderLogo — context-based tagline", () => {
  it("selects the doctor tagline when context is 'doctor'", () => {
    const result = renderLogo({ context: "doctor" });
    assert.ok(result.includes("inspecting the anvil"),
      "context 'doctor' must select its mapped tagline");
    assert.ok(!result.includes("GitHub as a knowledge graph for AI agents"),
      "context 'doctor' must not fall back to the default tagline");
  });

  it("selects distinct taglines for install/update/uninstall/status", () => {
    assert.ok(renderLogo({ context: "install" }).includes("lighting the forge"));
    assert.ok(renderLogo({ context: "update" }).includes("tempering the blade"));
    assert.ok(renderLogo({ context: "uninstall" }).includes("banking the coals"));
    assert.ok(renderLogo({ context: "status" }).includes("reading the heat"));
  });

  it("falls back to the default tagline for an unmapped context", () => {
    const result = renderLogo({ context: "some-unknown-command" });
    assert.ok(result.includes("GitHub as a knowledge graph for AI agents"),
      "unmapped context must fall back to the default tagline");
  });

  it("falls back to the default tagline when context is omitted", () => {
    const result = renderLogo({ version: "1.2.3" });
    assert.ok(result.includes("GitHub as a knowledge graph for AI agents"),
      "omitted context must fall back to the default tagline");
  });

  it("falls back to the default tagline for Object.prototype-colliding contexts", () => {
    for (const context of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const result = renderLogo({ context });
      assert.ok(result.includes("GitHub as a knowledge graph for AI agents"),
        `context '${context}' must fall back to the default tagline, not a prototype member`);
      assert.ok(!/\[native code\]/.test(result),
        `context '${context}' must not leak a native-code function string`);
      assert.ok(!result.includes("function Object()"),
        `context '${context}' must not leak the Object constructor's string form`);
    }
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
