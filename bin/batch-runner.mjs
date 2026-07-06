#!/usr/bin/env node
/**
 * bin/batch-runner.mjs — Batch driver for the ForgeDock pipeline eval harness (#1285)
 *
 * Iterates a corpus of GitHub issue numbers, invokes runCommand() (from
 * bin/runner.mjs) for each issue against the /work-on spec, and writes a
 * structured per-run results file consumable by scripts/eval-gate-scorecard.mjs.
 *
 * This is the batch/corpus increment of the standalone runtime — the natural
 * next step after bin/runner.mjs's single-command foundational increment (#1151).
 *
 * Exports (all pure, no SDK, no network):
 *   loadCorpus(path)                           → {corpus_version, issues}
 *   makeRunResult(issue, status, opts)         → RunResult object
 *   classifyRunnerResult(result)               → "success" | "failure" | "incomplete"
 *   writeResults(outputPath, results, meta)    → void
 *   runCorpus(opts)                            → Promise<RunResult[]>
 *
 * CLI usage:
 *   node bin/batch-runner.mjs <corpus.json> [output.json]
 *   node bin/batch-runner.mjs <corpus.json> [output.json] --dry-run
 *
 *   ANTHROPIC_API_KEY must be set for live runs.
 *   FORGEDOCK_MODEL overrides the model (default: runner.mjs default).
 *
 * Corpus file format (docs/spec/eval-run-result.md):
 *   { "corpus_version": "v1", "issues": [1001, 1002, 1003] }
 *
 * Output file format:
 *   { "corpus_version": "v1", "runs": [ ...RunResult ] }
 *
 * See docs/spec/eval-run-result.md for the full JSON schema.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

/**
 * Load and validate a corpus JSON file.
 *
 * Throws a descriptive Error if the file is missing, invalid JSON, or does not
 * contain a non-empty integer array at the "issues" key.
 *
 * @param {string} corpusPath - Absolute or relative path to the corpus JSON.
 * @returns {{ corpus_version: string|null, issues: number[] }}
 */
export function loadCorpus(corpusPath) {
  let raw;
  try {
    raw = readFileSync(corpusPath, "utf-8");
  } catch (e) {
    throw new Error(`Cannot read corpus file "${corpusPath}": ${e.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Corpus file "${corpusPath}" contains invalid JSON: ${e.message}`);
  }

  if (!data || typeof data !== "object") {
    throw new Error(`Corpus file must be a JSON object; got ${typeof data}`);
  }
  if (!Array.isArray(data.issues) || data.issues.length === 0) {
    throw new Error(`Corpus file must contain a non-empty "issues" array`);
  }
  for (let i = 0; i < data.issues.length; i++) {
    const n = data.issues[i];
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `issues[${i}]: must be a positive integer (got ${JSON.stringify(n)})`,
      );
    }
  }

  return {
    corpus_version: data.corpus_version ?? null,
    issues: data.issues,
  };
}

// ---------------------------------------------------------------------------
// Run-result construction helpers
// ---------------------------------------------------------------------------

/**
 * Map a runCommand() result status + stop reason to a scorecard status.
 *
 * runCommand() returns:
 *   status: "complete" | "incomplete" | "dry-run" | "max-iterations"
 *
 * We map these to the eval-result schema's status:
 *   "success"    — run completed cleanly (status "complete")
 *   "incomplete" — run was cut short (status "incomplete" or "max-iterations" or "dry-run")
 *
 * The caller is responsible for "failure" — that requires inspecting GitHub
 * state (whether the issue reached workflow:merged). For the purposes of the
 * batch driver, a clean runner completion is classified as "success"; the
 * scorecard consumer or a post-run hook can downgrade to "failure" by
 * inspecting the issue label state.
 *
 * @param {{ status: string, stopReason?: string }} result
 * @returns {"success" | "incomplete"}
 */
export function classifyRunnerResult(result) {
  if (result.status === "complete") return "success";
  return "incomplete";
}

/**
 * Construct a per-run result object conforming to docs/spec/eval-run-result.md.
 *
 * @param {number} issue - GitHub issue number.
 * @param {"success"|"failure"|"incomplete"|"error"} status
 * @param {object} [opts]
 * @param {number} [opts.wallClockMs]        - Wall-clock duration (ms).
 * @param {number} [opts.interventionCount]  - Human intervention count.
 * @param {number|null} [opts.cost]          - Token cost (null until #1255).
 * @param {number} [opts.iterations]         - Tool-loop iteration count.
 * @param {string} [opts.stopReason]         - Anthropic stop_reason or "max_iterations".
 * @param {string|null} [opts.error]         - Error message when status === "error".
 * @param {string} [opts.specVersion]        - Package version at run time.
 * @param {string} [opts.model]              - Model used.
 * @param {string} [opts.runAt]              - ISO-8601 timestamp.
 * @returns {object}
 */
export function makeRunResult(issue, status, opts = {}) {
  return {
    issue,
    status,
    wallClockMs: opts.wallClockMs ?? 0,
    interventionCount: opts.interventionCount ?? 0,
    cost: opts.cost !== undefined ? opts.cost : null,
    iterations: opts.iterations ?? null,
    stopReason: opts.stopReason ?? null,
    error: opts.error ?? null,
    specVersion: opts.specVersion ?? null,
    model: opts.model ?? null,
    runAt: opts.runAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Output writing
// ---------------------------------------------------------------------------

/**
 * Serialize run results to a JSON file.
 * Creates parent directories as needed.
 *
 * @param {string} outputPath   - Absolute or relative path to write.
 * @param {object[]} results    - Array of per-run result objects.
 * @param {object} [meta]       - Top-level metadata (corpus_version, spec_version, model, corpus_size).
 * @returns {void}
 */
export function writeResults(outputPath, results, meta = {}) {
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const payload = {
    corpus_version: meta.corpus_version ?? null,
    corpus_size: meta.corpus_size ?? null,
    spec_version: meta.spec_version ?? null,
    model: meta.model ?? null,
    generated_at: new Date().toISOString(),
    runs: results,
  };
  writeFileSync(resolved, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Batch orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full corpus headlessly.
 *
 * For each issue number in `corpus.issues`, invokes runCommand() against the
 * /work-on spec in a shared working directory, records a per-run result, and
 * returns the full array of results.
 *
 * Does NOT write output itself — callers should call writeResults() on the
 * returned array. The CLI entry point below does this automatically.
 *
 * @param {object} opts
 * @param {string} opts.commandsDir           - Absolute path to commands/.
 * @param {{ corpus_version: string|null, issues: number[] }} opts.corpus
 * @param {string} [opts.cwd]                 - Working directory for runner (default process.cwd()).
 * @param {string} [opts.apiKey]              - Anthropic API key.
 * @param {string} [opts.model]               - Model id.
 * @param {number} [opts.maxIterations]       - Per-issue tool-loop bound.
 * @param {boolean} [opts.dryRun]             - If true, no API calls are made.
 * @param {{log: Function, error?: Function}} [opts.logger]
 * @returns {Promise<object[]>}               - Array of per-run result objects.
 */
export async function runCorpus(opts = {}) {
  const {
    commandsDir,
    corpus,
    cwd = process.cwd(),
    apiKey = process.env.ANTHROPIC_API_KEY,
    model,
    maxIterations,
    dryRun = false,
    logger = console,
  } = opts;

  // Lazy import of runCommand so this module stays import-safe without the SDK.
  const { runCommand } = await import("./runner.mjs");

  const results = [];

  for (const issue of corpus.issues) {
    logger.log(`[batch-runner] Starting issue #${issue}…`);
    const startMs = Date.now();
    let result;
    try {
      result = await runCommand({
        commandsDir,
        commandName: "work-on",
        args: [String(issue)],
        cwd,
        apiKey,
        ...(model ? { model } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        dryRun,
        logger,
      });
      const wallClockMs = Date.now() - startMs;
      const status = classifyRunnerResult(result);
      results.push(
        makeRunResult(issue, status, {
          wallClockMs,
          interventionCount: 0,
          cost: null, // wired in once #1255 lands
          iterations: result.iterations ?? null,
          stopReason: result.stopReason ?? null,
          model: model ?? result.model ?? null,
          runAt: new Date().toISOString(),
        }),
      );
      logger.log(`[batch-runner] Issue #${issue} → ${status} (${wallClockMs}ms)`);
    } catch (e) {
      const wallClockMs = Date.now() - startMs;
      results.push(
        makeRunResult(issue, "error", {
          wallClockMs,
          interventionCount: 0,
          cost: null,
          error: e.message,
          model: model ?? null,
          runAt: new Date().toISOString(),
        }),
      );
      logger.error
        ? logger.error(`[batch-runner] Issue #${issue} → error: ${e.message}`)
        : logger.log(`[batch-runner] Issue #${issue} → error: ${e.message}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const [, , corpusArg, outputArg, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");

  if (!corpusArg) {
    process.stderr.write(
      "Usage: node bin/batch-runner.mjs <corpus.json> [output.json] [--dry-run]\n",
    );
    process.exit(1);
  }

  // Resolve paths relative to cwd of the calling shell, not __dirname.
  const corpusPath = resolve(corpusArg);
  const outputPath = outputArg ? resolve(outputArg) : resolve("eval-results.json");

  let corpus;
  try {
    corpus = loadCorpus(corpusPath);
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(1);
  }

  // commandsDir: sibling of bin/ at the repo root.
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const binDir = dirname(fileURLToPath(import.meta.url));
  const commandsDir = join(binDir, "..", "commands");

  // Read package version for specVersion field.
  let specVersion = null;
  try {
    const pkgPath = join(binDir, "..", "package.json");
    specVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? null;
  } catch {
    // non-fatal — specVersion stays null
  }

  console.log(
    `[batch-runner] Running ${corpus.issues.length} issue(s) from corpus "${corpus.corpus_version ?? "(no version)"}"${dryRun ? " (dry-run)" : ""}`,
  );

  const results = await runCorpus({
    commandsDir,
    corpus,
    dryRun,
    logger: console,
  });

  const meta = {
    corpus_version: corpus.corpus_version,
    corpus_size: corpus.issues.length,
    spec_version: specVersion,
    model: results.find((r) => r.model)?.model ?? null,
  };

  writeResults(outputPath, results, meta);
  console.log(`[batch-runner] Results written to ${outputPath}`);

  const nSuccess = results.filter((r) => r.status === "success").length;
  const nTotal = results.length;
  console.log(`[batch-runner] ${nSuccess}/${nTotal} runs succeeded`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
