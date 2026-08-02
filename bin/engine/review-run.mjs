// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Durable identity and receipts for one review panel invocation.
 *
 * A review run is scoped to a repository PR and its full 40-character HEAD
 * SHA. STARTED is a claim, not evidence that review passed. Only a later
 * terminal receipt for the same run and SHA closes that claim.
 */

export const REVIEW_RUN_STATES = Object.freeze([
  "STARTED",
  "MERGED",
  "CHANGES_REQUESTED",
  "AWAITING_MERGE",
  "COMPLETE",
  "BLOCKED",
  "SUPERSEDED",
]);

const TERMINAL_STATES = new Set(REVIEW_RUN_STATES.filter((state) => state !== "STARTED"));
const SHA_RE = /^[0-9a-f]{40}$/i;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

function field(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(body || "").match(new RegExp(`\\*\\*${escaped}\\*\\*:\\s*(?:\\x60([^\\x60]+)\\x60|([^\\r\\n]+))`, "i"));
  return String(match?.[1] || match?.[2] || "").trim();
}

function commentOrder(comment, index) {
  const id = Number(comment?.id);
  return Number.isSafeInteger(id) && id >= 0 ? id : index;
}

export function isTrustedReviewReceiptAuthor(entry) {
  const association = String(entry?.author_association || entry?.authorAssociation || "").toUpperCase();
  const userType = String(entry?.user?.type || entry?.author?.type || "").toUpperCase();
  const hasAuthorMetadata = Boolean(association || userType || entry?.user || entry?.author);
  // Unit fixtures and legacy string arrays have no author envelope. Real REST
  // responses always do, so apply the trust boundary whenever metadata exists.
  if (!hasAuthorMetadata) return true;
  return userType === "BOT" || new Set(["OWNER", "MEMBER", "COLLABORATOR"]).has(association);
}

/** Parse all valid FORGE:REVIEW_RUN receipts without trusting prose or untrusted authors. */
export function parseReviewRunReceipts(comments) {
  const receipts = [];
  for (const [index, raw] of (Array.isArray(comments) ? comments : []).entries()) {
    const comment = typeof raw === "string" ? { body: raw } : (raw || {});
    const body = String(comment.body || "");
    if (!isTrustedReviewReceiptAuthor(comment) || !body.includes("<!-- FORGE:REVIEW_RUN -->")) continue;
    const runId = field(body, "Run ID");
    const headSha = field(body, "Head SHA").toLowerCase();
    const state = field(body, "State").toUpperCase();
    const mode = (field(body, "Mode") || "unknown").toLowerCase();
    const expiresRaw = field(body, "Expires");
    const expiresAt = expiresRaw ? Date.parse(expiresRaw) : NaN;
    if (!RUN_ID_RE.test(runId) || !SHA_RE.test(headSha) || !REVIEW_RUN_STATES.includes(state)) continue;
    receipts.push({
      runId,
      headSha,
      state,
      mode,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      id: Number.isSafeInteger(Number(comment.id)) ? Number(comment.id) : null,
      order: commentOrder(comment, index),
      body,
    });
  }
  return receipts.sort((a, b) => a.order - b.order);
}

/** Return each run's latest valid receipt, ordered by durable comment order. */
export function latestReviewRuns(comments) {
  const latest = new Map();
  for (const receipt of parseReviewRunReceipts(comments)) {
    // A run ID must never let a receipt on a newer SHA erase an unmatched
    // claim on an older SHA. Scope lifecycle pairing by both identities.
    latest.set(`${receipt.runId}\u0000${receipt.headSha}`, receipt);
  }
  return [...latest.values()].sort((a, b) => a.order - b.order);
}

export function isTerminalReviewRunState(state) {
  return TERMINAL_STATES.has(String(state || "").toUpperCase());
}

/** Parse trusted, time-bounded claims to recover one exact expired STARTED run. */
export function parseReviewRecoveryClaims(comments) {
  const claims = [];
  for (const [index, raw] of (Array.isArray(comments) ? comments : []).entries()) {
    const comment = typeof raw === "string" ? { body: raw } : (raw || {});
    const body = String(comment.body || "");
    if (!isTrustedReviewReceiptAuthor(comment) || !body.includes("<!-- FORGE:REVIEW_RECOVERY_CLAIM -->")) continue;
    const recoveryId = field(body, "Recovery ID");
    const staleRunId = field(body, "Stale Run ID");
    const headSha = field(body, "Head SHA").toLowerCase();
    const expiresAt = Date.parse(field(body, "Expires"));
    if (!RUN_ID_RE.test(recoveryId) || !RUN_ID_RE.test(staleRunId) || !SHA_RE.test(headSha) || !Number.isFinite(expiresAt)) continue;
    claims.push({ recoveryId, staleRunId, headSha, expiresAt, id: Number.isSafeInteger(Number(comment.id)) ? Number(comment.id) : null, order: commentOrder(comment, index), body });
  }
  return claims.sort((a, b) => a.order - b.order);
}

/** Elect one unexpired recovery claimant by durable comment order. */
export function electReviewRunRecovery({ comments, headSha, staleRunId, recoveryId, now = Date.now() }) {
  const normalizedSha = String(headSha || "").toLowerCase();
  const contenders = parseReviewRecoveryClaims(comments)
    .filter((claim) => claim.headSha === normalizedSha && claim.staleRunId === staleRunId && claim.expiresAt > now)
    .sort((a, b) => a.order - b.order);
  const winner = contenders[0] || null;
  return { won: Boolean(winner && winner.recoveryId === recoveryId), winner, contenders };
}

export function formatReviewRecoveryClaim({ recoveryId, staleRunId, headSha, expiresAt }) {
  const normalizedSha = String(headSha || "").toLowerCase();
  if (!RUN_ID_RE.test(String(recoveryId || "")) || !RUN_ID_RE.test(String(staleRunId || ""))) throw new Error("invalid review recovery identity");
  if (!SHA_RE.test(normalizedSha)) throw new Error("review recovery claim requires a full 40-character HEAD SHA");
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= Date.now()) throw new Error("review recovery claim requires a future expiry");
  return [
    "<!-- FORGE:REVIEW_RECOVERY_CLAIM -->",
    `**Recovery ID**: \`${recoveryId}\``,
    `**Stale Run ID**: \`${staleRunId}\``,
    `**Head SHA**: \`${normalizedSha}\``,
    `**Expires**: ${new Date(Number(expiresAt)).toISOString()}`,
  ].join("\n");
}

/**
 * Decide whether a caller may start a panel for this exact HEAD.
 *
 * A live STARTED claim is never stolen. An expired claim returns a distinct
 * stale-active reason so the runtime can run the durable recovery election
 * before terminalizing that exact run and re-entering ordinary admission.
 */
export function decideReviewRunAdmission({ comments, headSha, inline = false }) {
  const normalizedSha = String(headSha || "").toLowerCase();
  if (!SHA_RE.test(normalizedSha)) return { action: "blocked", reason: "invalid-head-sha" };
  const sameHead = latestReviewRuns(comments).filter((receipt) => receipt.headSha === normalizedSha);
  const active = sameHead.filter((receipt) => receipt.state === "STARTED");
  if (active.length) {
    const receipt = active[0];
    return {
      action: "blocked",
      reason: receipt.expiresAt != null && receipt.expiresAt <= Date.now() ? "stale-active-claim" : "active-claim",
      receipt,
    };
  }
  const latest = sameHead.at(-1);
  if (inline && latest && ["MERGED", "CHANGES_REQUESTED", "AWAITING_MERGE"].includes(latest.state)) {
    return { action: "reuse", reason: "terminal-inline-receipt", receipt: latest };
  }
  if (inline && latest?.state === "COMPLETE" && latest.mode === "inline") {
    return { action: "blocked", reason: "incomplete-inline-disposition", receipt: latest };
  }
  return { action: "start", reason: latest?.state === "BLOCKED" ? "retry-after-blocked" : "no-active-claim", receipt: latest };
}

/** Elect the lowest durable comment id/order among concurrent STARTED claims. */
export function electReviewRunClaim({ comments, headSha, runId }) {
  const normalizedSha = String(headSha || "").toLowerCase();
  const active = latestReviewRuns(comments)
    .filter((receipt) => receipt.headSha === normalizedSha && receipt.state === "STARTED")
    .sort((a, b) => a.order - b.order);
  const winner = active[0] || null;
  return { won: Boolean(winner && winner.runId === runId), winner, contenders: active };
}

export function formatReviewRunReceipt({ runId, headSha, state, mode, expiresAt, selected, completed, detail }) {
  const normalizedState = String(state || "").toUpperCase();
  const normalizedSha = String(headSha || "").toLowerCase();
  if (!RUN_ID_RE.test(String(runId || ""))) throw new Error("invalid review run id");
  if (!SHA_RE.test(normalizedSha)) throw new Error("review receipt requires a full 40-character HEAD SHA");
  if (!REVIEW_RUN_STATES.includes(normalizedState)) throw new Error(`invalid review run state: ${normalizedState}`);
  const lines = [
    "<!-- FORGE:REVIEW_RUN -->",
    `**Run ID**: \`${runId}\``,
    `**Head SHA**: \`${normalizedSha}\``,
    `**State**: ${normalizedState}`,
    `**Mode**: ${mode || "unknown"}`,
  ];
  if (expiresAt) lines.push(`**Expires**: ${new Date(expiresAt).toISOString()}`);
  if (Number.isInteger(selected)) lines.push(`**Selected reviewers**: ${selected}`);
  if (Number.isInteger(completed)) lines.push(`**Completed reviewers**: ${completed}`);
  if (detail) lines.push(`**Detail**: ${String(detail).replace(/[\r\n]+/g, " ").slice(0, 1000)}`);
  return lines.join("\n");
}

/** Parse a run/SHA-scoped FORGE:REVIEW verdict from PR comments or reviews. */
export function parseScopedReviewVerdict(entries, { runId, headSha }) {
  const normalizedSha = String(headSha || "").toLowerCase();
  const candidates = [];
  for (const [index, raw] of (Array.isArray(entries) ? entries : []).entries()) {
    const entry = typeof raw === "string" ? { body: raw } : (raw || {});
    const body = String(entry.body || "");
    if (!isTrustedReviewReceiptAuthor(entry) || !body.includes("<!-- FORGE:REVIEW -->")) continue;
    if (!body.includes(`<!-- FORGE:REVIEW-RUN:${runId} -->`)) continue;
    if (!body.toLowerCase().includes(`<!-- forge:review-sha:${normalizedSha} -->`)) continue;
    const verdict = field(body, "Verdict").toUpperCase();
    if (!new Set(["PASS", "APPROVED", "CHANGES REQUESTED", "AWAITING MERGE", "BLOCKED"]).has(verdict)) continue;
    const selected = Number.parseInt(field(body, "Selected isolated reviewers"), 10);
    const completed = Number.parseInt(field(body, "Verified reviewer receipts"), 10);
    candidates.push({
      verdict,
      selected: Number.isSafeInteger(selected) ? selected : null,
      completed: Number.isSafeInteger(completed) ? completed : null,
      body,
      order: commentOrder(entry, index),
    });
  }
  return candidates.sort((a, b) => a.order - b.order).at(-1) || null;
}

/** Unique reviewer domains whose receipts are scoped to this run and SHA. */
export function reviewPanelIntegrityError(verdict, domains, { requireSecurity = true } = {}) {
  const scoped = Array.isArray(domains) ? domains : [];
  const selected = verdict?.selected;
  const completed = verdict?.completed;
  if (!Number.isInteger(selected) || !Number.isInteger(completed) || selected <= 0 || selected !== completed || completed !== scoped.length) {
    return `selected=${selected ?? "missing"} completed=${completed ?? "missing"} scoped=${scoped.length}`;
  }
  if (requireSecurity && !scoped.includes("security")) return "mandatory security reviewer receipt is missing";
  return null;
}

export function scopedReviewerDomains(comments, { runId, headSha }) {
  const normalizedSha = String(headSha || "").toLowerCase();
  const domains = new Set();
  for (const raw of Array.isArray(comments) ? comments : []) {
    const entry = typeof raw === "string" ? { body: raw } : (raw || {});
    const body = String(entry.body || "");
    if (!isTrustedReviewReceiptAuthor(entry) || !body.includes(`<!-- FORGE:REVIEW-RUN:${runId} -->`)) continue;
    if (!body.toLowerCase().includes(`<!-- forge:review-sha:${normalizedSha} -->`)) continue;
    const markers = [...body.matchAll(/<!--\s*FORGE:REVIEW-AGENT:([a-z0-9-]+)\s*-->/gi)];
    // One isolated reviewer writes one receipt. A comment claiming several
    // domains is malformed and must not satisfy the panel count.
    if (markers.length !== 1) continue;
    domains.add(markers[0][1].toLowerCase());
  }
  return [...domains].sort();
}
