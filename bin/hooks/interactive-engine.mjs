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
 *      (by scanning the last Skill invocation and the FORGE annotations
 *      written to GitHub).
 *   2. Determines the issue number from the FORGE:STATE block on the issue
 *      body (GitHub is the authoritative store).
 *   3. Appends the appropriate PHASE_COMMIT event to the local run-log.
 *   4. Writes the updated FORGE:STATE back to the GitHub issue body.
 *
 * If no /work-on phase is detected (the subagent was something else), the
 * hook exits 0 silently — fail-open.
 *
 * === Phase detection ===
 *
 * The hook looks for FORGE annotation markers in the transcript's tool
 * results (gh issue comment / gh api calls):
 *
 *   INVESTIGATION:COMPLETE     → phase "investigate" committed
 *   FORGE:CONTEXT:COMPLETE     → phase "context" committed
 *   FORGE:ARCHITECT:COMPLETE   → phase "architect" committed
 *   FORGE:BUILDER:COMPLETE     → phase "build" committed
 *   FORGE:REVIEWER          → phase "review" committed
 *   workflow:merged label   → phase "close" committed (terminal)
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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Absolute path to the ForgeDock installation root (parent of bin/). */
const FORGE_HOME = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Phase marker table
// Maps FORGE annotation markers (found in transcript tool results) to phase IDs.
// ---------------------------------------------------------------------------

/** @type {Array<{marker: string, phase: string, terminal?: boolean, terminalReason?: string}>} */
const PHASE_MARKERS = [
  { marker: "INVESTIGATION:COMPLETE",   phase: "investigate" },
  { marker: "INVESTIGATION:INVALID",    phase: "investigate", terminal: true, terminalReason: "invalid" },
  { marker: "DECOMPOSE:YES",            phase: "investigate", terminal: true, terminalReason: "decomposed" },
  // Require the :COMPLETE suffix — a bare "FORGE:CONTEXT"/"FORGE:ARCHITECT"
  // substring also matches a partial/interrupted annotation (e.g.
  // FORGE:CONTEXT:PARTIAL), which is not actually committed. bin/engine/phases.mjs's
  // architect detectOutcome() requires the identical :COMPLETE marker to consider
  // the phase committed (forge#2375 — was drifted from the engine's stricter gate).
  { marker: "FORGE:CONTEXT:COMPLETE",   phase: "context" },
  { marker: "FORGE:ARCHITECT:COMPLETE", phase: "architect" },
  { marker: "FORGE:BUILDER:COMPLETE",   phase: "build" },
  // review phase: PR merged is detected from gh label/state
  { marker: "FORGE:REVIEWER:MERGED",   phase: "review" },
  // close phase: issue closed with workflow:merged
  { marker: "workflow:merged",         phase: "close", terminal: true, terminalReason: "merged" },
];

/**
 * Match a single string of text against the PHASE_MARKERS table and return
 * the phase (and terminal reason) implied by the first marker found, in
 * table order — a terminal marker stops the scan. This is the same
 * marker-matching rule `detectPhase()` applies per-block below, factored
 * out as a standalone export so it can be tested directly against a bare
 * string without needing a full transcript-entries array. Purely additive:
 * `detectPhase()`'s existing multi-entry accumulation algorithm is
 * untouched and does not call this function. See #1592.
 *
 * @param {string} text
 * @returns {{ phaseId: string|null, terminalReason: string|null }}
 */
export function detectPhaseFromText(text) {
  const str = typeof text === "string" ? text : "";
  let phaseId = null;
  let terminalReason = null;
  for (const { marker, phase, terminal, terminalReason: tr } of PHASE_MARKERS) {
    if (str.includes(marker)) {
      phaseId = phase;
      if (terminal) { terminalReason = tr; break; }
    }
  }
  return { phaseId, terminalReason };
}

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

  const { issueNumber, phaseId, terminalReason, outputs, skillInvoked, annotationMissing } = detectPhase(transcript);

  // --- Annotation enforcement (#1250) ---
  // If a /work-on skill was invoked but the expected FORGE annotation is
  // missing, block the subagent from completing silently and inject
  // corrective context so the agent knows what to do.
  if (skillInvoked && annotationMissing && phaseId) {
    const PHASE_ANNOTATION_MAP = {
      investigate: "INVESTIGATION:COMPLETE (or INVESTIGATION:INVALID / DECOMPOSE:YES)",
      context:     "FORGE:CONTEXT:COMPLETE",
      architect:   "FORGE:ARCHITECT:COMPLETE",
      build:       "FORGE:BUILDER:COMPLETE",
      review:      "FORGE:REVIEWER:MERGED",
      close:       "workflow:merged label",
    };
    const expected = PHASE_ANNOTATION_MAP[phaseId] || `the ${phaseId} phase annotation`;
    // Output additionalContext JSON (v2.1.163+ SubagentStop format).
    // Claude Code reads this and injects it as context for the agent.
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
    return;
  }

  if (!issueNumber || !phaseId) return; // not a /work-on sub-phase

  // Resolve the run-log directory.
  const runLogDir = resolveRunLogDir();
  if (!runLogDir) return;

  // Import engine modules dynamically (fail-open if missing).
  let appendEvent, deriveState, readLog, rewriteLog, makeProjector, reconcileState, freshState;
  try {
    ({ appendEvent, deriveState, readLog, rewriteLog } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "runlog.mjs")).href
    ));
    ({ makeProjector } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "projector.mjs")).href
    ));
    ({ reconcileState } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "reconcile.mjs")).href
    ));
  } catch (importErr) {
    process.stderr.write(`[ForgeDock:interactive-engine] engine modules unavailable: ${importErr.message}\n`);
    return;
  }

  // Build a minimal io adapter using the gh CLI.
  const io = makeCliIo();

  // Load or reconcile state.
  const projector = makeProjector(io);
  const local = readLog(runLogDir, issueNumber).length
    ? deriveState(readLog(runLogDir, issueNumber))
    : null;
  const remote = await projector.readState(issueNumber);
  let { state } = reconcileState(local, remote);

  if (!state) {
    // Fresh run — bootstrap.
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
    appendEvent(runLogDir, issueNumber, {
      event: "RUN_START",
      issue: issueNumber,
      run: state.run,
      lane,
      source: "interactive",
    });
  }

  // Skip if phase already committed (idempotent).
  if (state.committed.includes(phaseId)) return;

  // Append the PHASE_COMMIT event.
  appendEvent(runLogDir, issueNumber, {
    event: "PHASE_COMMIT",
    phase: phaseId,
    outputs: outputs || {},
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
 * Detect which /work-on phase completed and the issue number from transcript entries.
 *
 * Strategy:
 *   - Scan tool_use entries for Skill invocations to find the skill name (→ phase)
 *   - Scan tool_result entries for gh CLI output containing FORGE annotation markers
 *   - Extract issue number from Skill args or from the skill name context
 *
 * `outputs` is intentionally always `{}` from this function (forge#2375): earlier
 * versions matched a bare `"number"` field and a bare `branch[:space]` token against
 * the full text of every tool_result block, with no scoping to a FORGE-authoritative
 * source. That regularly matched unrelated JSON (e.g. `gh issue view`'s own `"number"`
 * field, matching the issue's own number as if it were a PR) or unrelated prose
 * containing the word "branch", producing corrupt PHASE_COMMIT run-log entries
 * (observed: `branch:"diff"`, `branch:"writer"`, `branch:"refs"`, `pr:<issue#>`).
 * Those values were also consumed as a state fallback by
 * bin/engine/runlog.mjs:deriveState() → bin/engine/phases.mjs:resolveBranch(), so a
 * corrupt hook-derived value could leak into the engine's own resolution path. The
 * engine already resolves branch/PR from GitHub ground truth
 * (bin/engine/phases.mjs:parseBranchFromMarkers(), scoped to the FORGE:BUILDER:COMPLETE
 * comment — forge#2184) on next pickup, so no replacement extraction is needed here.
 *
 * @param {object[]} entries
 * @returns {{ issueNumber: number|null, phaseId: string|null, terminalReason: string|null, outputs: object, skillInvoked: boolean, annotationMissing: boolean }}
 */
export function detectPhase(entries) {
  let skillName = null;
  let issueNumber = null;
  const foundMarkers = new Set();
  const outputs = {};
  let skillInvoked = false;

  for (const entry of entries) {
    // Real Claude Code transcript entries nest role/content under
    // `entry.message` (e.g. {"type":"assistant","message":{"role":"assistant",
    // "content":[{"type":"tool_use",...}]}}) — the block-level types
    // (tool_use/tool_result/text) live inside message.content[], never at
    // the entry's own top level. Fall back to a flat/legacy shape
    // (entry.role/entry.content directly) if entry.message is absent, so
    // any pre-normalized or synthetic transcript still works (issue #1580).
    const message = entry && typeof entry === "object" && entry.message ? entry.message : entry;
    const role = message?.role;
    const contentBlocks = Array.isArray(message?.content) ? message.content : [];

    for (const block of contentBlocks) {
      if (!block || typeof block !== "object") continue;

      // Tool use blocks — find Skill invocations.
      if (block.type === "tool_use" && block.name === "Skill") {
        const input = block.input || {};
        if (input.skill) { skillName = input.skill; skillInvoked = true; }
        // Extract issue number from args (e.g. "1323" or "#1323").
        if (input.args) {
          const m = String(input.args).match(/\b(\d{3,6})\b/);
          if (m) issueNumber = parseInt(m[1], 10);
        }
      }

      // Tool result blocks — scan for FORGE markers in gh output.
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content)
          ? block.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n")
          : String(block.content || "");
        for (const { marker } of PHASE_MARKERS) {
          if (content.includes(marker)) foundMarkers.add(marker);
        }
        // No PR/branch extraction here (forge#2375) — see the JSDoc above
        // detectPhase() for why. `outputs` stays empty from this scan.
      }

      // Also scan assistant message text blocks for FORGE markers.
      if (role === "assistant") {
        const text = block.text || block.content || "";
        if (typeof text === "string") {
          for (const { marker } of PHASE_MARKERS) {
            if (text.includes(marker)) foundMarkers.add(marker);
          }
        }
      }
    }
  }

  // Match markers to phase, most-specific first (terminal markers take priority).
  let phaseId = null;
  let terminalReason = null;

  for (const { marker, phase, terminal, terminalReason: tr } of PHASE_MARKERS) {
    if (foundMarkers.has(marker)) {
      phaseId = phase;
      if (terminal) terminalReason = tr || null;
      // Keep first match unless a more specific (terminal) marker overrides.
      if (terminal) break;
    }
  }

  // Fallback: derive phase from skill name if no markers found.
  // annotationMissing is true when a skill was invoked but no FORGE markers
  // were found in the transcript — the agent ran but didn't post its annotation.
  const markersFound = foundMarkers.size > 0;
  const phaseFromSkillFallback = !phaseId && skillName ? phaseFromSkill(skillName) : null;
  if (!phaseId && phaseFromSkillFallback) {
    phaseId = phaseFromSkillFallback;
  }

  const annotationMissing = skillInvoked && !markersFound;

  return { issueNumber, phaseId, terminalReason, outputs, skillInvoked, annotationMissing };
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
