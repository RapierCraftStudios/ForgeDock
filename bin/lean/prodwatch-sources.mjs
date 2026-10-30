// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Production signal adapters for `prod_watch` (#4833, part of #4768). Each `prod_watch.sources` entry is a set of shell
 * commands that print JSON or text; the adapters turn that into one normalised signal shape
 * `{id, source, title, severity, owner, first_seen, last_seen, body, query?}`. Read-only by contract: `runAdapter` executes
 * only the declared `list`/`read`/`run` commands through the injected `io.exec`; `close` is reachable only through
 * `closeSignal`, which refuses without an audit record and writes it before the command runs. Pure apart from `io`
 * (`exec`, `audit`, `now`); no LLM, no fs, no network of its own. Repo-agnostic: the commands come from forge.yaml (#1347).
 */

const KINDS = ["memo", "alertmanager", "sql", "prometheus"];
const SOURCE_KEYS = ["kind", "list", "read", "close", "run", "queries"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,199}$/; // ids come from command output (untrusted): never shell-active
const SAFE_QUERY = /^[^'"`$;|&<>\\\n\r]+$/; // queries come from config but still must not break out of the command
const SAFE_REASON = /^[A-Za-z0-9 ._,:#()/-]{1,200}$/;
const SEVERITIES = { p0: "P0", p1: "P1", p2: "P2", p3: "P3", critical: "P0", page: "P0", high: "P1", error: "P1", warning: "P2", medium: "P2", low: "P3", info: "P3" };
const MAX_IDS = 500, MAX_BODY = 4000;

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const iso = (v) => { if (v == null || v === "") return null; const d = new Date(typeof v === "number" && v < 1e11 ? v * 1000 : v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
export const normalizeSeverity = (v) => SEVERITIES[String(v ?? "").trim().toLowerCase()] ?? "unknown";
const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const parseJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

/** The normalised signal; `raw` supplies the fields (already mapped by a per-kind normaliser), `source` is `{name}`. */
export function normalizeSignal(raw, source) {
  const r = raw ?? {};
  const out = {
    id: String(r.id ?? ""),
    source: String(source?.name ?? r.source ?? ""),
    title: String(r.title ?? r.id ?? "").slice(0, 300),
    severity: normalizeSeverity(r.severity),
    owner: isStr(r.owner) ? r.owner : null,
    first_seen: iso(r.first_seen),
    last_seen: iso(r.last_seen ?? r.first_seen),
    body: String(r.body ?? "").slice(0, MAX_BODY),
  };
  if (r.query != null) out.query = String(r.query);
  return out;
}

/** Validate the `prod_watch.sources` map (or `{prod_watch:{sources}}`) into `[{name, kind, list?, read?, close?, run?, queries?}]`; throws on bad config. */
export function parseSources(cfg) {
  const map = cfg?.prod_watch?.sources ?? cfg?.sources ?? cfg;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("prod_watch.sources must be a map of name -> source");
  return Object.entries(map).map(([name, s]) => {
    if (!s || typeof s !== "object") throw new Error(`source ${name}: must be a map`);
    for (const k of Object.keys(s)) if (!SOURCE_KEYS.includes(k)) throw new Error(`source ${name}: unknown key ${k}`);
    for (const k of ["list", "read", "close", "run"]) if (s[k] != null && !isStr(s[k])) throw new Error(`source ${name}: ${k} must be a command string`);
    const kind = s.kind ?? (s.list && s.read ? "memo" : s.run && s.queries ? "sql" : null);
    if (!KINDS.includes(kind)) throw new Error(`source ${name}: cannot infer kind (set kind: ${KINDS.join("|")})`);
    const out = { name, kind };
    for (const k of ["list", "read", "close", "run"]) if (s[k]) out[k] = s[k];
    if (kind === "memo" && !(out.list && out.read)) throw new Error(`source ${name}: memo needs list and read`);
    if (kind !== "memo" && !out.run) throw new Error(`source ${name}: ${kind} needs run`);
    if (kind === "sql" || kind === "prometheus") {
      if (!Array.isArray(s.queries) || !s.queries.length) throw new Error(`source ${name}: ${kind} needs queries`);
      out.queries = s.queries.map((q, i) => {
        const n = kind === "sql" ? (typeof q === "string" ? { name: q, sql: q } : q) : q;
        const text = kind === "sql" ? n?.sql ?? n?.name : n?.expr;
        if (!n || typeof n !== "object" || !isStr(text) || !SAFE_QUERY.test(text)) throw new Error(`source ${name}: query ${i} is missing or has shell-active characters`);
        if (kind === "sql") return { name: String(n.name ?? text), sql: text };
        if (!Number.isFinite(Number(n.threshold))) throw new Error(`source ${name}: prometheus query ${i} needs a numeric threshold`);
        const op = n.op ?? ">";
        if (![">", ">=", "<", "<="].includes(op)) throw new Error(`source ${name}: prometheus query ${i} has a bad op`);
        return { name: String(n.name ?? text), expr: text, threshold: Number(n.threshold), op };
      });
    } else if (s.queries != null) throw new Error(`source ${name}: queries only apply to sql/prometheus`);
    return out;
  });
}

// ── per-kind normalisers (pure: command output -> signals) ──────────────────────────────────────────────────────
const sevFromText = (t) => /\bseverity\W+(\w+)/i.exec(t)?.[1];
/** One memo (`read` output: JSON object or free text) -> signal. */
export function normalizeMemo(id, text, source) {
  const j = parseJson(text);
  if (j && typeof j === "object" && !Array.isArray(j)) return normalizeSignal({ ...j, id: j.id ?? id, body: j.body ?? text }, source);
  const t = String(text ?? "");
  return normalizeSignal({ id, title: t.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() || id, severity: sevFromText(t), owner: /\bowner\W+([\w.@-]+)/i.exec(t)?.[1], body: t }, source);
}
/** Alertmanager v2 `GET /alerts` JSON (array) -> signals; id is the alert fingerprint. */
export function normalizeAlertmanager(json, source) {
  const arr = Array.isArray(json) ? json : [];
  return arr.map((a) => normalizeSignal({
    id: a.fingerprint ?? a.labels?.alertname, title: a.labels?.alertname ?? a.annotations?.summary, severity: a.labels?.severity, owner: a.labels?.team ?? a.labels?.owner,
    first_seen: a.startsAt, last_seen: a.updatedAt ?? a.startsAt, body: [a.annotations?.summary, a.annotations?.description].filter(Boolean).join("\n") || JSON.stringify(a.labels ?? {}),
  }, source));
}
/** SQL result rows (array, or `{rows}`) of query `q` -> one signal per row. */
export function normalizeSql(json, q, source) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.rows) ? json.rows : [];
  return rows.map((r, i) => normalizeSignal({
    id: `${q.name}:${r.id ?? r.key ?? i}`, title: r.title ?? q.name, severity: r.severity, owner: r.owner, first_seen: r.first_seen, last_seen: r.last_seen, body: JSON.stringify(r), query: q.name,
  }, source));
}
const crosses = (v, op, t) => (op === ">" ? v > t : op === ">=" ? v >= t : op === "<" ? v < t : v <= t);
/** Prometheus instant-vector JSON (`{data:{result}}` or the bare result array) -> a signal per sample that crosses `q.threshold`. */
export function normalizePrometheus(json, q, source, now = Date.now()) {
  const res = Array.isArray(json) ? json : json?.data?.result ?? [];
  return res.flatMap((s) => {
    const v = Number(Array.isArray(s.value) ? s.value[1] : s.value);
    if (!Number.isFinite(v) || !crosses(v, q.op, q.threshold)) return [];
    const labels = s.metric ?? {};
    return [normalizeSignal({
      id: `${q.name}:${Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",") || "all"}`.replace(/[^A-Za-z0-9._:@=,-]/g, "_"), title: `${q.name} ${q.op} ${q.threshold}`,
      severity: labels.severity, owner: labels.team ?? labels.owner, first_seen: now, last_seen: now, body: `${q.name}=${v} (${q.op} ${q.threshold}) ${JSON.stringify(labels)}`, query: q.expr,
    }, source)];
  });
}

/** Run one source's declared read commands; returns `{signals, errors}`. Executes only `list`/`read`/`run`, never `close`. */
export async function runAdapter(source, io) {
  const signals = [], errors = [];
  const exec = async (cmd) => { const r = await io.exec(cmd); if (r?.code !== 0) throw new Error(`exit ${r?.code ?? "?"}`); return String(r.stdout ?? ""); };
  const guard = async (label, fn) => { try { await fn(); } catch (e) { errors.push(`${source.name}: ${label}: ${e.message}`); } };
  if (source.kind === "memo") {
    await guard("list", async () => {
      const out = await exec(source.list);
      const j = parseJson(out);
      const ids = (Array.isArray(j) ? j.map(String) : out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      if (ids.length > MAX_IDS) errors.push(`${source.name}: list truncated to ${MAX_IDS} of ${ids.length}`);
      for (const id of ids.slice(0, MAX_IDS)) {
        if (!SAFE_ID.test(id)) { errors.push(`${source.name}: skipped unsafe id`); continue; }
        await guard(`read ${id}`, async () => signals.push(normalizeMemo(id, await exec(fill(source.read, { id })), source)));
      }
    });
  } else if (source.kind === "alertmanager") {
    await guard("run", async () => {
      const j = parseJson(await exec(source.run));
      if (j === undefined) throw new Error("output is not JSON");
      signals.push(...normalizeAlertmanager(j, source));
    });
  } else {
    for (const q of source.queries ?? []) {
      await guard(`run ${q.name}`, async () => {
        const j = parseJson(await exec(fill(source.run, source.kind === "sql" ? { sql: q.sql, query: q.sql } : { expr: q.expr, query: q.expr })));
        if (j === undefined) throw new Error("output is not JSON");
        signals.push(...(source.kind === "sql" ? normalizeSql(j, q, source) : normalizePrometheus(j, q, source, io.now?.() ?? Date.now())));
      });
    }
  }
  return { signals, errors };
}

/**
 * The only path to a source's `close` command. Needs `source.close`, a safe signal id and reason, an `audit` record
 * `{by}` and an `io.audit(record)` sink; the record is written BEFORE the command runs (a failing sink aborts the close).
 * Returns `{ok, code}`.
 */
export async function closeSignal(source, signal, { issue, reason, audit } = {}, io = {}) {
  if (!source?.close) throw new Error(`source ${source?.name}: no close command declared`);
  if (!audit || !isStr(audit.by)) throw new Error("closeSignal requires an audit record {by}");
  if (typeof io.audit !== "function") throw new Error("closeSignal requires io.audit");
  if (!SAFE_ID.test(String(signal?.id ?? ""))) throw new Error("closeSignal: unsafe signal id");
  if (!SAFE_REASON.test(String(reason ?? ""))) throw new Error("closeSignal: reason missing or has shell-active characters");
  if (!/^\d+$/.test(String(issue ?? ""))) throw new Error("closeSignal: issue must be a number");
  const at = new Date(io.now?.() ?? Date.now()).toISOString();
  await io.audit({ event: "close", source: source.name, id: signal.id, issue: Number(issue), reason, by: audit.by, at });
  const r = await io.exec(fill(source.close, { id: signal.id, issue: String(issue), reason }));
  const ok = r?.code === 0;
  try { await io.audit({ event: "close_result", source: source.name, id: signal.id, ok, code: r?.code ?? null, at }); } catch { /* the pre-exec record already stands */ }
  return { ok, code: r?.code ?? null };
}
