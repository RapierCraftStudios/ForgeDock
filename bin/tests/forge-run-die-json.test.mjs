/**
 * bin/tests/forge-run-die-json.test.mjs
 *
 * Regression test for #2216: scripts/forge-run.sh die() emitted invalid JSON
 * when interpolating raw `gh` CLI stderr that contains backslashes or newlines
 * (e.g. a multi-line auth-failure message on Windows paths).
 *
 * die() previously escaped only double quotes before embedding the message
 * into a hand-built JSON string. It did not escape backslashes (so a literal
 * `\` in the message broke the JSON grammar) and did not escape newlines
 * (raw `\n` bytes are invalid inside a JSON string literal). The fix routes
 * die() through the shared json_str() helper, extended to also escape
 * `\n`/`\r`/`\t`.
 *
 * This test stubs `gh` on PATH to simulate a multi-line, backslash-bearing
 * auth-failure message, spawns forge-run.sh via bash (mirrors the script's
 * own `#!/usr/bin/env bash` shebang — works under Git Bash on Windows and
 * natively on Linux CI), and asserts the emitted NDJSON `error` line parses
 * as valid JSON.
 *
 * Run with: node --test bin/tests/forge-run-die-json.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const FORGE_RUN_SH = join(REPO_ROOT, "scripts", "forge-run.sh");

/**
 * Simulated `gh` auth-failure stderr: multi-line, and includes a literal
 * backslash (a Windows-style path) — the exact combination that broke die()'s
 * quote-only escaping before this fix.
 */
const FAKE_GH_STDERR = [
  "gh: authentication failed",
  String.raw`config path: C:\Users\builder\.config\gh\hosts.yml`,
  "please run: gh auth login",
].join("\n");

/**
 * Write a stub `gh` executable to `binDir` that always fails with
 * FAKE_GH_STDERR on stderr, regardless of arguments.
 */
function makeFakeGhStub(binDir) {
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, "gh");
  // Emit each fixture line via its own `printf '%s\n'` call so the resulting
  // stderr contains REAL newline bytes between lines. Embedding the whole
  // multi-line fixture as a single JSON-stringified argument would instead
  // produce a literal two-character "\n" sequence (printf's %s does not
  // interpret backslash escapes in its argument) — that would test a
  // different bug than the one this regression covers.
  const printfLines = FAKE_GH_STDERR.split("\n")
    .map((line) => `printf '%s\\n' ${JSON.stringify(line)} >&2`)
    .join("\n");
  const script = ["#!/usr/bin/env bash", printfLines, "exit 1", ""].join("\n");
  writeFileSync(stubPath, script, "utf-8");
  chmodSync(stubPath, 0o755);
  return stubPath;
}

/**
 * Run forge-run.sh via bash with a stubbed `gh` prepended to PATH.
 * Returns { stdout, stderr, status }.
 */
function runForgeRun(args, fakeGhBinDir) {
  const result = spawnSync("bash", [FORGE_RUN_SH, ...args], {
    encoding: "utf-8",
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${fakeGhBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    },
  });
  return result;
}

/**
 * Extract the last non-empty NDJSON line from stdout.
 */
function lastJsonLine(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

describe("forge-run.sh die() — JSON validity for gh stderr (forge#2216)", async () => {
  let tmpDir;
  let fakeGhBinDir;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-run-die-json-"));
    fakeGhBinDir = join(tmpDir, "fake-gh-bin");
    makeFakeGhStub(fakeGhBinDir);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a valid, parseable JSON error line for multi-line gh stderr with a backslash", () => {
    const result = runForgeRun(["work-on", "123", "-R", "acme-org/acme-repo"], fakeGhBinDir);

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);

    const line = lastJsonLine(result.stdout);
    assert.ok(line, `expected at least one NDJSON line on stdout; got: ${JSON.stringify(result.stdout)}`);

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `expected the emitted line to be valid JSON, got: ${line}`);

    assert.equal(parsed.event, "error");
    assert.equal(parsed.code, "GH_FETCH_FAILED");
  });

  it("preserves the underlying auth-failure message content (unescaped for the reader)", () => {
    const result = runForgeRun(["work-on", "456", "-R", "acme-org/acme-repo"], fakeGhBinDir);
    const parsed = JSON.parse(lastJsonLine(result.stdout));

    assert.match(parsed.message, /authentication failed/);
    assert.match(parsed.message, /gh auth login/);
  });

  it("round-trips the embedded newlines as literal \\n escape sequences, not raw control bytes", () => {
    const result = runForgeRun(["work-on", "789", "-R", "acme-org/acme-repo"], fakeGhBinDir);
    const line = lastJsonLine(result.stdout);

    // The raw NDJSON line itself must be a single line — no unescaped newline
    // bytes leaked from the multi-line gh stderr into the middle of the JSON.
    assert.equal(result.stdout.trimEnd().split("\n").filter(Boolean).length >= 1, true);

    const parsed = JSON.parse(line);
    // After JSON.parse, the escaped \n sequences decode back into real newlines,
    // so the multi-line structure of the original stderr is preserved in .message.
    assert.equal(parsed.message.split("\n").length, FAKE_GH_STDERR.split("\n").length);
  });

  it("round-trips a literal backslash from the Windows-style path without corruption", () => {
    const result = runForgeRun(["work-on", "101", "-R", "acme-org/acme-repo"], fakeGhBinDir);
    const parsed = JSON.parse(lastJsonLine(result.stdout));

    assert.match(parsed.message, /C:\\Users\\builder\\.config\\gh\\hosts\.yml/);
  });
});

/**
 * Regression test for #2264: json_str() escaped backslash, double-quote, and
 * \n/\r/\t (added by #2216) but not the rest of the C0 control range
 * (U+0000-U+001F per RFC 8259 section 7). A raw control byte such as U+0001
 * (SOH) or U+001F (US) embedded in `gh` CLI stderr survived un-escaped into
 * the emitted NDJSON line, producing invalid JSON.
 *
 * This drives the exact same die()/GH_FETCH_FAILED path as the #2216 tests
 * above, but with a stub `gh` that emits raw C0 control bytes outside the
 * \n/\r/\t set already covered. Uses printf's POSIX octal escapes (\001,
 * \037) inside the stub script for portable, unambiguous byte emission
 * under both Git Bash (Windows) and native Linux bash.
 */
describe("forge-run.sh json_str() — full C0 control-character escaping (forge#2264)", async () => {
  let tmpDir;
  let fakeGhBinDir;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-run-c0-escape-"));
    fakeGhBinDir = join(tmpDir, "fake-gh-bin");
    mkdirSync(fakeGhBinDir, { recursive: true });
    const stubPath = join(fakeGhBinDir, "gh");
    // \001 = U+0001 (SOH), \037 = U+001F (US, the last C0 code point) — both
    // outside the \n(\012)/\r(\015)/\t(\011) set json_str() already escaped
    // before this fix. POSIX octal escapes in printf's format string are
    // portable across Git Bash and native Linux bash, unlike embedding a raw
    // byte literal in the JS source.
    const script = [
      "#!/usr/bin/env bash",
      "printf 'gh: parse error\\001in\\037response\\n' >&2",
      "exit 1",
      "",
    ].join("\n");
    writeFileSync(stubPath, script, "utf-8");
    chmodSync(stubPath, 0o755);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a valid, parseable JSON error line when gh stderr contains C0 control bytes outside \\n/\\r/\\t", () => {
    const result = runForgeRun(["work-on", "202", "-R", "acme-org/acme-repo"], fakeGhBinDir);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);

    const line = lastJsonLine(result.stdout);
    assert.ok(line, `expected at least one NDJSON line on stdout; got: ${JSON.stringify(result.stdout)}`);

    // The raw emitted line itself must not contain a literal, unescaped
    // control byte (U+0000-U+001F) — that is exactly what made the pre-fix
    // JSON invalid. Any surviving raw control byte here means json_str()
    // failed to escape it.
    for (let i = 0; i <= 0x1f; i++) {
      if (i === 0x0a) continue; // NDJSON line-terminator itself is fine between events
      assert.equal(
        line.includes(String.fromCharCode(i)),
        false,
        `expected no raw U+${i.toString(16).padStart(4, "0")} control byte in the emitted line, got: ${JSON.stringify(line)}`,
      );
    }

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `expected the emitted line to be valid JSON, got: ${line}`);

    assert.equal(parsed.event, "error");
    // Round-trip: after JSON.parse, the escaped / sequences
    // decode back into the original control characters, so the original
    // message content (including the control bytes) is preserved.
    assert.equal(parsed.message, "failed to fetch issue #202: gh: parse error\x01in\x1fresponse");
  });
});

/**
 * Regression test for #2265: the `action_required` event's ACTION_ESCAPED
 * value used a hand-rolled quote-only escape (`${ACTION//\"/\\\"}`) instead
 * of being routed through json_str() — the same inconsistency #2216 fixed
 * for die(), missed at this one call site.
 *
 * Under forge-run.sh's current control flow, every `$ACTION` value assigned
 * in the PHASE detection logic is a static string literal (see FORGE:ARCHITECT
 * on issue #2270) — there is no reachable end-to-end path today that feeds
 * an attacker/gh-controlled backslash or control byte into $ACTION. To still
 * prove this exact fix against the *real* source (not a reimplementation),
 * this test extracts the actual `json_str()` function body and the actual
 * `ACTION_ESCAPED=...` assignment line out of scripts/forge-run.sh via
 * regex, sources them into a throwaway bash script alongside a synthetic
 * $ACTION containing a backslash, a double quote, and a control byte, and
 * asserts the resulting escaped value is valid when embedded in a JSON
 * string. Pre-fix, ACTION_ESCAPED="${ACTION//\"/\\\"}" leaves the backslash
 * and control byte unescaped, producing invalid JSON — this test fails
 * against that code. Post-fix, ACTION_ESCAPED=$(json_str "${ACTION}")
 * produces valid JSON — this test passes.
 */
describe("forge-run.sh ACTION_ESCAPED — routed through json_str() (forge#2265)", async () => {
  const source = readFileSync(FORGE_RUN_SH, "utf-8");

  function extractFunctionSource(fnName) {
    const startMarker = `${fnName}() {`;
    const startIdx = source.indexOf(startMarker);
    assert.ok(startIdx !== -1, `expected to find ${fnName}() definition in scripts/forge-run.sh`);
    const endIdx = source.indexOf("\n}", startIdx);
    assert.ok(endIdx !== -1, `expected to find closing brace for ${fnName}() in scripts/forge-run.sh`);
    return source.slice(startIdx, endIdx + 2);
  }

  function extractActionEscapedLine() {
    const match = source.match(/^\s*ACTION_ESCAPED=.*$/m);
    assert.ok(match, "expected to find an ACTION_ESCAPED=... assignment line in scripts/forge-run.sh");
    return match[0].trim();
  }

  it("produces a JSON-safe value for $ACTION containing a backslash, a quote, and a control byte", () => {
    const jsonStrSource = extractFunctionSource("json_str");
    const actionEscapedLine = extractActionEscapedLine();

    // Fail loudly (not silently pass) if the source no longer contains a
    // *single* recognizable ACTION_ESCAPED assignment — e.g. if a future
    // refactor removes the variable outright. This keeps the test coupled
    // to the real call site rather than a hardcoded copy of the old line.
    assert.match(
      actionEscapedLine,
      /^ACTION_ESCAPED=/,
      `expected ACTION_ESCAPED assignment line to start with ACTION_ESCAPED=, got: ${actionEscapedLine}`,
    );

    const tmpDir = mkdtempSync(join(os.tmpdir(), "forge-run-action-escaped-"));
    try {
      const harnessPath = join(tmpDir, "harness.sh");
      const harness = [
        "#!/usr/bin/env bash",
        jsonStrSource,
        // Synthetic ACTION: backslash, double quote, and SOH (U+0001) control byte.
        "ACTION=$(printf 'go to \\\\path \"quoted\" \\001stop')",
        actionEscapedLine,
        'printf \'%s\' "$ACTION_ESCAPED"',
        "",
      ].join("\n");
      writeFileSync(harnessPath, harness, "utf-8");
      chmodSync(harnessPath, 0o755);

      const result = spawnSync("bash", [harnessPath], { encoding: "utf-8", timeout: 15000 });
      assert.equal(result.status, 0, `harness script failed: ${result.stderr}`);

      const escaped = result.stdout;
      const wrapped = `"${escaped}"`;

      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(wrapped);
      }, `expected ACTION_ESCAPED to be embeddable in a JSON string, got: ${JSON.stringify(escaped)}`);

      assert.equal(parsed, 'go to \\path "quoted" \x01stop');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
