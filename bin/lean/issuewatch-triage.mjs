// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `mode: triage` of `forgedock issue-watch` (#5558, epic #5549 Phase 1): filing an issue never starts work. The tick only
 * classifies new open issues text-only (one injected `io.triageClassify` call each, capped per hour) and labels them. It is
 * handed no claim, lane-launch or batch seam, so it cannot claim or build. Deterministic first: the `needs-info` check, the
 * labels, the record rules (confidence cap, migrations never `none`) and the idempotence marker are all script facts.
 */
import { buildClassifyRecord, validateClassification, renderClassify, deriveFacts, ReleaseClassifyTYPES } from "./release-classify.mjs";
import { noComments } from "./render.mjs";

export const CLASSIFY_MARKER = "<!-- FORGE:CLASSIFY -->";
export const NEEDS_INFO_LABEL = "needs-info";
export const DEFAULT_TRIAGE_PER_HOUR = 10;
const HOUR = 3600000;
const ACCEPT_HEADING = /^\s{0,3}#{1,6}\s*(acceptance( criteria)?|definition of done)\b/im;
const CHECKLIST = /^\s*[-*]\s+\[[ xX]\]\s+\S/m;

/** True when the body has no acceptance criteria: no `Acceptance` / `Definition of done` heading and no checklist item. */
export function needsInfo(body) {
  const b = noComments(String(body ?? ""));
  return !(ACCEPT_HEADING.test(b) || CHECKLIST.test(b));
}

/** Suggestion labels only: `type:*`, `priority:*` and (when not `none`) `lane:*`. */
export const triageLabels = (rec) => [`type:${rec.type}`, `priority:${rec.severity}`, rec.lane_hint && rec.lane_hint !== "none" ? `lane:${rec.lane_hint}` : null].filter(Boolean);

const hasClassify = (i) => (i.comments ?? []).some((c) => String(c?.body ?? "").includes("FORGE:CLASSIFY"));

/** Cap per hour: the watch's `triage.max_per_hour`, else the policy's `classify.triage_max_per_hour`, else the default. */
export const maxPerHour = (watch, policy) => watch.triage_max_per_hour ?? policy?.classify?.triage_max_per_hour ?? DEFAULT_TRIAGE_PER_HOUR;

/**
 * One pass. `listOpen() → issues` (with `comments`), `trusted(issue) → bool`, `io.{gh, now, triageClassify(issue) → {type, severity, exists_in?, lane_hint?, confidence?}, pause?() → null|{reason}}`.
 * `state.triage.calls` holds the model-call times of the last hour. Returns `{paused?, classified[], skipped[], calls}`.
 */
export async function triageTick({ watch, repo, io, state, listOpen, trusted = () => false, policy = null }) {
  const out = { classified: [], skipped: [], calls: 0 };
  if (watch.mode !== "triage") return out; // zero GitHub writes outside triage mode
  const paused = await io.pause?.();
  if (paused) return { ...out, paused: paused.reason ?? true };
  const now = io.now();
  const t = (state.triage ??= { calls: [], errors: {} });
  t.calls = (t.calls ?? []).filter((at) => now - at < HOUR);
  const cap = maxPerHour(watch, policy);
  const facts = deriveFacts(policy, []);
  for (const issue of await listOpen()) {
    const n = issue.number;
    if (hasClassify(issue)) continue;
    if (!trusted(issue)) { out.skipped.push({ n, why: "untrusted author" }); continue; }
    if (t.calls.length >= cap) { out.skipped.push({ n, why: "cap" }); continue; } // waits for the next tick
    t.calls.push(now); out.calls++;
    try {
      const llm = { ...(await io.triageClassify(issue)) };
      if (llm.severity === "P0") llm.severity = "P1"; // text alone never proves production impact
      llm.exists_in ??= "unknown"; llm.severity ??= "P3";
      const rec = { ...buildClassifyRecord(llm, policy, facts, { text: true }), set_by: "issue-watch-triage" };
      const bad = validateClassification(rec);
      if (bad.length || !ReleaseClassifyTYPES.includes(rec.type)) throw new Error(`invalid classification: ${bad.join("; ") || "type"}`);
      const labels = [...triageLabels(rec), ...(needsInfo(issue.body) ? [NEEDS_INFO_LABEL] : [])];
      await io.gh(["issue", "edit", String(n), "-R", repo, "--add-label", labels.join(",")]);
      await io.gh(["issue", "comment", String(n), "-R", repo, "--body", `${CLASSIFY_MARKER}\n${renderClassify(rec)}`]); // the marker last: a failed label retries
      delete t.errors[n]; out.classified.push({ n, labels });
    } catch (e) { t.errors[n] = String(e?.message ?? e).slice(0, 200); out.skipped.push({ n, why: t.errors[n] }); }
  }
  state.triage.last = { at: new Date(now).toISOString(), classified: out.classified.length, calls: out.calls };
  return out;
}
