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

import { readFileSync, readdirSync } from "node:fs";
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
    batchMaxGeneration: get("PRESET_BATCH_MAX_GEN"),
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

/** Recursively list *.md files under a directory. */
function listMarkdown(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdown(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/**
 * Collect identifiers the orchestrate specs name as admission.mjs APIs:
 * (a) names destructured from an admission.mjs import snippet (`({ a, b }) =>`), and (b) backticked `name()` calls
 * on any line that mentions admission.mjs. Returns [{ name, file, line }], plus
 * `{ unattributed: true, file, line }` for destructure snippets that name no module.
 *
 * Heuristic limits: a destructure snippet is attributed to the first `engine/<name>.mjs` path found between its
 * `.then(({` and the next `.then(({` (or end of text), capped at 1500 chars. A snippet naming no module in that
 * window is reported as unattributable (the lint fails closed). The backtick-call rule is line-scoped: it only
 * fires on lines that themselves mention admission.mjs, so `plan*()` calls in other prose are not linted.
 */
function extractSpecNamedIdentifiers(file, text) {
  const found = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  // The module loaded by a snippet is the first `engine/<name>.mjs` path passed after its `.then(({...}) =>`.
  const destructure = /\.then\(\(\s*\{([^}]*)\}\s*\)\s*=>/g;
  const starts = [...text.matchAll(destructure)].map((x) => x.index);
  let m;
  while ((m = destructure.exec(text))) {
    const next = starts.find((s) => s > m.index) ?? text.length;
    const target = text.slice(m.index, Math.min(next, m.index + 1500)).match(/engine\/([\w-]+)\.mjs/)?.[1];
    if (!target) {
      found.push({ unattributed: true, file, line: lineOf(m.index) });
      continue;
    }
    if (target !== "admission") continue;
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s*:\s*/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) found.push({ name, file, line: lineOf(m.index) });
    }
  }
  const lines = text.split("\n");
  lines.forEach((lineText, i) => {
    if (!lineText.includes("admission.mjs")) return;
    for (const call of lineText.matchAll(/`([A-Za-z_$][\w$]*)\(\)`/g)) {
      found.push({ name: call[1], file, line: i + 1 });
    }
  });
  return found;
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

  // Spec-lint: every admission.mjs identifier named in commands/orchestrate/** must be exported.
  const specDir = path.join(REPO_ROOT, "commands/orchestrate");
  let namedCount = 0;
  for (const file of listMarkdown(specDir)) {
    for (const { name, line, unattributed } of extractSpecNamedIdentifiers(file, readFileSync(file, "utf8"))) {
      if (unattributed) {
        console.error(
          `UNATTRIBUTABLE: ${path.relative(REPO_ROOT, file)}:${line} could not attribute .then(({...}) => snippet to an engine/<module>.mjs path`,
        );
        failed = true;
        continue;
      }
      namedCount++;
      if (!(name in admissionModule)) {
        console.error(
          `MISSING EXPORT: ${path.relative(REPO_ROOT, file)}:${line} names "${name}" from admission.mjs, but it is not exported`,
        );
        failed = true;
      }
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

  console.log(`OK: all ${namedCount} admission.mjs identifiers named in commands/orchestrate/** are exported`);
  console.log(
    `OK: admission.mjs CASCADE_PRESETS matches the phase-4-execution.md bash mirror for: ${mjsNames.join(", ")}`,
  );
}

main();
