// Pure query helpers over parsed FORGE:LANE_AUDIT audits (#6077, child of #6072). Read-only consumers of lane-audit.mjs.
import { compareAuditVersions } from "./lane-audit.mjs";

const ver = (a) => a?.stamp?.engine_version ?? null;

/** Audits matching every given filter: version (exact), sinceVersion (>=), signature, class (exact). */
export function filterAudits(audits, { version, sinceVersion, signature, class: cls } = {}) {
  return (audits ?? []).filter((a) => {
    if (version != null && ver(a) !== version) return false;
    if (sinceVersion != null && !(compareAuditVersions(ver(a), sinceVersion) >= 0)) return false;
    if (signature != null && a.signature !== signature) return false;
    if (cls != null && a.class !== cls) return false;
    return true;
  });
}

/** The highest engine_version among the audits (null when none is a version). */
export function highestVersion(audits) {
  let best = null;
  for (const a of audits ?? []) {
    const v = ver(a);
    if (compareAuditVersions(v, v) === null) continue;
    if (best === null || compareAuditVersions(v, best) === 1) best = v;
  }
  return best;
}

/** Active findings of the current version, per signature: [{signature, class, count, lanes}] (lanes = issue numbers). */
export function summarizeActive(audits, { currentVersion = highestVersion(audits) } = {}) {
  const by = new Map();
  for (const a of audits ?? []) {
    if (!a.active || a.fixed_in_later) continue;
    if (currentVersion == null || ver(a) !== currentVersion) continue;
    const g = by.get(a.signature) ?? { signature: a.signature, class: a.class ?? null, count: 0, lanes: [] };
    g.count++;
    if (a.issue != null && !g.lanes.includes(a.issue)) g.lanes.push(a.issue);
    by.set(a.signature, g);
  }
  return [...by.values()].sort((x, y) => y.count - x.count || String(x.signature).localeCompare(String(y.signature)));
}

/** Text output for either rows (audits) or an active summary. */
export function formatAudits(rows, { active = false } = {}) {
  if (!rows.length) return active ? "no active audits" : "no audits";
  if (active) return rows.map((g) => `${g.signature}  [${g.class ?? "-"}]  count=${g.count}  lanes: ${g.lanes.map((n) => `#${n}`).join(", ") || "-"}`).join("\n");
  return rows.map((a) => `#${a.issue ?? "?"}  ${a.signature}  [${a.class ?? "-"}]  ${ver(a) ?? "-"}${a.fixed_in_later ? "  fixed-in-later" : a.active ? "  active" : ""}`).join("\n");
}

/** Audit counts per engine version: {version: {class: count}}; audits without a version go under "unknown" (#6080). */
export function groupByVersion(audits) {
  const out = {};
  for (const a of audits ?? []) {
    const v = ver(a) ?? "unknown", c = a?.class ?? "unknown";
    const g = (out[v] ??= {});
    g[c] = (g[c] ?? 0) + 1;
  }
  return out;
}

const HAPPY_OUTCOMES = new Set(["merged", "invalid", "decomposed"]);

/** Batch-report lines listing unhappy lanes (#N) per audit class; [] when no unhappy row has an audit (#6080). Pure. */
export function formatAuditRollup(rows, audits) {
  const unhappy = new Set((rows ?? []).filter((r) => Number.isInteger(r?.issue) && r.outcome != null && !HAPPY_OUTCOMES.has(r.outcome)).map((r) => r.issue));
  if (!unhappy.size || !(audits ?? []).length) return [];
  const by = new Map();
  for (const a of audits) {
    if (!unhappy.has(a?.issue)) continue;
    const c = a.class ?? "unknown";
    const set = by.get(c) ?? new Set();
    set.add(a.issue);
    by.set(c, set);
  }
  if (!by.size) return [];
  const lines = ["unhappy lanes by audit class:"];
  for (const [c, set] of [...by].sort((x, y) => y[1].size - x[1].size || x[0].localeCompare(y[0]))) lines.push(`  ${c}: ${[...set].sort((x, y) => x - y).map((n) => `#${n}`).join(", ")}`);
  return lines;
}
