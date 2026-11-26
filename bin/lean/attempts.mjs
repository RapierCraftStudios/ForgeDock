// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5986: the per-issue attempts ledger `{attempts, signatures[], lastInputHash, spend}`. It lives in the batch state.json (cache) and is
 * mirrored as one hidden `FORGE:ATTEMPTS` comment (the register). Readmission needs a new input hash; the same hash after a failure is
 * refused (`loop.no_new_input`); a lifetime budget breach escalates once (`FORGE:ESCALATION`, needs-human) until the hash changes.
 * Nothing here clears the ledger: releaseHeld, --requeue and --set-env leave it alone. A missing ledger always admits.
 */
import { createHash } from "node:crypto";
import { parseContractComment } from "./render.mjs";
import { postUpsert, findLeading, engineCommentCount } from "./statuscomment.mjs";

export const ATTEMPTS_MARKER = "FORGE:ATTEMPTS";
export const ESCALATION_MARKER = "FORGE:ESCALATION";
export const NO_NEW_INPUT = "loop.no_new_input";
export const DEFAULT_ISSUE_ATTEMPTS = 4;
export const DEFAULT_MAX_IDENTICAL = 2;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
const majorMinor = (v) => (/^v?(\d+)\.(\d+)/.exec(String(v ?? "")) ?? []).slice(1, 3).join(".");
const labelName = (l) => (typeof l === "string" ? l : l?.name);

/** Hash of what a person can change: title+body, labels (not needs-human), operator FORGE:DECISION comments, engine and sandbox engine major.minor, contract hash. */
export function computeInputHash({ title = "", body = "", labels = [], decisions = [], engineVersion = null, sandboxVersion = null, contractHash = null } = {}) {
  const ls = (labels ?? []).map(labelName).filter((n) => n && n !== "needs-human" && !String(n).startsWith("needs-human:")).sort();
  return sha(JSON.stringify([String(title), String(body), ls, (decisions ?? []).map(String), majorMinor(engineVersion), majorMinor(sandboxVersion), contractHash ?? null]));
}

export const emptyLedger = () => ({ attempts: 0, signatures: [], lastInputHash: null, spend: 0 });
export function normalizeLedger(x) {
  if (!x || typeof x !== "object") return emptyLedger();
  return { attempts: Number.isInteger(x.attempts) && x.attempts > 0 ? x.attempts : 0, signatures: Array.isArray(x.signatures) ? x.signatures.map((s) => ({ ...s, sig: String(s?.sig ?? "") })) : [],
    lastInputHash: typeof x.lastInputHash === "string" ? x.lastInputHash : null, spend: Number(x.spend) > 0 ? Number(x.spend) : 0, ...(Number.isInteger(x.comments) && x.comments >= 0 ? { comments: x.comments } : {}), ...(x.escalated ? { escalated: x.escalated } : {}), ...(x.hostPin ? { hostPin: true } : {}) };
}

/** `{maxAttempts, maxIdentical}` from the orchestration config (posint, else the defaults 4 and 2). */
export const budgets = (cfg) => ({ maxAttempts: Number(cfg?.maxAttempts) >= 1 ? Math.floor(cfg.maxAttempts) : DEFAULT_ISSUE_ATTEMPTS, maxIdentical: Number(cfg?.maxIdentical) >= 1 ? Math.floor(cfg.maxIdentical) : DEFAULT_MAX_IDENTICAL });

/** The ledger after one failed lane (a new object): attempts+1, the signature with its run link, the hash it ran under, spend added. */
const normDetail = (d) => String(d ?? "").replace(/https?:\/\/\S+/g, "").replace(/\b[0-9a-f]{7,40}\b/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
/** #5931: what blocked a lane: code, normalized detail, contract hash, the engine version the lane ran, placement, and the env keys the detail names. */
export function blockerSignature({ code = null, detail = "", contractHash = null, engineVersion = null, placement = null, env = null } = {}) {
  const envKeys = [...new Set(String(detail ?? "").match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? [])].sort();
  return { code: code ?? null, detail: normDetail(detail), contractHash: contractHash ?? null, engineVersion: engineVersion ? majorMinor(engineVersion) || String(engineVersion) : null, placement: placement ?? null, ...(envKeys.length ? { envKeys, env: Object.fromEntries(envKeys.map((k) => [k, env?.[k] == null ? null : sha(env[k])])) } : {}) };
}
/** A credentials block naming ops_credentials is pinned to the host on readmit. */
export const isCredentialsBlock = (detail) => /ops_credentials/i.test(String(detail ?? "")) && /credential/i.test(String(detail ?? ""));

export function recordFailure(ledger, { signature, hash = null, spend = 0, run = null, blocker = null }) {
  const l = normalizeLedger(ledger);
  const changed = hash && l.lastInputHash && hash !== l.lastInputHash; // a new input starts a new escalation window, the lifetime counters stay
  const { escalated, ...rest } = l;
  const pin = l.hostPin || (blocker && isCredentialsBlock(blocker.detail)); // `comments` (the engine comment count seen at the last mirror) rides along
  return { ...rest, ...(pin ? { hostPin: true } : {}), ...(escalated && !changed ? { escalated } : {}), attempts: l.attempts + 1, signatures: [...l.signatures, { sig: String(signature ?? ""), ...(hash ? { hash } : {}), ...(run ? { run } : {}), ...(blocker ? { blocker } : {}) }], lastInputHash: hash ?? l.lastInputHash, spend: Math.round((l.spend + (Number(spend) || 0)) * 1e6) / 1e6 };
}

/** The breach of the lifetime budget, or null: attempts reached the cap, or one signature exceeded `maxIdentical` failures. */
export function breach(ledger, cfg) {
  const l = normalizeLedger(ledger), { maxAttempts, maxIdentical } = budgets(cfg);
  const counts = new Map();
  for (const s of l.signatures) counts.set(s.sig, (counts.get(s.sig) ?? 0) + 1);
  const worst = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= maxIdentical) return { kind: "identical", detail: `failure signature \`${worst[0]}\` repeated ${worst[1]} times (max_identical_signature ${maxIdentical})` };
  if (l.attempts >= maxAttempts) return { kind: "attempts", detail: `${l.attempts} lanes ran (max_attempts_per_issue ${maxAttempts})` };
  return null;
}

/**
 * Admission of a re-run. `hash` null (unreadable input) fails open. Returns {ok:true} or {ok:false, code, reason}: `escalate` (a budget
 * breach not yet escalated), or `loop.no_new_input` (the same input after a failure).
 */
export function admitInput(ledger, hash, cfg, cur = null) {
  const l = normalizeLedger(ledger);
  if (!hash || !l.attempts || !l.lastInputHash || hash !== l.lastInputHash) return { ok: true };
  const why = changedSince(l.signatures[l.signatures.length - 1]?.blocker, cur); // #5931: the hash omits placement and env values
  if (why) return { ok: true, reason: why };
  const b = breach(l, cfg);
  if (b && !l.escalated) return { ok: false, code: "escalate", reason: b.detail };
  const last = l.signatures[l.signatures.length - 1]?.sig;
  return { ok: false, code: NO_NEW_INPUT, reason: `input unchanged since the last failure${last ? ` (\`${last}\`)` : ""}${b ? `; ${b.detail}` : ""}` };
}

/** What relevant thing changed since the blocker (engine version, placement, contract hash, a referenced env key), or null. */
export function changedSince(b, cur) {
  if (!b || !cur) return null;
  const diff = (a, c) => a != null && c != null && String(a) !== String(c);
  if (diff(b.engineVersion, cur.engineVersion ? majorMinor(cur.engineVersion) || cur.engineVersion : null)) return `engine version changed ${b.engineVersion} -> ${cur.engineVersion}`;
  if (diff(b.placement, cur.placement)) return `placement changed ${b.placement} -> ${cur.placement}`;
  if (diff(b.contractHash, cur.contractHash)) return "contract hash changed";
  const keys = (b.envKeys ?? []).filter((k) => cur.env && cur.env[k] !== undefined && (b.env?.[k] ?? null) !== (cur.env[k] == null ? null : sha(cur.env[k])));
  return keys.length ? `env key changed: ${keys.join(", ")}` : null;
}

export const markEscalated = (ledger, at) => ({ ...normalizeLedger(ledger), escalated: at ?? true });

/** The one consolidated FORGE:ESCALATION body: signatures with run links, spend, what unblocks it. */
export function renderEscalation(ledger, reason) {
  const l = normalizeLedger(ledger);
  const rows = l.signatures.map((s, i) => `${i + 1}. \`${s.sig}\`${s.run ? ` (${s.run})` : ""}`);
  return [`Escalated to a person after ${l.attempts} attempt${l.attempts === 1 ? "" : "s"}: ${reason}.`, "", ...rows, "", `Spend: $${l.spend.toFixed(2)}`,
    "No further lanes run until the issue's input changes (edit the issue, add a FORGE:DECISION, or upgrade the engine); removing needs-human alone does not readmit it."].join("\n");
}

/** Hidden FORGE:ATTEMPTS comment body and its parse (null when absent or malformed). */
export const renderAttempts = (ledger) => `<!-- ${ATTEMPTS_MARKER} ${JSON.stringify(normalizeLedger(ledger))} -->`;
export function parseAttempts(body) {
  const m = new RegExp(`^\\s*<!--\\s*${ATTEMPTS_MARKER}\\s+(\\{.*\\})\\s*-->`, "s").exec(String(body ?? ""));
  if (!m) return null;
  try { return normalizeLedger(JSON.parse(m[1])); } catch { return null; }
}

/** Hash of the last trusted, parseable FORGE:CONTRACT comment (the frozen contract), or null. */
export function frozenContractHash(comments, trusted) {
  let h = null;
  for (const c of comments ?? []) {
    const b = String(c?.body ?? "");
    if (!b.startsWith("<!-- FORGE:CONTRACT -->") || !trusted(c)) continue;
    const fc = parseContractComment(b);
    if (fc?.hash) h = fc.hash;
  }
  return h;
}

/**
 * The orchestrate seam, bound to GitHub: `hash(n)` reads the issue and computes the input hash (null on any read failure: fail open),
 * `load(n)` reads the FORGE:ATTEMPTS comment, `mirror(n, ledger)` upserts it, `notify(...)` posts the one escalation or the no-new-input note.
 */
export function makeAttemptsSeam({ gh, repo, engineVersion = null, hostVersion = null, sandboxVersion = null, cfg = {}, trusted = null, contractHash = null }) {
  const view = async (n) => JSON.parse(String(await gh(["issue", "view", String(n), "-R", repo, "--json", "title,body,labels,comments"])));
  const isTrusted = async () => trusted ?? (await import("./prefilter.mjs")).isTrustedIssueComment;
  let seenSandbox = sandboxVersion;
  return {
    noteSandboxVersion(v) { if (v) seenSandbox = v; },
    cfg,
    async hash(n) {
      try {
        const v = await view(n), t = await isTrusted();
        const decisions = (v.comments ?? []).filter((c) => /^\s*<!--\s*FORGE:DECISION\b/.test(c?.body ?? "") && t(c)).map((c) => c.body);
        return computeInputHash({ title: v.title, body: v.body, labels: v.labels, decisions, engineVersion, sandboxVersion: seenSandbox ?? hostVersion, // the version the lane ran; the host's only when none is known
           contractHash: contractHash ? await contractHash(n) : frozenContractHash(v.comments, t) });
      } catch { return null; }
    },
    async load(n) {
      try { const c = findLeading((await view(n)).comments, ATTEMPTS_MARKER, await isTrusted()); return c ? parseAttempts(c.body) : null; } catch { return null; }
    },
    /** Upserts the ledger comment; returns the issue's engine comment count (for stats). */
    async mirror(n, ledger) {
      const t = await isTrusted();
      await postUpsert({ gh, repo, issue: n, markers: ATTEMPTS_MARKER, body: "", trusted: t, attrs: JSON.stringify(normalizeLedger(ledger)) });
      try { return engineCommentCount((await view(n)).comments, t); } catch { return null; }
    },
    async notify({ issue, code, ledger, reason, relabel = false }) {
      if (code === "escalate") {
        await postUpsert({ gh, repo, issue, markers: ESCALATION_MARKER, body: renderEscalation(ledger, reason), trusted: await isTrusted() });
        await gh(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]);
      } else {
        await postUpsert({ gh, repo, issue, markers: "FORGE:NO_NEW_INPUT", body: `${NO_NEW_INPUT}: ${reason}. Not readmitted; the existing label stays.`, trusted: await isTrusted() });
        if (relabel) await gh(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]).catch(() => {}); // the label stays: a removal without new input does not readmit
      }
    },
  };
}
