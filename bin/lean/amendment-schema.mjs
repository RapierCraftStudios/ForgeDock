// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5979: the amendment shapes the builder may write to result.json, as data. The builder prompt, the correction prompt and the
 * tests render from this one list, so the prompt never documents a shape the validator (conformance.mjs) rejects, nor omits one it accepts.
 * Pure: no imports.
 */

/** kind -> {shape, doc, example}. `supersedes` takes only a "#N" guard issue or a mechanism, never a validate-row id (G2): that is substitute-validate. */
export const AMENDMENT_SHAPES = Object.freeze({
  "add-deliverable": { shape: `{"kind":"add-deliverable","path":"<file>","why":""}`, doc: "a file not listed.", example: { kind: "add-deliverable", path: "bin/x.mjs", why: "needed" } },
  "add-requirement": { shape: `{"kind":"add-requirement","requirement":{"id":"R9","quote":"<verbatim from the issue>","disposition":"deliver|defer|post-deploy"},"why":""}`, doc: "a missed requirement.", example: { kind: "add-requirement", requirement: { id: "R9", quote: "q", disposition: "deliver" }, why: "missed" } },
  defer: { shape: `{"kind":"defer|post-deploy","requirement":"R#","why":"","check":"<id>"}`, doc: `separate work or a post-deploy check, filed as a follow-up. Not "type"; unknown kinds are rejected. One requirement id per row. An impossible deliverable is a defer, not a new kind.`, example: { kind: "defer", requirement: "R1", why: "separate work", check: "c1" } },
  "post-deploy": { example: { kind: "post-deploy", requirement: "R1", why: "measured after release", check: "c1" } },
  "amend-requirement": { shape: `{"kind":"amend-requirement","requirement":"R#","text":"<revised wording>","why":""}`, doc: "reworded.", example: { kind: "amend-requirement", requirement: "R1", text: "revised", why: "reworded" } },
  supersedes: { shape: `{"kind":"supersedes","guard":"#N","why":""}`, doc: `overrides a guard_broken failure of guarded issue #N; {"kind":"supersedes","mechanism":"<name>","why":""} retires every guard whose test this lane deletes. A validate-row id (G2, V1) is never a supersedes guard.`, example: { kind: "supersedes", guard: "#123", why: "obsolete" } },
  "substitute-validate": { shape: `{"kind":"substitute-validate","validate":"G2","command":"<runnable equivalent>","why":""}`, doc: "replaces a frozen validate row (V1, G2...) whose command cannot run; use this, not supersedes, for a validate-row id.", example: { kind: "substitute-validate", validate: "G2", command: "node --test a.test.mjs", why: "frozen command cannot run" } },
  "out-of-band": { shape: `{"kind":"out-of-band","requirement":"R#","evidence":"<job or workflow that measures it>","why":""}`, doc: "a deliver requirement measured by a committed job, not a unit test.", example: { kind: "out-of-band", requirement: "R1", evidence: ".github/workflows/bench.yml", why: "measured by the bench job" } },
  decision: { shape: `{"kind":"decision","decision":{"choice":"","anchors":["<base path>"],"supersedes":"<id>"},"why":""}`, doc: "supersedes changes an H-row.", example: { kind: "decision", decision: { choice: "c", anchors: ["bin/x.mjs"] }, why: "w" } },
});

export const AMEND_KINDS = Object.freeze(["add-deliverable", "add-requirement", "defer", "post-deploy", "amend-requirement", "supersedes", "decision", "substitute-validate", "out-of-band"]);

/** One valid example per kind (supersedes only with #N). */
export const AMENDMENT_EXAMPLES = Object.freeze(AMEND_KINDS.map((k) => AMENDMENT_SHAPES[k].example));

/** The builder-prompt bullet list, in the order the prompt documents them. */
export function amendmentPromptLines() {
  return ["add-deliverable", "add-requirement", "defer", "amend-requirement", "supersedes", "substitute-validate", "out-of-band", "decision"]
    .map((k) => `- ${AMENDMENT_SHAPES[k].shape}: ${AMENDMENT_SHAPES[k].doc}`).join("\n");
}
