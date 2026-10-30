// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4766: north-star decision engine. Settles a lane's decision-only `needs-human` escalation from the target repo's own
 * policy file (forge.yaml `decisions.policy`, default NORTHSTAR.md, then CLAUDE.md, AGENTS.md) and the anchored decisions
 * register (#4695); external actions (the authority matrix, `decisions.human_only`) stay with a human.
 *
 * Deterministic first: `loadPolicy` and `splitEscalation` are pure facts (terminal code, block type, matrix hints). The only
 * judgment is one injected `judge()` call per decision part. A one-way, low-confidence or clause-less answer escalates with the
 * analysis attached, never a guess. Shadow mode (the default) posts `FORGE:DECISION (shadow)` and keeps the label; live mode
 * records the decision, clears needs-human and requeues. A veto (`forge:decision-veto` label, or a reply within
 * `veto_hours`) reverts it; a reversal rate above `reversal_max` forces shadow. Never throws: an error is an `error` row.
 * The issue-watch stage (#4765) calls `settle` once per escalation (key: the escalation comment id).
 */
import { parseForgeYaml } from "../forge-utils.mjs";
import { foldDecisions, recordDecisions as recordToRegister } from "./decisions.mjs";

export const VETO_LABEL = "forge:decision-veto";
export const NEEDS_HUMAN_LABEL = "needs-human";
export const POLICY_FALLBACKS = ["NORTHSTAR.md", "CLAUDE.md", "AGENTS.md"];
export const VETO_HOURS_DEFAULT = 24;
export const REVERSAL_MAX_DEFAULT = 0.2;
export const REVERSAL_MIN_SAMPLE = 5;
const PARTS_MAX = 5;
const POLICY_TEXT_MAX = 12000;

/** The authority matrix: typed classes with built-in match hints (a forge.yaml `hint_<class>` list replaces them). */
export const DEFAULT_CLASSES = {
  spend: /\b(spend|spending|paid|purchase|billing|invoice|budget increase|buy)\b/i,
  credentials: /\b(credentials?|secrets?|api[ _-]?keys?|passwords?|tokens?|oauth)\b/i,
  "external-publish": /\b(publish|npm publish|public announcement|tweet|press release)\b/i,
  "customer-send": /\b(customer[- ]facing|customer sends?|newsletter)\b|\b(send|e?mail|notify|message)\b[^.\n]{0,40}\bcustomers?\b/i,
  "prod-write": /\b(production (write|database|db|data change)|prod write|as root|\broot\b|sudo)\b/i,
  promotion: /\b(promot(e|ion)|staging\s*(→|->|to)\s*main|release to (production|main))\b/i,
  legal: /\b(legal|licen[cs]e change|gdpr|terms of service|contract signature)\b/i,
};

const csv = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const hintRe = (words) => new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

/**
 * The decisions policy of a repo: `{policyPath, policyText, mode, matrix:[{class, re}], vetoHours, reversalMax, warnings}`.
 * forge.yaml keys (one nesting level, comma lists): `decisions:` `policy`, `mode` (shadow|live, default shadow),
 * `human_only` (class names, default all of DEFAULT_CLASSES), `hint_<class>` (match words), `veto_hours`, `reversal_max`.
 * `io.readFile(path)` returns the text or throws.
 */
export function loadPolicy({ io, cwd = "." } = {}) {
  const read = (p) => { try { return String(io.readFile(`${cwd}/${p}`)); } catch { return null; } };
  const warnings = [];
  const raw = read("forge.yaml");
  let d = {};
  if (raw != null) { try { d = parseForgeYaml(raw)?.decisions; } catch { d = {}; } }
  d = d && typeof d === "object" ? d : {};
  let policyPath = null, policyText = "";
  for (const p of [String(d.policy ?? "").trim(), ...POLICY_FALLBACKS].filter(Boolean)) {
    const t = read(p);
    if (t != null) { policyPath = p; policyText = t.slice(0, POLICY_TEXT_MAX); break; }
    if (p === String(d.policy ?? "").trim()) warnings.push(`decisions.policy ${p} not readable`);
  }
  const names = csv(d.human_only).length ? csv(d.human_only) : Object.keys(DEFAULT_CLASSES);
  const matrix = [];
  for (const name of names) {
    const own = csv(d[`hint_${name}`]);
    if (own.length) matrix.push({ class: name, re: hintRe(own) });
    else if (DEFAULT_CLASSES[name]) matrix.push({ class: name, re: DEFAULT_CLASSES[name] });
    else warnings.push(`human_only class ${name} has no hint_${name} and is not built in: dropped`);
  }
  const hours = Number(d.veto_hours), rev = Number(d.reversal_max);
  return {
    policyPath, policyText, matrix, warnings,
    mode: d.mode === "live" ? "live" : "shadow",
    vetoHours: Number.isFinite(hours) && hours >= 0 ? hours : VETO_HOURS_DEFAULT,
    reversalMax: Number.isFinite(rev) && rev >= 0 && rev <= 1 ? rev : REVERSAL_MAX_DEFAULT,
  };
}

const EVIDENCE_RE = /\b(missing|needs?|requires?|no)\b[^.\n]{0,60}\bread[- ]only\b[^.\n]{0,40}\b(prod|production)\b|\bread[- ]only (prod|production) data\b/i;
const POSTDEPLOY_RE = /\b(all (remaining )?(items|checks|criteria) (are|is) post[- ]deploy|post[- ]deploy[- ]only)\b/i;

/**
 * Splits an escalation into decision and external parts from facts. `{terminalCode, blockType, text}`, `matrix` from
 * loadPolicy, `retryable` a set of codes recovery owns. Returns `{kind, decisions:[text], external:[{class, text}]}` with
 * kind `recovery | evidence | post-deploy | external | decision | mixed`.
 */
export function splitEscalation({ terminalCode = null, blockType = null, text = "" } = {}, matrix = [], { retryable = [] } = {}) {
  const body = String(text ?? "");
  const out = (kind, decisions = [], external = []) => ({ kind, decisions, external });
  if (terminalCode && new Set(retryable).has(terminalCode)) return out("recovery");
  if (terminalCode === "conformance.unimplemented" || EVIDENCE_RE.test(body)) return out("evidence");
  if (POSTDEPLOY_RE.test(body)) return out("post-deploy");
  const klass = (t) => matrix.find((m) => m.re.test(t))?.class ?? null;
  if (blockType === "credentials" && matrix.some((m) => m.class === "credentials")) return out("external", [], [{ class: "credentials", text: body.slice(0, 200) }]);
  const lines = body.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  const bulleted = body.split("\n").some((l) => /^\s*(?:[-*]|\d+[.)])\s+/.test(l));
  const parts = bulleted ? lines : [body.trim()].filter(Boolean);
  const decisions = [], external = [];
  for (const p of parts) { const c = klass(p); if (c) external.push({ class: c, text: p.slice(0, 200) }); else decisions.push(p.slice(0, 400)); }
  return out(external.length && decisions.length ? "mixed" : external.length ? "external" : "decision", decisions.slice(0, PARTS_MAX), external);
}

/** A judge answer that may be applied: a clause, reversible, not low confidence. Otherwise the reason it must escalate. */
export function admissible(a) {
  if (!a || typeof a !== "object") return { ok: false, why: "no answer" };
  if (!String(a.choice ?? "").trim()) return { ok: false, why: "no choice" };
  if (!String(a.clause ?? "").trim()) return { ok: false, why: "no applicable policy clause or precedent" };
  if (a.reversibility !== "reversible") return { ok: false, why: `${a.reversibility ?? "unknown"} reversibility (only reversible decisions are settled)` };
  if (!["high", "medium"].includes(a.confidence)) return { ok: false, why: `${a.confidence ?? "no"} confidence` };
  return { ok: true, why: "" };
}

/**
 * Whether a settled decision was vetoed: the `forge:decision-veto` label, or a comment after `decidedAt` (ms) within
 * `vetoHours` whose first word is `veto`. `comments` is `[{body, createdAt}]`.
 */
export function isVetoed({ labels = [], comments = [], decidedAt = 0, vetoHours = VETO_HOURS_DEFAULT, now = Date.now() } = {}) {
  if ((labels ?? []).includes(VETO_LABEL)) return true;
  const end = decidedAt + vetoHours * 3600_000;
  return (comments ?? []).some((c) => {
    const t = Date.parse(c?.createdAt);
    return Number.isFinite(t) && t > decidedAt && t <= Math.min(end, now) && /^\s*\/?veto\b/i.test(String(c?.body ?? ""));
  });
}

/** Mode in force: a reversal rate above the cap (with a minimum sample) turns live back to shadow. */
export function effectiveMode(policy, { decided = 0, reversed = 0 } = {}) {
  if (policy.mode !== "live") return { mode: "shadow", gated: false };
  const rate = decided >= REVERSAL_MIN_SAMPLE ? reversed / decided : 0;
  return rate > policy.reversalMax ? { mode: "shadow", gated: true, rate } : { mode: "live", gated: false, rate };
}

/** Counts for the watcher status and telemetry from settle rows. */
export function tally(rows) {
  const t = { decided: 0, evidence: 0, folded: 0, external_kept: 0, escalated: 0, vetoed: 0, shadow: 0 };
  for (const r of rows ?? []) {
    if (r?.action === "decided") t.decided++;
    else if (r?.action === "shadow") t.shadow++;
    else if (r?.action === "escalated") t.escalated++;
    else if (r?.action === "vetoed") t.vetoed++;
    else if (r?.action === "evidence-needed") t.evidence++;
    else if (r?.action === "post-deploy-only") t.folded++;
    else if (r?.action === "external" || r?.kept) t.external_kept++;
  }
  return t;
}

const oneLine = (v, n = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const render = (a, policy) => `**What**: ${oneLine(a.choice)}\n**Clause**: ${oneLine(a.clause)} (${policy.policyPath ?? "no policy file"})\n**Rejected**: ${oneLine(a.rejected) || "-"}\n**Reversibility**: ${a.reversibility ?? "-"}\n**Confidence**: ${a.confidence ?? "-"}`;

/** Classification only (`--dry-run`): what `settle` would do, no judge call and no write. */
export function classify(item, policy, opts = {}) {
  const s = splitEscalation(item, policy.matrix, opts);
  return { issue: item.issue, escalationId: item.escalationId ?? null, kind: s.kind, decisions: s.decisions.length, external: s.external.map((e) => e.class) };
}

/**
 * Settles one escalation. `item`: `{issue, repo, escalationId, text, terminalCode, blockType, options, anchors, comments}`;
 * `deps`: `{judge, post(marker, body, issue), setLabels({issue, add, remove}), requeue(issue), records, stats, emit}`.
 * Idempotent on `escalationId` (a prior engine comment carries `Escalation: <id>`). Returns one row, never throws.
 */
export async function settle(item, policy, deps = {}, opts = {}) {
  const row = { issue: item?.issue ?? null, escalationId: item?.escalationId ?? null, kind: null, action: "skipped" };
  try {
    if (item.escalationId && (item.comments ?? []).some((c) => /FORGE:DECISION/.test(String(c?.body ?? "")) && String(c.body).includes(`Escalation: ${item.escalationId}`))) return { ...row, reason: "already handled" };
    const s = splitEscalation(item, policy.matrix, opts);
    row.kind = s.kind;
    if (s.kind === "recovery") return { ...row, reason: "recovery owns this code" };
    if (s.kind === "external") return { ...row, action: "external", kept: true, class: s.external[0]?.class, reason: `skip: external (${s.external[0]?.class})` };
    if (s.kind === "evidence") return { ...row, action: "evidence-needed" };
    if (s.kind === "post-deploy") return { ...row, action: "post-deploy-only" };
    const key = `Escalation: ${item.escalationId ?? "-"}`;
    const precedent = foldDecisions(deps.records ?? []).filter((d) => d.status !== "superseded");
    const answers = [];
    for (const part of s.decisions) {
      const a = await deps.judge({ issue: item.issue, decision: part, options: item.options ?? [], policy: policy.policyText, policyPath: policy.policyPath, precedent });
      const v = admissible(a);
      if (!v.ok) {
        await deps.post("FORGE:DECISION (escalated)", `## Escalated, not decided\n${key}\n**Part**: ${oneLine(part)}\n**Why**: ${v.why}\n${a?.choice ? `**Analysis**: leaning ${oneLine(a.choice)}\n` : ""}needs-human is kept.`, item.issue);
        deps.emit?.({ event: "DECISION_ENGINE", issue: item.issue, decided: 0, escalated: 1, vetoed: 0, mode: policy.mode });
        return { ...row, action: "escalated", reason: v.why };
      }
      answers.push(a);
    }
    const { mode, gated } = effectiveMode(policy, deps.stats ?? {});
    const body = answers.map((a, i) => `### Decision ${i + 1}\n${render(a, policy)}`).join("\n\n");
    if (mode === "shadow") {
      await deps.post("FORGE:DECISION (shadow)", `## Decision (shadow${gated ? ", reversal rate above cap" : ""})\n${key}\n${body}\n\nWould clear needs-human and requeue; the label is kept.`, item.issue);
      deps.emit?.({ event: "DECISION_ENGINE", issue: item.issue, decided: 0, escalated: 0, vetoed: 0, mode: "shadow" });
      return { ...row, action: "shadow", gated };
    }
    await deps.post("FORGE:DECISION", `## Decision\n${key}\n${body}${s.external.length ? `\n\nExternal part stays needs-human: ${s.external.map((e) => e.class).join(", ")}.` : ""}`, item.issue);
    const anchors = item.anchors ?? [];
    const registered = anchors.length ? await (deps.recordDecisions ?? recordToRegister)(answers.map((a) => ({ choice: a.choice, why: a.clause, anchors: a.anchors?.length ? a.anchors : anchors })), { issue: item.issue, repo: item.repo, post: deps.post }) : [];
    if (s.external.length) { // mixed: the decision part is settled, the external part keeps the label
      deps.emit?.({ event: "DECISION_ENGINE", issue: item.issue, decided: answers.length, escalated: 0, vetoed: 0, mode: "live" });
      return { ...row, action: "decided", kept: true, choice: answers[0].choice, registered: registered.length };
    }
    await deps.setLabels({ issue: item.issue, remove: [NEEDS_HUMAN_LABEL] });
    await deps.requeue(item.issue);
    deps.emit?.({ event: "DECISION_ENGINE", issue: item.issue, decided: answers.length, escalated: 0, vetoed: 0, mode: "live" });
    return { ...row, action: "decided", choice: answers[0].choice, registered: registered.length };
  } catch (e) {
    return { ...row, action: "error", reason: oneLine(e?.message) };
  }
}

/** Reverts a vetoed live decision: needs-human back, the requeue undone, the veto label cleared. One row, never throws. */
export async function revertVeto(item, deps = {}) {
  try {
    await deps.setLabels({ issue: item.issue, add: [NEEDS_HUMAN_LABEL], remove: [VETO_LABEL] });
    await deps.unrequeue?.(item.issue);
    await deps.post("FORGE:DECISION (vetoed)", `## Decision vetoed\nEscalation: ${item.escalationId ?? "-"}\nThe owner vetoed the decision: needs-human restored and the requeue reverted.`, item.issue);
    deps.emit?.({ event: "DECISION_ENGINE", issue: item.issue, decided: 0, escalated: 0, vetoed: 1, reversed: 1 });
    return { issue: item.issue, action: "vetoed" };
  } catch (e) {
    return { issue: item?.issue ?? null, action: "error", reason: oneLine(e?.message) };
  }
}
