#!/usr/bin/env node
/**
 * bin/hooks/interactive-engine.mjs — ForgeDock SubagentStop hook.
 *
 * Interactive engine adapter (issue #1323): bridges the interactive
 * /work-on path to the durable engine core so that interactive Claude Code
 * sessions write the same run-log + FORGE:STATE as headless runner sessions
 * and are resumable across compaction/context-window resets.
 *
 * === How it works ===
 *
 * Claude Code calls this hook when a subagent (Skill invocation) completes.
 * The hook receives a JSON payload on stdin:
 *
 *   {
 *     "hook_event_name": "SubagentStop",
 *     "session_id": "...",
 *     "transcript_path": "...",   // path to the agent's JSONL transcript
 *     "stop_hook_active": false
 *   }
 *
 * The hook:
 *   1. Reads the transcript to identify which /work-on sub-phase just ran
 *      (the last Skill invocation) and the issue number.
 *   2. Determines the issue number from the FORGE:STATE block on the issue
 *      body (GitHub is the authoritative store).
 *   3. Appends the appropriate PHASE_COMMIT event to the local run-log.
 *   4. Writes the updated FORGE:STATE back to the GitHub issue body.
 *
 * If no /work-on phase is detected (the subagent was something else), the
 * hook exits 0 silently — fail-open.
 *
 * === Phase detection (forge#3570) ===
 *
 * The transcript is used ONLY to identify which /work-on skill ran and for
 * which issue (the `Skill` tool_use input). It is never scanned for FORGE
 * markers: transcript text carries no comment authorship and can quote
 * untrusted commenters or spec files. Whether the phase committed (and whether
 * the run is terminal) is confirmed from GitHub through the engine's trusted,
 * anchored detector (`detectTrustedOutcome` in bin/engine/phases.mjs):
 *
 *   investigate  → trusted FORGE:INVESTIGATOR report (COMPLETE / INVALID / decomposed)
 *   context      → trusted, anchored FORGE:CONTEXT:COMPLETE
 *   architect    → trusted, anchored FORGE:ARCHITECT:COMPLETE
 *   build        → trusted, anchored FORGE:BUILDER:COMPLETE (+ commits ahead)
 *   review/close → their engine detectOutcome (PR state / workflow:merged label)
 *
 * Events are appended only on `status: "committed"`; any GitHub error fails
 * open with no events and no enforcement.
 *
 * === Fail-open contract ===
 *
 * Any uncaught error exits 0 (never blocks a Claude Code session). Errors
 * are written to stderr only — they appear in Claude Code's diagnostic
 * output but do not affect the user's workflow.
 *
 * === Wiring ===
 *
 * Installed into ~/.claude/settings.json under hooks.SubagentStop by
 * `forgedock install` (via bin/settings-hook.mjs).
 * Removed by `forgedock uninstall`.
 */

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { PHASE_MARKERS as PHASE_MARKER_REGISTRY } from "../../packages/protocol/src/phases.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Absolute path to the ForgeDock installation root (parent of bin/). */
const FORGE_HOME = resolve(__dirname, "..", "..");

/** Phases whose only failure mode is a missing marker — safe to enforce. */
const ENFORCED_PHASES = ["investigate", "context", "architect", "build"];

// ---------------------------------------------------------------------------
// Main — fail-open wrapper
// ---------------------------------------------------------------------------

// Only auto-run when this file is executed directly as the Claude Code
// SubagentStop hook — not when it's `import`ed (e.g. by tests, to reuse
// parseTranscript/detectPhase/detectLane). Without this guard, importing the
// module for testing would trigger main()'s real gh/git side effects and
// kill the test process via process.exit(0) (issue #1580).
const isDirectExecution =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`[ForgeDock:interactive-engine] ERROR: ${err.message}\n`);
  }
  process.exit(0);
}

async function main() {
  // Read the hook payload from stdin.
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // not a JSON hook payload — ignore
  }

  if (payload.hook_event_name !== "SubagentStop") return;

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) return;

  // Parse the transcript to find the skill invocation and annotations.
  const transcript = parseTranscript(transcriptPath);
  if (!transcript) return;

  const { issueNumber, phaseId } = detectPhase(transcript);
  if (!issueNumber || !phaseId) return; // not a /work-on sub-phase

  // Resolve the run-log directory.
  const runLogDir = resolveRunLogDir();
  if (!runLogDir) return;

  // Import engine modules dynamically (fail-open if missing).
  let appendEvent, deriveState, readLog, makeProjector, reconcileState, detectTrustedOutcome;
  try {
    ({ appendEvent, deriveState, readLog } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "runlog.mjs")).href
    ));
    ({ makeProjector } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "projector.mjs")).href
    ));
    ({ reconcileState } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "reconcile.mjs")).href
    ));
    ({ detectTrustedOutcome } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "phases.mjs")).href
    ));
  } catch (importErr) {
    process.stderr.write(`[ForgeDock:interactive-engine] engine modules unavailable: ${importErr.message}\n`);
    return;
  }

  // Build a minimal io adapter using the gh CLI.
  const io = makeCliIo();

  // Load or reconcile state. Everything up to the trusted outcome check is
  // read-only: no event is written unless GitHub confirms the phase committed.
  const projector = makeProjector(io);
  const local = readLog(runLogDir, issueNumber).length
    ? deriveState(readLog(runLogDir, issueNumber))
    : null;
  let state, bootstrapped = false;
  let outcome;
  try {
    const remote = await projector.readState(issueNumber);
    ({ state } = reconcileState(local, remote));

    if (!state) {
      // Fresh run — bootstrap in memory only.
      const lane = detectLane(transcript) || "staging";
      state = {
        v: 0,
        run: `r_${issueNumber}_${lane}_interactive`,
        issue: issueNumber,
        lane,
        committed: [],
        phase: null,
        branch: null,
        pr: null,
        terminal: false,
        terminalReason: null,
        lease: null,
      };
      bootstrapped = true;
    }

    // Skip if phase already committed (idempotent) — before the GitHub call.
    if (state.committed.includes(phaseId)) return;

    // forge#3570: ground truth from trusted, anchored GitHub comments — never transcript text.
    outcome = await detectTrustedOutcome(phaseId, state, io);
  } catch (checkErr) {
    // Fail open: no events, no enforcement.
    process.stderr.write(`[ForgeDock:interactive-engine] trusted outcome check failed: ${checkErr.message}\n`);
    return;
  }

  if (!outcome || outcome.status !== "committed") {
    // --- Annotation enforcement (#1250) ---
    // Skill ran but no trusted, anchored annotation exists on GitHub: block the
    // subagent and inject corrective context. Only for phases whose failure is
    // exactly "missing marker".
    if (ENFORCED_PHASES.includes(phaseId)) {
      const PHASE_ANNOTATION_MAP = {
        investigate: `${PHASE_MARKER_REGISTRY.investigate.completionMarker} (or ${PHASE_MARKER_REGISTRY.investigate.invalidMarker} / ${PHASE_MARKER_REGISTRY.investigate.decomposedMarker})`,
        context:     PHASE_MARKER_REGISTRY.context.completionMarker,
        architect:   PHASE_MARKER_REGISTRY.architect.completionMarker,
        build:       PHASE_MARKER_REGISTRY.build.completionMarker,
      };
      const expected = PHASE_ANNOTATION_MAP[phaseId] || `the ${phaseId} phase annotation`;
      // Output additionalContext JSON (v2.1.163+ SubagentStop format).
      const feedback = {
        decision: "block",
        reason: `[ForgeDock] Phase "${phaseId}" completed without posting its FORGE annotation.`,
        additionalContext: [
          `The ${phaseId} phase must post annotation: ${expected}`,
          `Post this annotation now via gh issue comment, then re-complete this phase.`,
          `This is a pipeline enforcement check — annotation-free completions are not tracked`,
          `and cannot be resumed across compaction events.`,
        ].join("\n"),
      };
      process.stdout.write(JSON.stringify(feedback) + "\n");
      process.exit(2);
    }
    return;
  }

  const terminalReason = outcome.terminalReason || null;

  if (bootstrapped) {
    appendEvent(runLogDir, issueNumber, {
      event: "RUN_START",
      issue: issueNumber,
      run: state.run,
      lane: state.lane,
      source: "interactive",
    });
  }

  // Append the PHASE_COMMIT event (outputs come from the GitHub-derived outcome).
  appendEvent(runLogDir, issueNumber, {
    event: "PHASE_COMMIT",
    phase: phaseId,
    outputs: outcome.outputs || {},
    source: "interactive",
  });
  state = deriveState(readLog(runLogDir, issueNumber));

  if (terminalReason) {
    appendEvent(runLogDir, issueNumber, {
      event: "RUN_TERMINAL",
      reason: terminalReason,
      source: "interactive",
    });
    state = deriveState(readLog(runLogDir, issueNumber));
    state = { ...state, terminal: true, terminalReason, lease: null };
  }

  // Mirror to GitHub FORGE:STATE.
  try {
    await projector.writeState(issueNumber, state);
  } catch (writeErr) {
    process.stderr.write(`[ForgeDock:interactive-engine] FORGE:STATE write failed: ${writeErr.message}\n`);
    // Non-fatal: run-log is the crash-safe local record; GitHub mirror is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSONL transcript file.
 * Returns an array of transcript entries, or null on error.
 */
export function parseTranscript(transcriptPath) {
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    return lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Identify the /work-on phase that ran and the issue number from the `Skill`
 * tool_use input ONLY (forge#3570).
 *
 * Transcript text (tool results, assistant prose) is deliberately never scanned
 * for FORGE markers: it carries no comment authorship and routinely quotes
 * untrusted commenters or spec files, so it must not decide committed/terminal
 * state. The caller confirms the outcome from GitHub via `detectTrustedOutcome`.
 *
 * `outputs` stays `{}` (forge#2375): branch/PR are never derived from transcript text.
 *
 * @param {object[]} entries
 * @returns {{ issueNumber: number|null, phaseId: string|null, outputs: object, skillInvoked: boolean }}
 */
export function detectPhase(entries) {
  let skillName = null;
  let issueNumber = null;
  let skillInvoked = false;

  for (const entry of entries) {
    // Real Claude Code transcript entries nest role/content under `entry.message`;
    // fall back to a flat/legacy shape (issue #1580).
    const message = entry && typeof entry === "object" && entry.message ? entry.message : entry;
    const contentBlocks = Array.isArray(message?.content) ? message.content : [];

    for (const block of contentBlocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use" && block.name === "Skill") {
        const input = block.input || {};
        if (input.skill) { skillName = input.skill; skillInvoked = true; }
        // Extract issue number from args (e.g. "1323" or "#1323").
        if (input.args) {
          const m = String(input.args).match(/\b(\d{3,6})\b/);
          if (m) issueNumber = parseInt(m[1], 10);
        }
      }
    }
  }

  const phaseId = skillName ? phaseFromSkill(skillName) : null;
  return { issueNumber, phaseId, outputs: {}, skillInvoked };
}

/**
 * Map a Skill name to a phase ID.
 *
 * Real Skill() invocations use colon-separated names (e.g. "work-on:build:context",
 * matching the registered skill catalog and commands/work-on/build.md's exception-path
 * invocations). Some spec prose still uses slash-separated names (e.g. "work-on/build"),
 * so the input is normalized to colons before lookup — this keeps the fallback working
 * regardless of which convention a given caller followed (issue #1525).
 * @param {string} skill
 * @returns {string|null}
 */
export function phaseFromSkill(skill) {
  const normalized = String(skill || "").replace(/\//g, ":");
  const map = {
    "work-on:investigate": "investigate",
    "work-on:build:context": "context",
    "work-on:build:architect": "architect",
    "work-on:build": "build",
    "work-on:review": "review",
    "work-on:close": "close",
  };
  return map[normalized] || null;
}

/**
 * Detect the pipeline lane from transcript tool results.
 * Looks for branch names or milestone labels that imply feature vs staging lane.
 */
export function detectLane(entries) {
  for (const entry of entries) {
    // Same nested-schema normalization as detectPhase() — tool_result blocks
    // live under entry.message.content[], not at entry's own top level
    // (sibling of the #1580 bug: this function had the identical mistake).
    const message = entry && typeof entry === "object" && entry.message ? entry.message : entry;
    const contentBlocks = Array.isArray(message?.content) ? message.content : [];

    for (const block of contentBlocks) {
      if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
      const content = Array.isArray(block.content)
        ? block.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n")
        : String(block.content || "");
      if (/milestone\//.test(content)) return "feature";
      if (/staging/.test(content)) return "staging";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run-log directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the directory where run-log JSONL files are stored.
 * Uses .forgedock/run-logs/ in the current working directory,
 * or FORGE_RUN_LOG_DIR env override for testing.
 */
function resolveRunLogDir() {
  if (process.env.FORGE_RUN_LOG_DIR) return process.env.FORGE_RUN_LOG_DIR;
  const cwd = process.cwd();
  // Prefer .forgedock/ if it exists (managed project).
  const managed = join(cwd, ".forgedock", "run-logs");
  // Fall back to a temp-like XDG path.
  return managed;
}

// ---------------------------------------------------------------------------
// CLI io adapter
// ---------------------------------------------------------------------------

/**
 * Build an io object that delegates gh/git calls to the CLI.
 * Used by makeProjector to read/write FORGE:STATE on GitHub.
 */
function makeCliIo() {
  function runCli(cmd, args) {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
    } catch (e) {
      throw new Error(`${cmd} ${args.join(" ")}: ${e.stderr || e.message}`);
    }
  }

  return {
    gh: async (args) => runCli("gh", args),
    git: async (args) => runCli("git", args),
  };
}

// ---------------------------------------------------------------------------
// stdin reader
// ---------------------------------------------------------------------------

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
    // Timeout: if stdin has no data after 2s, resolve empty.
    setTimeout(() => resolve(buf), 2000);
  });
}
