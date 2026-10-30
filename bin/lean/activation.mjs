// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4769: default-off rollouts must not ship dormant. Pure helpers: detect new off-by-default keys in a diff of a repo-declared
// rollout registry, require an activation row for them, check mode-naming acceptance criteria, and report dormant flags.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForgeYaml } from "../forge-utils.mjs";

export const DEFAULT_DORMANT_DAYS = 14;
const OFF = String.raw`(?:false|False|FALSE|0|off|OFF|null|None|""|''|"(?:false|off|0)"|'(?:false|off|0)')`;
const ENTRY_RE = new RegExp(String.raw`^["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*${OFF}\s*,?;?\s*(?:#.*|//.*)?$`);
const MODE_RE = /\b(shadow|cohort|treated)\b/i;
const flagRe = (flag) => new RegExp(`(^|[^\\w])${String(flag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`);

/** forge.yaml `rollouts: files: "a.json,b.py"` (comma-separated paths of the registry or env flag list) and `dormant_days`; null when absent. */
export function readRollouts(cwd, read = (p) => readFileSync(p, "utf8")) {
  let sec;
  try { sec = parseForgeYaml(read(join(cwd, "forge.yaml")))?.rollouts; } catch { return null; }
  const files = String(sec?.files ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!files.length) return null;
  const days = Number(sec?.dormant_days);
  return { files, days: Number.isFinite(days) && days > 0 ? days : DEFAULT_DORMANT_DAYS };
}

const inRegistry = (cfg, path) => (cfg?.files ?? []).some((f) => path === f || path.startsWith(f.endsWith("/") ? f : `${f}/`));

/** The keys a unified diff adds to a registry file with a default of off/false/0 (a key that is only changed, not new, is excluded). */
export function detectNewOffKeys(cfg, diffText) {
  if (!cfg?.files?.length) return [];
  const added = new Set(), seen = new Set();
  let path = null;
  for (const line of String(diffText ?? "").split("\n")) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m) { path = m[1].trim(); continue; }
    if (!path || !inRegistry(cfg, path) || !/^[+-][^+-]|^[+-]$/.test(line)) continue;
    const e = ENTRY_RE.exec(line.slice(1).trim());
    if (line[0] === "-") { const k = /^["']?([A-Za-z_][\w.-]*)["']?\s*[:=]/.exec(line.slice(1).trim()); if (k) seen.add(k[1]); }
    else if (e) added.add(e[1]);
  }
  return [...added].filter((k) => !seen.has(k)).sort();
}

const matches = (pattern, flag) => (pattern.endsWith("*") ? flag.startsWith(pattern.slice(0, -1)) : pattern === flag);
/** Whether a requirement is an activation row for `flag`: a defer `owner:promote:<flag>` bucket, or a deliver row whose why/evidence names it. */
export function coversFlag(r, flag) {
  const b = String(r?.bucket ?? "");
  if (r?.disposition === "defer" && b.startsWith("owner:promote:")) return matches(b.slice("owner:promote:".length), flag);
  return r?.disposition === "deliver" && flagRe(flag).test(`${r?.why ?? ""} ${r?.evidence ?? ""}`);
}
const uncovered = (contract, keys) => keys.filter((k) => !(contract?.requirements ?? []).some((r) => coversFlag(r, k)));

/** Conformance failures: every new off key needs an activation row; a requirement naming shadow/cohort/treated fails while its flag ships off uncovered. */
export function activationFailures(contract, keys) {
  const miss = uncovered(contract, keys ?? []);
  if (!miss.length) return [];
  const out = [{ kind: "activation_missing", detail: `default-off ${miss.join(", ")} added with no activation row: add a requirement with bucket owner:promote:<flag> (first cohort, guard metrics, shadow evidence) or a deliver row naming the flag` }];
  for (const r of contract?.requirements ?? []) {
    if (MODE_RE.test(String(r?.quote ?? "")) && r.disposition === "deliver") out.push({ kind: "mode_unreachable", detail: `${r.id} names ${MODE_RE.exec(r.quote)[1].toLowerCase()} mode but ${miss.join(", ")} ships off and no activation row covers it` });
  }
  return out;
}

/**
 * Dormancy report: introduced `[{flag, parent, since}]` (since: ms or ISO) that `flagState(flag)` (injected, read-only) says are still
 * "off" after `days`, minus flags with a recorded keep-off decision (`decisions`: `[{flag, decision:"keep-off"}]`, flag may end in `*`).
 */
export async function dormancyReport({ introduced = [], flagState, decisions = [], now = Date.now(), days = DEFAULT_DORMANT_DAYS }) {
  const kept = decisions.filter((d) => d?.decision === "keep-off").map((d) => String(d.flag));
  const out = [];
  for (const i of introduced) {
    const age = Math.floor((now - new Date(i.since).getTime()) / 86400e3);
    if (!(age >= days) || kept.some((k) => matches(k, i.flag))) continue;
    if (String(await flagState(i.flag)).toLowerCase() === "off") out.push({ flag: i.flag, parent: i.parent ?? null, days: age });
  }
  return out.sort((a, b) => b.days - a.days);
}
