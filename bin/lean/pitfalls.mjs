// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4375: learned per-repo pitfalls. When a rework round (fixround.mjs REWORK_TRIGGERS) fixes a failure, i.e. the same gate
 * passes afterwards, the engine appends one record: trigger, a normalised failure signature, the fix's file globs and a
 * one-line lesson from the failure output. The context pack carries the top ones for the next lane in the same repo.
 * Deterministic: no model call. Local only: an append-only JSONL per repo under ~/.forge/pitfalls (FORGE_PITFALLS_DIR),
 * never posted to GitHub or telemetry. A cache in the NORTHSTAR sense: deleting it only forgets the lessons.
 * Records: {t:"lane", run, ts} once per lane (the aging clock) and {t:"pitfall", run, ts, sig, trigger, globs, lesson}.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { REWORK_TRIGGERS } from "./fixround.mjs";
import { matchesGlob } from "./verify.mjs";

export const DEFAULT_PITFALL_LANES = 50;
export const DEFAULT_PITFALL_LIMIT = 5;
export const LESSON_MAX = 160;
const MAX_GLOBS = 5;
const ERROR_LINE_RE = /\b(?:error|errors|fail(?:ed|ure|s)?|not ok|missing|stale|undeclared|collid\w*|cannot|unable|invalid|expected|assert\w*|exception|traceback|panic|denied)\b|✗|✖|×|\b[A-Z]{1,4}\d{3,5}\b/i;

const hash12 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** The failure output's first error-like line (ANSI and blank lines skipped), else its first non-empty line, else "". */
export function failureLine(text) {
  const lines = stripAnsi(text).split(/\r?\n/).map(squash).filter((l) => l && !/^[-=#*`~>]+$/.test(l));
  return lines.find((l) => ERROR_LINE_RE.test(l)) ?? lines[0] ?? "";
}

/**
 * The repeat-stable form of a failure line: quoted literals, file paths (with :line:col), hex ids and standalone numbers
 * are replaced, so the same rule on another file or line gives the same signature. Rule codes (F401, TS2345) are kept.
 */
export function normaliseFailure(line) {
  return squash(String(line ?? "")
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, "<str>")
    .replace(/(?:[\w.@~-]+[/\\])*[\w.@~-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)*/g, "<path>")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)*\b/g, "<n>")
    .toLowerCase());
}

/** `trigger:` + a 12-hex hash of the normalised failure line. */
export const signatureOf = (trigger, text) => `${trigger}:${hash12(normaliseFailure(failureLine(text)))}`;

/** One line (at most LESSON_MAX chars) from the failure output, prefixed with the trigger. */
export function lessonOf(trigger, text) {
  const t = `${trigger}: ${failureLine(text)}`;
  return t.length > LESSON_MAX ? `${t.slice(0, LESSON_MAX - 1)}…` : t;
}

/** The fix's changed files as globs: `dir/*.ext` (`dir/*` without an extension), a root file by name; `.forge-lean/` left out. */
export function fixGlobs(files) {
  const out = [];
  for (const f of files ?? []) {
    const p = String(f ?? "").trim().replace(/^\.?\//, "");
    if (!p || p.startsWith(".forge-lean/")) continue;
    const d = dirname(p), base = p.split("/").at(-1);
    const g = d === "." ? base : `${d}/*${extname(base)}`;
    if (!out.includes(g)) out.push(g);
    if (out.length >= MAX_GLOBS) break;
  }
  return out;
}

/** Failure text from a gate's failure list: strings, CI jobs ({job, log}) or conformance rows ({code, detail}). */
export const failureLog = (failures) => (Array.isArray(failures) ? failures : []).map((f) => (typeof f === "string" ? f
  : [f?.code, f?.detail, f?.log ? `${f.job ?? ""}\n${f.log}` : f?.job].filter(Boolean).join(" "))).join("\n");

/** A pending pitfall for a rework round, or null (not a rework trigger, or no failure text to learn from). */
export function pendingPitfall(trigger, text) {
  if (!REWORK_TRIGGERS.includes(trigger) || !failureLine(text)) return null;
  return { trigger, sig: signatureOf(trigger, text), lesson: lessonOf(trigger, text) };
}

/** The ledger record for a pending pitfall whose gate passed; `files` are the files the fix changed. */
export const pitfallRecord = ({ pending, files, run, ts }) => ({ t: "pitfall", run: String(run), ts, sig: pending.sig, trigger: pending.trigger, globs: fixGlobs(files), lesson: pending.lesson });

const byRank = (a, b) => b.count - a.count || String(b.lastTs ?? "").localeCompare(String(a.lastTs ?? "")) || a.sig.localeCompare(b.sig);

/**
 * One entry per signature {sig, trigger, globs, lesson, count, lastSeq, lastTs}, ranked by count, then recency. The lane
 * sequence is the order of distinct `lane` rows; an entry not seen in the last `maxAge` lanes ages out. One lane counts
 * a signature once.
 */
export function foldPitfalls(records, { maxAge = DEFAULT_PITFALL_LANES } = {}) {
  const lanes = new Map(), bySig = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r !== "object") continue;
    if (r.t === "lane") { if (!lanes.has(String(r.run))) lanes.set(String(r.run), lanes.size); continue; }
    if (r.t !== "pitfall" || typeof r.sig !== "string" || !r.sig) continue;
    const seq = lanes.get(String(r.run)) ?? Math.max(0, lanes.size - 1);
    const e = bySig.get(r.sig) ?? { sig: r.sig, trigger: String(r.trigger ?? ""), globs: [], lesson: "", count: 0, lastSeq: seq, lastTs: null, lastRun: null };
    if (e.lastRun !== String(r.run)) e.count++;
    e.lastRun = String(r.run); e.lastSeq = Math.max(e.lastSeq, seq); e.lastTs = r.ts ?? e.lastTs;
    e.lesson = typeof r.lesson === "string" && r.lesson ? r.lesson : e.lesson;
    for (const g of Array.isArray(r.globs) ? r.globs : []) if (typeof g === "string" && g && !e.globs.includes(g) && e.globs.length < MAX_GLOBS) e.globs.push(g);
    bySig.set(r.sig, e);
  }
  const total = lanes.size;
  return [...bySig.values()].filter((e) => total - 1 - e.lastSeq < maxAge).map(({ lastRun, ...e }) => e).sort(byRank);
}

/** Up to `limit` pitfalls: those whose globs match one of `paths` (match "files") first, then the rest (match "repo"). */
export function selectPitfalls(folded, { paths = [], limit = DEFAULT_PITFALL_LIMIT } = {}) {
  const hits = (p) => p.globs.some((g) => paths.some((f) => matchesGlob(f, g)));
  const files = folded.filter(hits).sort(byRank).map((p) => ({ ...p, match: "files" }));
  const repo = folded.filter((p) => !hits(p)).sort(byRank).map((p) => ({ ...p, match: "repo" }));
  return [...files, ...repo].slice(0, limit);
}

// ---- file store (I/O) ----

export const pitfallsDir = (env = process.env) => env.FORGE_PITFALLS_DIR || join(homedir(), ".forge", "pitfalls");
const segment = (s) => { const v = String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_"); return !v || /^\.+$/.test(v) ? "_" : v; };
export const pitfallsFile = (repo, dir = pitfallsDir()) => join(dir, `${String(repo ?? "").split("/").map(segment).join("__")}.jsonl`);

/** {read(repo) → records (corrupt lines skipped, missing file → []), append(repo, rec)}: one line per append. */
export function makePitfallStore({ dir = pitfallsDir() } = {}) {
  return {
    read(repo) {
      const f = pitfallsFile(repo, dir);
      if (!existsSync(f)) return [];
      return readFileSync(f, "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && typeof x === "object");
    },
    append(repo, rec) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(pitfallsFile(repo, dir), `${JSON.stringify(rec)}\n`);
    },
  };
}
