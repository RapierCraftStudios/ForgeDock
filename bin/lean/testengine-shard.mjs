// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test engine, reports and sharding (#5710, Forge CI W3). Pure: text in, records and plans out.
 * - `parseReport` reads JUnit XML, TAP (`node --test` flavour: nested subtests, YAML `duration_ms` / `location`) or a
 *   `{file: seconds}` JSON map into one record per test case: {file, name, status, seconds}.
 * - `fileDurations` / `failedFiles` attribute records to the repo's known test files (path suffix, or a dotted pytest
 *   classname). A failure nothing attributes is reported as `unattributed`, never dropped.
 * - `planShards` is greedy LPT (longest processing time first onto the least-loaded shard). A file without a recorded
 *   duration gets the median of the known ones; with no history at all every file weighs 1, which is the file-count split.
 */
const xml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
const attrs = (s) => Object.fromEntries([...String(s).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], xml(m[2] ?? m[3] ?? "")]));
const secs = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const pathLike = (s) => /[/\\]/.test(String(s ?? "")) || /\.(py|[cm]?[jt]sx?)$/.test(String(s ?? ""));

/** JUnit XML -> records. The file is `file=` of the case or its suite, else a path-like classname or suite name, else the classname. */
export function parseJunit(text) {
  const out = [], suites = [];
  let cur = null;
  const close = () => { if (cur) { out.push(cur); cur = null; } };
  for (const m of String(text).matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, end, tag, raw, selfClose] = m;
    if (tag === "testsuite") { close(); if (end) suites.pop(); else if (!selfClose) suites.push(attrs(raw)); continue; }
    if (tag === "testcase") {
      close();
      if (end) continue;
      const a = attrs(raw), suite = suites.at(-1) ?? {};
      const file = a.file || suite.file || (pathLike(a.classname) ? a.classname : pathLike(suite.name) ? suite.name : a.classname || suite.name || "");
      cur = { file, name: a.name ?? "", status: "pass", seconds: secs(a.time) };
      if (selfClose) close();
      continue;
    }
    if (cur && !end) cur.status = tag === "skipped" ? (cur.status === "fail" ? "fail" : "skip") : "fail";
  }
  close();
  return out;
}

/** TAP -> records, one per leaf test point. A point that closes nested subtests is a suite: not counted, but its file is passed down. */
export function parseTap(text) {
  const out = [];
  let last = null; // the point whose YAML block may follow
  for (const line of String(text).split(/\r?\n/)) {
    const p = /^(\s*)(not ok|ok)\b(?:\s+\d+)?(?:\s+-)?\s*(.*)$/.exec(line);
    if (p) {
      const indent = p[1].length, directive = /#\s*(skip|todo)\b/i.exec(p[3])?.[1];
      // node prints the subtests first and their parent point after them, one level out
      const children = out.filter((r) => r.open && r.indent > indent);
      for (const r of children) r.open = false;
      last = { file: "", name: p[3].replace(/\s+#\s*(skip|todo)\b.*$/i, "").trim(), status: directive ? "skip" : p[2] === "ok" ? "pass" : "fail", seconds: 0, indent, open: true, children };
      out.push(last);
      continue;
    }
    if (!last) continue;
    if (/^\s*\.\.\.\s*$/.test(line)) { last = null; continue; }
    const y = /^\s*(duration_ms|location|file):\s*(.*)$/.exec(line);
    if (!y) continue;
    const v = y[2].replace(/^['"]|['"]$/g, "");
    if (y[1] === "duration_ms") last.seconds = secs(Number(v) / 1000);
    else if (y[1] === "file") last.file = v;
    else last.file = v.replace(/^file:\/\//, "").replace(/:\d+(:\d+)?$/, "");
  }
  for (const r of [...out].reverse()) { if (!r.file && pathLike(r.name)) r.file = r.name; if (r.file) for (const c of r.children) c.file ||= r.file; }
  return out.filter((r) => !r.children.length).map(({ file, name, status, seconds }) => ({ file, name, status, seconds }));
}

/** Any supported report text -> records (format by content). */
export function parseReport(text) {
  const t = String(text ?? "");
  if (/^\s*</.test(t)) return parseJunit(t);
  if (/^\s*\{/.test(t)) {
    try { return Object.entries(JSON.parse(t)).filter(([, v]) => typeof v === "number").map(([file, v]) => ({ file, name: "", status: "pass", seconds: secs(v) })); } catch { return []; }
  }
  return parseTap(t);
}

/** The known test file a report's `file` value names: exact, a path suffix either way, or a dotted pytest classname. Null unless unique. */
export function attributeFile(raw, known) {
  const v = String(raw ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!v) return null;
  const one = (hits) => (hits.length === 1 ? hits[0] : null);
  if (known.includes(v)) return v;
  const suffix = one(known.filter((k) => v.endsWith(`/${k}`) || k.endsWith(`/${v}`)));
  if (suffix) return suffix;
  if (/^[\w.]+$/.test(v)) {
    const parts = v.split(".");
    for (let k = parts.length; k >= 1; k--) {
      const p = `${parts.slice(0, k).join("/")}.py`;
      const hit = known.includes(p) ? p : one(known.filter((f) => f.endsWith(`/${p}`)));
      if (hit) return hit;
    }
  }
  return null;
}

/** Seconds per known test file (sum of its cases); files with no attributed record are absent. */
export function fileDurations(records, known) {
  const out = {};
  for (const r of records) { const f = attributeFile(r.file, known); if (f && r.seconds > 0) out[f] = (out[f] ?? 0) + r.seconds; }
  return out;
}

/** Failing test files of a run, plus the failures no known file could be attributed to (`name` or the raw file value). */
export function failedFiles(records, known) {
  const failed = new Set(), unattributed = [];
  for (const r of records) {
    if (r.status !== "fail") continue;
    const f = attributeFile(r.file, known);
    if (f) failed.add(f); else unattributed.push(r.file || r.name || "(unnamed test)");
  }
  return { failed: [...failed].sort(), unattributed: [...new Set(unattributed)] };
}

const round = (n) => Math.round(n * 10) / 10;

/**
 * Split `files` across shards by recorded duration, greedy LPT.
 * @param {{files: string[], durations?: Record<string, number>, shards?: number, targetS?: number, maxShards?: number}} p
 *   `shards` wins; else the count comes from `targetS` (ceil(total / target), capped by `maxShards` and the file count); else 1.
 * @returns {{shards: {index, files, est_s}[], matrix: {include: {shard, total, files}[]}, source: "durations"|"file-count",
 *   known: number, est_total_s: number, est_max_s: number, target_s: number, oversize: {file, s}[]}}
 */
export function planShards({ files, durations = {}, shards = 0, targetS = 0, maxShards = 0 }) {
  const list = [...new Set(files)].sort();
  const known = list.filter((f) => durations[f] > 0);
  const sorted = known.map((f) => durations[f]).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 1;
  const weight = (f) => (durations[f] > 0 ? durations[f] : median);
  const total = list.reduce((s, f) => s + weight(f), 0);
  let n = shards > 0 ? Math.floor(shards) : targetS > 0 ? Math.ceil(total / targetS) : 1;
  if (maxShards > 0) n = Math.min(n, Math.floor(maxShards));
  n = Math.max(1, Math.min(n, list.length || 1));
  const bins = Array.from({ length: n }, (_, i) => ({ index: i + 1, files: [], est_s: 0 }));
  for (const f of [...list].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const bin = bins.reduce((best, b) => (b.est_s < best.est_s ? b : best));
    bin.files.push(f); bin.est_s += weight(f);
  }
  for (const b of bins) { b.files.sort(); b.est_s = round(b.est_s); }
  return {
    shards: bins,
    matrix: { include: bins.map((b) => ({ shard: b.index, total: n, files: b.files.join(" ") })) },
    source: known.length ? "durations" : "file-count",
    known: known.length,
    est_total_s: round(total),
    est_max_s: Math.max(0, ...bins.map((b) => b.est_s)),
    target_s: targetS,
    oversize: targetS > 0 ? known.filter((f) => durations[f] > targetS).map((f) => ({ file: f, s: round(durations[f]) })) : [],
  };
}
