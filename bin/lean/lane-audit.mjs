// FORGE:LANE_AUDIT (#6076, child of #6072): at an unhappy lane terminal, bundle the evidence, classify it against the signature table
// (no LLM), and post one version-stamped, idempotent JSON comment. Never throws: an audit must not change how a lane ends.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNATURES } from "./lane-audit-signatures.mjs";
import { auditGap } from "./lane-audit-gap.mjs";
import { classifyWithLlm } from "./lane-audit-llm.mjs";

export const LANE_AUDIT_MARKER = "FORGE:LANE_AUDIT";
const TAIL = 4000;
const ROW_RE = /<!--\s*(FORGE:(?:PARKED|NEEDS_HUMAN))\s*-->/;
const ACTIVE_CLASSES = ["pipeline", "env", "pool"]; // classes whose active findings go to the gap audit

const semver = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "")); return m ? [+m[1], +m[2], +m[3]] : null; };
/** -1 | 0 | 1, or null when either side is not a version. */
export function compareAuditVersions(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Hash of the repo's forge.yaml (null when absent). */
export function forgeYamlHash(dir) {
  try { return createHash("sha256").update(readFileSync(join(dir, "forge.yaml"))).digest("hex").slice(0, 12); } catch { return null; }
}

/** The version stamp: engine version + build sha, agent version, image tag, forge.yaml hash, batch id, attempt. */
export function buildStamp({ engineVersion = null, buildSha = null, agentVersion = null, imageTag = null, forgeYamlHash: fy = null, batchId = null, attempt = null, env = process.env } = {}) {
  return {
    engine_version: engineVersion ?? null,
    build_sha: buildSha ?? env.FORGE_BUILD_SHA ?? null,
    agent_version: agentVersion ?? env.FORGE_AGENT_VERSION ?? null,
    image_tag: imageTag ?? env.FORGE_IMAGE_TAG ?? null,
    forge_yaml_hash: fy ?? null,
    batch_id: batchId ?? null,
    attempt: attempt ?? null,
  };
}

const tail = (s, n = TAIL) => String(s ?? "").slice(-n);

/** The evidence bundle: park rows, stderr, run-log tail, phase timings, prior attempts, contract vs trusted decisions. */
export function buildEvidence({ issue, reason, code = null, detail = "", comments = [], stderr = "", runLogTail = "", phases = null, contractDecisions = [], trustedDecisions = [], stamp = {} } = {}) {
  const bodies = (comments ?? []).map((c) => (typeof c === "string" ? c : String(c?.body ?? "")));
  const parkRows = bodies.filter((b) => ROW_RE.test(b)).map((b) => ({ marker: ROW_RE.exec(b)[1], text: tail(b, 600) }));
  const priorAttempts = bodies.map(parseAudit).filter((a) => a && a.issue === issue).length;
  const ev = { issue, reason, code, detail: String(detail ?? ""), parkRows, stderr: tail(stderr), runLogTail: tail(runLogTail), phases, priorAttempts, contractDecisions, trustedDecisions, stamp };
  ev.text = [ev.detail, ...parkRows.map((r) => r.text), ev.stderr, ev.runLogTail].filter(Boolean).join("\n");
  return ev;
}

/**
 * Classify against the table. A match whose fixed_in is later than the engine that ran is `fixed_in_later` (not active).
 * @returns {{signature, class, owner, action, active, fixed_in_later}|null}
 */
export function classifyAudit(evidence, table = SIGNATURES) {
  for (const s of table) {
    let hit = false;
    try { hit = Boolean(s.match(evidence)); } catch { hit = false; }
    if (!hit) continue;
    const later = s.fixed_in != null && compareAuditVersions(evidence.stamp?.engine_version, s.fixed_in) === -1;
    return { signature: s.id, class: s.class, owner: s.owner, action: s.action, introduced_in: s.introduced_in ?? null, fixed_in: s.fixed_in ?? null, fixed_in_later: later, active: !later };
  }
  return null;
}

export const auditKey = (issue, attempt, signature) => `${issue}:${attempt ?? 0}:${signature}`;

export function renderAudit(audit) {
  const j = JSON.stringify(audit, null, 2);
  const head = `## Lane audit\n**Class**: ${audit.class}${audit.fixed_in_later ? " (fixed in a later engine)" : ""}\n**Signature**: ${audit.signature}\n**Owner**: ${audit.owner ?? "-"}\n**Action**: ${audit.action ?? "-"}\n**Status**: ${audit.status}`;
  return `${head}\n\n\`\`\`json\n${j}\n\`\`\`\n<!-- LANE_AUDIT_KEY ${audit.key} -->`;
}

/** The audit object of a FORGE:LANE_AUDIT comment body, or null. */
export function parseAudit(body) {
  const s = String(body ?? "");
  if (!s.includes(`<!-- ${LANE_AUDIT_MARKER}`)) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(s);
  if (!m) return null;
  try { const a = JSON.parse(m[1]); return a && typeof a === "object" ? a : null; } catch { return null; }
}

/**
 * Audit one unhappy terminal. Posts at most one comment per (issue, attempt, signature). Never throws.
 * @param {object} o  {issue, reason, code, detail, comments, post(marker, body), trusted(comment), stamp, ...evidence fields, table, gap, llm}
 * @returns {Promise<{posted:boolean, audit?:object, skipped?:string}>}
 */
export async function runLaneAudit(o = {}) {
  try {
    const { post, trusted = () => true, table = SIGNATURES, gap = auditGap, llm = classifyWithLlm } = o;
    if (typeof post !== "function") return { posted: false, skipped: "no-post" };
    const ev = buildEvidence(o);
    let c = classifyAudit(ev, table);
    let gapFinding = null, llmFinding = null;
    if (c && c.active && ACTIVE_CLASSES.includes(c.class)) gapFinding = await gap(ev, c);
    if (!c) { llmFinding = await llm(ev); c = llmFinding && typeof llmFinding === "object" ? { signature: llmFinding.signature ?? "llm", class: llmFinding.class ?? "unclassified", owner: llmFinding.owner ?? null, action: llmFinding.action ?? null, introduced_in: null, fixed_in: null, fixed_in_later: false, active: true } : null; }
    if (!c) c = { signature: "unclassified", class: "unclassified", owner: null, action: null, introduced_in: null, fixed_in: null, fixed_in_later: false, active: true };
    const key = auditKey(ev.issue, ev.stamp?.attempt, c.signature);
    const seen = (o.comments ?? []).some((cm) => (typeof cm === "string" || trusted(cm)) && parseAudit(typeof cm === "string" ? cm : cm?.body)?.key === key);
    if (seen) return { posted: false, skipped: "already-audited" };
    const audit = { key, issue: ev.issue, terminal: { reason: ev.reason, code: ev.code }, ...c, status: "proposed", stamp: ev.stamp, prior_attempts: ev.priorAttempts, ...(gapFinding ? { gap: gapFinding } : {}) };
    await post(LANE_AUDIT_MARKER, renderAudit(audit));
    return { posted: true, audit };
  } catch (e) {
    return { posted: false, skipped: `error: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}
