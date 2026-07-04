#!/usr/bin/env node
/**
 * bin/hooks/subagent-stop-enforce.mjs — ForgeDock SubagentStop enforcement hook.
 *
 * Deterministic annotation enforcement (issue #1250): called by Claude Code
 * when a sub-agent (Skill invocation) completes. Checks the transcript for
 * the expected FORGE: annotation and blocks silent completion if the
 * annotation is missing.
 *
 * === Hook protocol ===
 *
 * Claude Code sends a JSON payload to stdin:
 *   {
 *     "hook_event_name": "SubagentStop",
 *     "session_id": "...",
 *     "transcript_path": "...",   // path to the agent's JSONL transcript
 *     "stop_hook_active": false
 *   }
 *
 * Exit codes:
 *   exit 0  — allow completion
 *   exit 2  — block completion; stdout message injected as additionalContext
 *              (requires Claude Code v2.1.163+ for additionalContext injection)
 *
 * === Annotation detection ===
 *
 * The hook scans the transcript for FORGE: annotation markers written via
 * `gh issue comment` or `gh api` calls in the most recent pipeline phase.
 * Each pipeline phase is expected to post a specific FORGE: marker:
 *
 *   FORGE:INVESTIGATOR  — investigate phase
 *   FORGE:CONTRACT      — context/contract phase
 *   FORGE:ARCHITECT     — architect phase
 *   FORGE:BUILDER       — build phase (also FORGE:BUILDER:COMPLETE)
 *   FORGE:REVIEWER      — review phase
 *
 * If the transcript shows a pipeline phase Skill was invoked but no matching
 * FORGE: annotation appears in the tool results, completion is blocked with
 * corrective context.
 *
 * === Fail-open contract ===
 *
 * Any uncaught error or parse failure exits 0 (allow). This hook MUST NOT
 * block legitimate completions due to a hook bug or missing transcript.
 * Transcript read errors, missing files, and unknown phase patterns all
 * exit 0 silently.
 *
 * === Wiring ===
 *
 * Installed into ~/.claude/settings.json under hooks.SubagentStop by
 * `forgedock install` (version-gated: requires Claude Code v2.1.163+).
 * Removed by `forgedock uninstall`.
 * Identified by the string "subagent-stop-enforce.mjs" in SUBAGENT_ENFORCE_MARKER.
 */

import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Phase annotation map — which FORGE: marker each pipeline phase must post
// ---------------------------------------------------------------------------

/**
 * Map from phase-detection pattern to required FORGE: annotation marker.
 * The phase-detection pattern matches the Skill name or the FORGE:PHASE_START
 * marker that indicates which pipeline phase was active.
 *
 * Key: regex pattern matching the phase label in the transcript
 * Value: FORGE: annotation string that must appear in a tool result
 */
const PHASE_ANNOTATIONS = {
  "FORGE:PHASE_START.*investigate": "FORGE:INVESTIGATOR",
  "FORGE:PHASE_START.*context":     "FORGE:CONTRACT",
  "FORGE:PHASE_START.*architect":   "FORGE:ARCHITECT",
  "FORGE:PHASE_START.*build":       "FORGE:BUILDER",
  "FORGE:PHASE_START.*review":      "FORGE:REVIEWER",
};

// ---------------------------------------------------------------------------
// Main — fail-open wrapper
// ---------------------------------------------------------------------------

try {
  await main();
} catch {
  // Fail open — never block a sub-agent completion due to a hook error.
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) { process.exit(0); return; }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); return;
  }

  if (payload.hook_event_name !== "SubagentStop") { process.exit(0); return; }

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) { process.exit(0); return; }

  // Read the transcript file.
  let transcriptText;
  try {
    transcriptText = readFileSync(transcriptPath, "utf-8");
  } catch {
    // Transcript unreadable — fail open.
    process.exit(0); return;
  }

  // Determine which pipeline phase was active in this transcript.
  const detectedPhase = detectPhase(transcriptText);
  if (!detectedPhase) {
    // Not a pipeline phase subagent — allow completion.
    process.exit(0); return;
  }

  const { phaseName, requiredAnnotation } = detectedPhase;

  // Check whether the required FORGE: annotation appears in the transcript.
  if (transcriptText.includes(requiredAnnotation)) {
    // Annotation present — allow completion.
    process.exit(0); return;
  }

  // Annotation missing — block completion with corrective context.
  const message = [
    `[ForgeDock] BLOCKED: Pipeline phase "${phaseName}" completed without posting its FORGE: annotation.`,
    ``,
    `Required annotation: <!-- ${requiredAnnotation} --> (or <!-- ${requiredAnnotation}:... -->)`,
    ``,
    `Before completing this phase, post the annotation to the GitHub issue using:`,
    `  gh issue comment <issue-number> --body "<!-- ${requiredAnnotation} -->\\n..."`,
    ``,
    `FORGE: annotations are the authoritative pipeline record. Without them, the`,
    `next phase cannot locate the output of this phase after a context reset.`,
    ``,
    `Post the annotation and then signal completion again.`,
  ].join("\n");

  process.stdout.write(message);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Phase detection
// ---------------------------------------------------------------------------

/**
 * Scan the transcript for a FORGE:PHASE_START marker to identify the active
 * pipeline phase. Returns the phase name and required annotation, or null if
 * this is not a pipeline phase transcript.
 *
 * @param {string} transcript - Full transcript text.
 * @returns {{ phaseName: string, requiredAnnotation: string } | null}
 */
function detectPhase(transcript) {
  for (const [pattern, annotation] of Object.entries(PHASE_ANNOTATIONS)) {
    const re = new RegExp(pattern, "i");
    if (re.test(transcript)) {
      // Extract phase name from pattern (text after last dot or slash).
      const phaseMatch = pattern.match(/\*\*?([a-z]+)\s*$/i);
      const phaseName = phaseMatch ? phaseMatch[1] : pattern;
      return { phaseName, requiredAnnotation: annotation };
    }
  }
  return null;
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
    setTimeout(() => resolve(buf), 1000);
  });
}
