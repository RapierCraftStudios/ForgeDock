#!/usr/bin/env node
/**
 * CI drift check: bin/engine/phases.mjs's `PHASES` array (the authoritative
 * engine phase table) must have exactly the same phase-id list, in the same
 * order, as packages/protocol/src/phases.js's `PHASE_IDS` — the single-source
 * registry both bin/engine/phases.mjs and bin/hooks/interactive-engine.mjs
 * import their marker strings from (forge#2378).
 *
 * This does NOT re-validate the marker *strings* themselves — both consumer
 * files import the registry directly, so a string-level mismatch between them
 * is now structurally impossible (there is exactly one literal declaration of
 * each marker, in packages/protocol/src/phases.js / types.js). What CAN still
 * drift is the *phase-id list itself*: someone adds/removes/reorders a phase
 * in bin/engine/phases.mjs's PHASES array without updating the registry's
 * PHASE_IDS (or vice versa). This script catches that.
 *
 * Usage: node scripts/check-phase-registry-drift.mjs
 * Exit codes: 0 = no drift, 1 = drift detected, 2 = usage/import error.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  let registryModule;
  let phasesModule;
  try {
    registryModule = await import(
      pathToFileURL(path.join(REPO_ROOT, "packages/protocol/src/phases.js")).href
    );
  } catch (err) {
    console.error(`ERROR: failed to import packages/protocol/src/phases.js: ${err.message}`);
    process.exit(2);
  }
  try {
    phasesModule = await import(
      pathToFileURL(path.join(REPO_ROOT, "bin/engine/phases.mjs")).href
    );
  } catch (err) {
    console.error(`ERROR: failed to import bin/engine/phases.mjs: ${err.message}`);
    process.exit(2);
  }

  const registryIds = registryModule.PHASE_IDS;
  const enginePhaseIds = (phasesModule.PHASES || []).map((p) => p.id);

  if (!Array.isArray(registryIds)) {
    console.error("ERROR: packages/protocol/src/phases.js did not export a PHASE_IDS array.");
    process.exit(2);
  }
  if (!Array.isArray(enginePhaseIds) || enginePhaseIds.length === 0) {
    console.error("ERROR: bin/engine/phases.mjs did not export a non-empty PHASES array.");
    process.exit(2);
  }

  const drifted =
    registryIds.length !== enginePhaseIds.length ||
    registryIds.some((id, i) => id !== enginePhaseIds[i]);

  if (drifted) {
    console.error("ERROR: phase-id list drift detected between the registry and the engine.");
    console.error(`  packages/protocol/src/phases.js PHASE_IDS: ${JSON.stringify(registryIds)}`);
    console.error(`  bin/engine/phases.mjs PHASES ids:          ${JSON.stringify(enginePhaseIds)}`);
    console.error("  Update packages/protocol/src/phases.js's PHASE_IDS to match bin/engine/phases.mjs's");
    console.error("  PHASES array (or vice versa) so the two stay single-sourced. See forge#2378.");
    process.exit(1);
  }

  // Also verify every registry marker entry that has a `completionMarker` or
  // `completionLabel` field is a non-empty string — catches an accidental
  // undefined/null slipping in (e.g. a typo'd RESERVED_TYPES key whose
  // completionSentinel is null) which would otherwise fail silently at
  // has(blob, undefined) → substring "undefined" never matches, masking a
  // real bug as "phase never completes".
  const emptyMarkers = [];
  for (const [phaseId, entry] of Object.entries(registryModule.PHASE_MARKERS || {})) {
    const marker = entry.completionMarker ?? entry.completionLabel;
    if (typeof marker !== "string" || marker.length === 0) {
      emptyMarkers.push(phaseId);
    }
  }
  if (emptyMarkers.length > 0) {
    console.error(
      `ERROR: PHASE_MARKERS entries with no usable completionMarker/completionLabel: ${emptyMarkers.join(", ")}`
    );
    process.exit(1);
  }

  console.log("OK: phase-id list and marker registry are consistent (no drift detected).");
  process.exit(0);
}

main();
