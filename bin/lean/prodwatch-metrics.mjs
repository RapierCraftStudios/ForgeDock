// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Prod-watch loop metrics (#4837, part of #4768): per source, the time from signal to issue, merge and deployed-verified,
 * the false-positive, fix-ineffective and recurrence rates, and an automatic drop of a noisy source to shadow. Pure apart
 * from the injected `io.emit`; no gh, no fs. Rows are supplied by the caller (the verify loop, #4836, does not exist yet):
 * `{source, fp?, signalAt, issueAt?, mergedAt?, verifiedAt?, invalid?, reopened?, recurred?}` with times as ms or ISO strings.
 */
import { REVERSAL_MIN_SAMPLE } from "./decision-engine.mjs";

export const FP_MIN_SAMPLE = REVERSAL_MIN_SAMPLE;
export const FP_MAX_DEFAULT = 0.5;

const ms = (v) => { const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const gap = (a, b) => { const x = ms(a), y = ms(b); return x !== null && y !== null && y >= x ? y - x : null; };
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1e6) / 1e6 : 0);

/** `{[source]: {sample, invalid, fix_ineffective, recurred, fp_rate, fix_ineffective_rate, recurrence_rate, signal_to_issue_ms, signal_to_merge_ms, signal_to_verified_ms}}`. */
export function computeMetrics(rows) {
  const by = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && typeof r === "object" && r.source) (by[r.source] ??= []).push(r);
  }
  const out = {};
  for (const [source, rs] of Object.entries(by)) {
    const seen = new Set();
    let recurred = 0, merged = 0;
    for (const r of rs) {
      if (r.merged !== false && ms(r.mergedAt) !== null) merged++;
      const dup = r.fp && seen.has(r.fp);
      if (r.fp) seen.add(r.fp);
      if (r.recurred || dup) recurred++;
    }
    const invalid = rs.filter((r) => r.invalid).length;
    const reopened = rs.filter((r) => r.reopened).length;
    const times = (k) => median(rs.map((r) => gap(r.signalAt, r[k])).filter((v) => v !== null));
    out[source] = {
      sample: rs.length, invalid, fix_ineffective: reopened, recurred,
      fp_rate: rate(invalid, rs.length), fix_ineffective_rate: rate(reopened, merged), recurrence_rate: rate(recurred, rs.length),
      signal_to_issue_ms: times("issueAt"), signal_to_merge_ms: times("mergedAt"), signal_to_verified_ms: times("verifiedAt"),
    };
  }
  return out;
}

/**
 * Mode in force for a source (as decision-engine effectiveMode): a false-positive rate above `max` over at least `minSample`
 * signals drops it to shadow (triage runs, nothing is filed). `stats`: `{sample, invalid}` or computeMetrics output.
 */
export function sourceMode(source, stats = {}, { max = FP_MAX_DEFAULT, minSample = FP_MIN_SAMPLE } = {}) {
  const s = stats?.[source] ?? stats ?? {};
  const sample = Number.isFinite(s.sample) ? s.sample : 0;
  const r = sample >= minSample ? rate(Number.isFinite(s.invalid) ? s.invalid : 0, sample) : 0;
  return r > max ? { mode: "shadow", gated: true, rate: r } : { mode: "live", gated: false, rate: r };
}

/** Emits one PRODWATCH_METRICS record per source through `io.emit` (the engine telemetry seam); returns the count. Never throws. */
export function emitMetrics(metrics, { emit } = {}) {
  let n = 0;
  for (const [source, m] of Object.entries(metrics ?? {})) {
    try { emit?.({ event: "PRODWATCH_METRICS", source, ...m }); n++; } catch { /* telemetry is best effort */ }
  }
  return n;
}
