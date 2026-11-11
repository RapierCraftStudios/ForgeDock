// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Investigation decides pipeline depth (#5426, builds on the light lane #4450). With forge.yaml `lean.light.source:
 * investigation` the first builder call is investigation-only: it writes investigation.md and `.forge-lean/triage.json`
 * ({files, size, risk, decision_needed}). Eligibility for the light lane is then computed from those grounded findings
 * (predicted non-test files, size, risk, hotspot) by the same `lightEligibility` rules; the text heuristic over the issue body
 * stays only as a `pre_text_*` shadow signal. An eligible issue fast-forwards: one implement session, deterministic gates
 * (`runLightStep`), merge; the stages it skips are named. Anything else continues into the full lane's contract step.
 * `source: investigation` with `mode: shadow` changes nothing: it logs FASTFORWARD_ELIGIBILITY after the normal plan session.
 * Pure helpers and prompts: no I/O, no model call.
 */
import { lightEligibility, LIGHT_SOURCES } from "./light.mjs";
import { builderPlanPrompt, LEAN_DIR, CONTRACT_FILE } from "./prompts.mjs";

export const TRIAGE_FILE = `${LEAN_DIR}/triage.json`;

/** `lean.light.source` of a parsed light config: text (default) or investigation. */
export const fastForwardSource = (cfg) => (LIGHT_SOURCES.includes(cfg?.source) ? cfg.source : "text");

const PATH_RE = /[A-Za-z0-9_@.][A-Za-z0-9_@.\-]*(?:\/[A-Za-z0-9_@.\-]+)*\.[A-Za-z0-9]{1,8}\b/g;
const SECTION_RE = /^###\s+Affected Files\s*$([\s\S]*?)(?=^###\s|(?![\s\S]))/m;
const uniq = (xs) => [...new Set(xs)];

/** Paths named in the `### Affected Files` section of investigation.md (deterministic fallback when triage.json is absent). */
export function affectedFilesOf(md) {
  const sec = SECTION_RE.exec(String(md ?? ""))?.[1] ?? "";
  const out = [];
  for (const line of sec.split("\n")) {
    if (!/^\s*[-*]/.test(line)) continue;
    const first = line.replace(/^\s*[-*]\s*/, "").replace(/`/g, "").match(PATH_RE)?.[0]; // the first token names the file; later ones are prose
    if (first && !/^\d/.test(first) && (first.includes("/") || /\.(m?[jt]sx?|py|go|rs|md|json|ya?ml|sh|css|sql)$/.test(first))) out.push(first.replace(/^\.\//, ""));
  }
  return uniq(out);
}

/**
 * triage.json text + investigation.md -> {files, size, risk, decisionNeeded, source}. A malformed or absent triage falls back to
 * the Affected Files section with an unknown size; a size outside S|M|L is unknown.
 */
export function parseTriage(triageRaw, md = "") {
  let t = null;
  try { const j = JSON.parse(String(triageRaw ?? "")); t = j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { /* fall back */ }
  const files = t && Array.isArray(t.files) ? uniq(t.files.map((f) => String(f ?? "").trim().replace(/^\.\//, "")).filter(Boolean)) : affectedFilesOf(md);
  const size = ["S", "M", "L"].includes(String(t?.size ?? "").toUpperCase()) ? String(t.size).toUpperCase() : null;
  return { files, size, risk: t?.risk === true, decisionNeeded: t?.decision_needed === true, source: t ? "triage" : "affected_files" };
}

/** Eligibility from the investigation's findings; the text verdict is recorded as the shadow `pre_text_*` signal. */
export function fastForwardEligibility({ title = "", body = "", labels = [], triage = null, textFiles = [], riskPaths = [], hotspots = [], cfg = {} } = {}) {
  const t = triage ?? { files: [], size: null, risk: false, decisionNeeded: false };
  const text = lightEligibility({ title, body, labels, predictedFiles: textFiles, cfg: { ...cfg, mode: cfg.mode === "off" ? "off" : "shadow" } });
  const extraHard = [
    ...(t.risk ? [{ code: "risk", detail: "the investigation flagged the change as risky" }] : []),
    ...(t.decisionNeeded ? [{ code: "decision", detail: "the investigation says a decision is needed" }] : []),
  ];
  return lightEligibility({ title, body, labels, predictedFiles: t.files, riskPaths, hotspots, cfg, source: "investigation", size: t.size, extraHard, preText: text.verdict });
}

/** The stages a fast-forwarded lane skips and why: [{stage, why}]. */
export function skippedStages(elig = null) {
  const why = `investigation predicts a small change (${elig?.signals?.find((s) => s.code === "files_named")?.detail ?? "?"} non-test file(s), no risk path or hotspot)`;
  return ["plan", "contract freeze", "multi-session review"].map((stage) => ({ stage, why }));
}

/** One line for the trajectory and the FORGE:LITE receipt. */
export const skippedLine = (elig) => `Fast-forward: skipped ${skippedStages(elig).map((x) => x.stage).join(", ")}; ${skippedStages(elig)[0].why}`;

const TRIAGE_RULE = `3. Write ${TRIAGE_FILE}: {"files":["<non-test file you predict will change>"],"size":"S|M|L","risk":false,"decision_needed":false}. "files" are repo-relative non-test paths from your Affected Files; size S = a small fix in at most a couple of files; risk true when the fix touches auth, security, payments, migrations, CI or public API shape; decision_needed true when a design or product choice must be made first. The engine reads it to pick the pipeline depth.

Stop after the files above. Do not write ${CONTRACT_FILE} yet: the engine tells you whether to continue.`;

/** Call 1 when source is investigation: step 1 of the plan prompt (investigation, close rules, block rules) plus the triage file. */
export function investigationOnlyPrompt(n, opts = {}) {
  const full = builderPlanPrompt(n, opts);
  const cut = full.indexOf("\n2. Otherwise write"), blocks = full.indexOf('"blocked" needs a typed');
  if (cut < 0 || blocks < 0) return full;
  return `${full.slice(0, cut)}\n2. Do not write the contract yet.\n${TRIAGE_RULE}\n\n${full.slice(blocks)}`;
}

/** Call 2 (same session) when the issue is not fast-forwarded: the contract step of the plan prompt. */
export function contractStepPrompt(n, opts = {}) {
  const full = builderPlanPrompt(n, opts);
  const cut = full.indexOf("2. Otherwise write");
  return `Your investigation is written and the engine is continuing with the full lane. This is still PLANNING ONLY: no code edits, no commits.\n\n${cut < 0 ? full : full.slice(cut)}`;
}

/** The light build prompt's lead-in when it resumes the investigation session. */
export const FF_BUILD_LEAD = `The investigation step is complete and the engine fast-forwards this issue (small, no risk path): the planning-only rule no longer applies. Implement the fix now.\n\n`;

/** The FASTFORWARD_ELIGIBILITY run-log event (read by `stats --depth`); `shadow` = logged beside a normal full-lane plan session. */
export const fastForwardEvent = (elig, triage, { shadow = false } = {}) => ({ event: "FASTFORWARD_ELIGIBILITY", mode: elig.mode, verdict: elig.verdict, eligible: elig.eligible, light: elig.light, shadow,
  files: triage.files.length, size: triage.size, triage: triage.source, reasons: elig.reasons, signals: elig.signals });
