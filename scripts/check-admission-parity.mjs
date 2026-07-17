#!/usr/bin/env node
/**
 * CI parity check: bin/engine/admission.mjs's `CASCADE_PRESETS` table is the
 * typed, unit-tested reference implementation of the cascade admission
 * policy (forge#2234). The logic actually EXECUTED at runtime is a
 * hand-written bash/yq mirror in commands/orchestrate/phase-4-execution.md's
 * Step 4A.pre `case "$CASCADE_POLICY_NAME" in ... esac` block — the two are
 * kept in sync by hand, with no automated check catching divergence
 * (forge#2340). This script closes that gap: it imports the real
 * `CASCADE_PRESETS` table and diffs it against the values parsed out of the
 * bash mirror, failing non-zero on any mismatch.
 *
 * Usage: node scripts/check-admission-parity.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ADMISSION_MJS_PATH = path.join(REPO_ROOT, "bin/engine/admission.mjs");
const SPEC_PATH = path.join(REPO_ROOT, "commands/orchestrate/phase-4-execution.md");

/**
 * Parse a single bash literal captured from the mirror's case arm into the
 * same JS types `CASCADE_PRESETS` uses (number | "unlimited" | boolean).
 * @param {string} raw
 */
function parseBashValue(raw) {
  const trimmed = raw.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "unlimited") return "unlimited";
  const n = Number(trimmed);
  return Number.isFinite(n) && trimmed !== "" ? n : trimmed;
}

/**
 * Extract each `PRESET_*` assignment from a single case-arm body.
 * @param {string} body - text between `{name})` and the arm's `;;`
 */
function parseArmBody(body) {
  const get = (key) => {
    const m = body.match(new RegExp(`${key}=("?[^;"]*"?)`));
    return m ? parseBashValue(m[1]) : undefined;
  };
  return {
    maxGeneration: get("PRESET_MAX_GEN"),
    tokenBudget: get("PRESET_TOKEN_BUDGET"),
    deferOnBatchGated: get("PRESET_DEFER_GATED"),
    keywordHeuristic: get("PRESET_KEYWORD"),
    p3SameFileDefer: get("PRESET_P3_SAME_FILE"),
  };
}

/**
 * Isolate the `case "$CASCADE_POLICY_NAME" in ... esac` block and return a
 * map of arm-name -> resolved preset object. The wildcard `*` fallback arm
 * is excluded (it re-declares "balanced", not a distinct preset name).
 */
function extractBashMirrorPresets(specText) {
  const caseMatch = specText.match(/case "\$CASCADE_POLICY_NAME" in([\s\S]*?)\nesac/);
  if (!caseMatch) {
    return null;
  }
  const caseBlock = caseMatch[1];

  const armRe = /\n\s*([a-zA-Z0-9_*]+)\)([\s\S]*?);;/g;
  const presets = {};
  let m;
  while ((m = armRe.exec(caseBlock))) {
    const [, name, body] = m;
    if (name === "*") continue; // wildcard fallback arm — not a named preset
    presets[name] = parseArmBody(body);
  }
  return presets;
}

async function main() {
  let admissionModule;
  try {
    // pathToFileURL is required for cross-platform dynamic import() of an absolute
    // path — a bare Windows path like "C:\..." is not a valid ESM specifier and
    // throws ERR_UNSUPPORTED_ESM_URL_SCHEME ("Only URLs with a scheme in: file,
    // data, and node are supported"). POSIX absolute paths import fine either way,
    // but file:// URLs work identically on both, so always convert.
    admissionModule = await import(pathToFileURL(ADMISSION_MJS_PATH));
  } catch (err) {
    console.error(`ERROR: failed to import ${ADMISSION_MJS_PATH}: ${err.message}`);
    process.exit(1);
  }
  const { CASCADE_PRESETS } = admissionModule;
  if (!CASCADE_PRESETS) {
    console.error(`ERROR: ${ADMISSION_MJS_PATH} does not export CASCADE_PRESETS — has it been renamed?`);
    process.exit(1);
  }

  let specText;
  try {
    specText = readFileSync(SPEC_PATH, "utf8");
  } catch (err) {
    console.error(`ERROR: failed to read ${SPEC_PATH}: ${err.message}`);
    process.exit(1);
  }

  const bashPresets = extractBashMirrorPresets(specText);
  if (!bashPresets) {
    console.error(
      `ERROR: could not locate the case "$CASCADE_POLICY_NAME" in ... esac bash mirror block in ${SPEC_PATH}.`,
    );
    console.error(
      "       (parity check has nothing to compare admission.mjs against — has the mirror been renamed or restructured?)",
    );
    process.exit(1);
  }

  let failed = false;
  const mjsNames = Object.keys(CASCADE_PRESETS);
  const bashNames = Object.keys(bashPresets);

  for (const name of mjsNames) {
    if (!(name in bashPresets)) {
      console.error(
        `MISMATCH: preset "${name}" exists in admission.mjs CASCADE_PRESETS but has no matching bash case arm in ${SPEC_PATH}`,
      );
      failed = true;
      continue;
    }
    const mjsPreset = CASCADE_PRESETS[name];
    const bashPreset = bashPresets[name];
    for (const key of Object.keys(mjsPreset)) {
      if (mjsPreset[key] !== bashPreset[key]) {
        console.error(
          `MISMATCH: preset "${name}".${key} — admission.mjs=${JSON.stringify(mjsPreset[key])} bash-mirror=${JSON.stringify(bashPreset[key])}`,
        );
        failed = true;
      }
    }
  }

  for (const name of bashNames) {
    if (!(name in CASCADE_PRESETS)) {
      console.error(
        `MISMATCH: bash case arm "${name}" in ${SPEC_PATH} has no matching preset in admission.mjs CASCADE_PRESETS`,
      );
      failed = true;
    }
  }

  if (failed) {
    console.error("");
    console.error(
      "admission.mjs CASCADE_PRESETS and the phase-4-execution.md bash mirror have drifted out of sync.",
    );
    console.error(
      "Update both together — see the admission.mjs module docstring and phase-4-execution.md Step 4A.pre ('Cascade admission policy resolution').",
    );
    process.exit(1);
  }

  console.log(
    `OK: admission.mjs CASCADE_PRESETS matches the phase-4-execution.md bash mirror for: ${mjsNames.join(", ")}`,
  );
}

main();
