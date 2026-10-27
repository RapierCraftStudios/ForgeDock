// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Versioned outbound lifecycle events (#4630, docs/EVENTS.md). The engine hands the same run-log shaped records it gives
 * the telemetry seam to `makeEventEmitter`, which maps them to a stable envelope, appends it to a local JSONL file and,
 * when forge.yaml `events.webhook_url` and the secret env var are both set, POSTs it signed with HMAC-SHA256. No model call.
 * The emitter NEVER throws; FORGE_EVENTS=off disables it. Values are ids, counts, codes and costs only.
 */
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EVENT_SCHEMA = "forgedock.event";
export const EVENT_VERSION = 1;
export const DEFAULT_SECRET_ENV = "FORGE_EVENTS_SECRET";
export const WEBHOOK_TIMEOUT_MS = 5000;

/** type -> data keys (documented in docs/EVENTS.md; the contract test pins them). */
export const EVENT_TYPES = {
  "lane.picked_up": ["lane", "path"],
  "contract.frozen": ["hash", "requirements", "deferred", "derived"],
  "pr.opened": [],
  "pr.merged": ["milestone", "code"],
  "release.promoted": ["fix", "default_branch"],
  "probe.passed": ["detail", "fix"],
  "probe.failed": ["detail", "fix"],
  "regression.detected": ["subject", "metric", "detail"],
  "experiment.verdict": ["experiment", "verdict", "detail"],
};

const scalar = (v) => (typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean" || (typeof v === "string" && v !== ""));
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const pickData = (type, src) => Object.fromEntries(EVENT_TYPES[type].filter((k) => scalar(src?.[k])).map((k) => [k, typeof src[k] === "string" ? src[k].slice(0, 200) : src[k]]));

/** Envelope for one event; null for an unknown type. `ctx` = {repo, issue, run, pr, cost_usd, wall_ms}. */
export function buildEvent(type, data = {}, ctx = {}, now = new Date()) {
  if (!Object.hasOwn(EVENT_TYPES, type)) return null;
  const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
  return {
    schema: EVENT_SCHEMA, v: EVENT_VERSION, id: `${Math.floor(now.getTime() / 1000)}-${randomBytes(6).toString("hex")}`, type,
    ts: now.toISOString().replace(/\.\d+Z$/, "Z"), repo: ctx.repo ?? null, issue: int(ctx.issue), pr: int(ctx.pr), run: ctx.run ?? null,
    ...(Number.isFinite(ctx.cost_usd) ? { cost_usd: round6(ctx.cost_usd) } : {}), ...(Number.isFinite(ctx.wall_ms) ? { wall_ms: Math.round(ctx.wall_ms) } : {}),
    data: pickData(type, data),
  };
}

/** Probe sweep row ({issue, outcome, detail, fix}) -> event type + data; null unless pass or fail. */
export function probeEvent(row) {
  if (row?.outcome !== "pass" && row?.outcome !== "fail") return null;
  return { type: row.outcome === "pass" ? "probe.passed" : "probe.failed", data: { detail: row.detail, fix: row.fix }, ctx: { issue: row.issue } };
}

/** Monitor sweep row ({issue, outcome, detail, regression}) -> regression.detected; null unless a fail that filed a regression issue. */
export function regressionEvent(row) {
  if (row?.outcome !== "fail" || !Number.isSafeInteger(row.regression) || row.regression < 1) return null;
  return { type: "regression.detected", data: { subject: `post-deploy check of #${row.issue}`, metric: "post_deploy_check", detail: row.detail }, ctx: { issue: row.issue } };
}

/** Experiment report ({id, targets, targets_met}) -> experiment.verdict (met | missed | inconclusive); null without an id. */
export function experimentEvent(report) {
  if (!report || typeof report.id !== "string" || !report.id) return null;
  const passes = Object.values(report.targets ?? {}).map((t) => t?.pass);
  const verdict = report.targets_met === true ? "met" : passes.includes(false) ? "missed" : "inconclusive";
  return { type: "experiment.verdict", data: { experiment: report.id, verdict, detail: `${passes.length} target(s)` }, ctx: {} };
}

/** A fix reached the default branch -> release.promoted; null without a fix. Emitted by the probe sweep (probeSweepEvents). */
export function promotedEvent({ fix, default_branch } = {}) {
  return typeof fix === "string" && fix ? { type: "release.promoted", data: { fix, default_branch }, ctx: {} } : null;
}

/**
 * Events for one probe-sweep row. A probe pass/fail row proves the fix is on the default branch (probeIssue gates on onDefault) and is
 * recorded once per fix, so it also yields release.promoted. Monitor rows carry no defaultBranch and never do (they repeat per window).
 */
export function probeSweepEvents(row) {
  const promoted = row?.defaultBranch && (row.outcome === "pass" || row.outcome === "fail") ? promotedEvent({ fix: row.fix, default_branch: row.defaultBranch }) : null;
  return [probeEvent(row), regressionEvent(row), promoted && { ...promoted, ctx: { issue: row.issue } }].filter(Boolean);
}

/**
 * Pure mapping of one run-log record to {type, data, ctx} or null. `cost` is the lane's running spend, kept by the caller
 * from PHASE_ATTEMPT_USAGE (`cost_usd_delta` when present, else `cost_usd`).
 */
export function mapRunRecord(rec, { cost = 0 } = {}) {
  if (!rec || typeof rec !== "object") return null;
  switch (rec.event) {
    case "RUN_START": return { type: "lane.picked_up", data: rec, ctx: {} };
    case "CONTRACT_FROZEN": return { type: "contract.frozen", data: rec, ctx: {} };
    case "PR_OPENED": return { type: "pr.opened", data: {}, ctx: { pr: rec.pr } };
    case "RUN_TERMINAL":
      if (rec.reason !== "merged") return null;
      return { type: "pr.merged", data: rec, ctx: { pr: rec.pr, cost_usd: cost, wall_ms: rec.wall_ms } };
    default: return null;
  }
}

/** HMAC-SHA256 hex of `${ts}.${body}`; the receiver recomputes it from X-Forge-Timestamp and the raw body. */
export const sign = (secret, ts, body) => createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

/** https, or http only for a loopback host; anything else is not a usable webhook. */
export function webhookUrlOk(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}

/** POST one envelope; resolves true on 2xx. Never throws. */
export async function postWebhook(event, { url, secret, fetchFn = globalThis.fetch, timeoutMs = WEBHOOK_TIMEOUT_MS, now = Date.now } = {}) {
  try {
    if (!url || !secret || !webhookUrlOk(url) || typeof fetchFn !== "function") return false;
    const body = JSON.stringify(event);
    const ts = String(Math.floor(now() / 1000));
    const res = await fetchFn(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", "x-forge-event": event.type, "x-forge-timestamp": ts, "x-forge-signature": `sha256=${sign(secret, ts, body)}` }, body });
    return Boolean(res?.ok);
  } catch { return false; }
}

/** Local sink path: `dir` (config or FORGE_EVENTS_DIR), else ~/.forge/events; one file per repo. */
export const sinkPath = (repo, dir) => join(dir || join(homedir(), ".forge", "events"), `${String(repo || "unknown").replace(/[^\w.-]/g, "_")}.jsonl`);

/**
 * @param {{repo?: string|null, config?: {webhookUrl?: string, secretEnv?: string, dir?: string}, env?: object, fetchFn?: Function, now?: () => Date, run?: string}} o
 * @returns {{emit: (rec: object) => Promise<void>, emitEvent: (type: string, data?: object, ctx?: object) => Promise<object|null>}}
 */
export function makeEventEmitter({ repo = null, config = {}, env = process.env, fetchFn, now = () => new Date(), run = null } = {}) {
  let cost = 0, runId = run;
  const off = () => (env.FORGE_EVENTS || "on") === "off";
  async function emitEvent(type, data = {}, ctx = {}) {
    try {
      if (off()) return null;
      const ev = buildEvent(type, data, { repo, run: runId, ...ctx }, now());
      if (!ev) return null;
      try {
        const file = sinkPath(repo, env.FORGE_EVENTS_DIR || config.dir);
        mkdirSync(join(file, ".."), { recursive: true });
        appendFileSync(file, `${JSON.stringify(ev)}\n`);
      } catch { /* a lost local line costs completeness only */ }
      const secret = env[config.secretEnv || DEFAULT_SECRET_ENV];
      if (config.webhookUrl && secret) await postWebhook(ev, { url: config.webhookUrl, secret, fetchFn, now: () => now().getTime() });
      return ev;
    } catch { return null; }
  }
  async function emit(rec) {
    try {
      if (rec?.event === "PHASE_ATTEMPT_USAGE") {
        const c = Number.isFinite(rec.cost_usd_delta) ? rec.cost_usd_delta : rec.cost_usd;
        if (Number.isFinite(c)) cost += c;
        return;
      }
      if (rec?.event === "RUN_START" && typeof rec.run === "string") runId = rec.run;
      const m = mapRunRecord(rec, { cost });
      if (!m) return;
      await emitEvent(m.type, m.data, { issue: rec.issue, ...m.ctx });
    } catch { /* events never fail a run */ }
  }
  return { emit, emitEvent };
}
