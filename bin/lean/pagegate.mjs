// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5428: the page gate. A diff that adds or changes a public page needs an approved design (FORGE:DESIGN_SPEC), an SEO intent/ICP brief
 * and a GEO brief in the contract (`page_gate`), and passes deterministic checks (sitemap, metadata, canonical, structured data, internal
 * links, forbidden raw-JSON/null-sample patterns). forge.yaml `pages: {enabled, routes, icp_doc, require, sitemap, metadata_patterns,
 * canonical_patterns, structured_data_patterns, forbid_patterns, lint}`. On by default only for repos with Next `app/**\/page.*` files;
 * `enabled: false` or no pages = off. Deterministic, 0 LLM calls; core stays repo-agnostic (#1347), like docsgate.mjs.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";
import { routePathOf } from "./routecheck.mjs";

export const PAGE_REQUIRE = Object.freeze(["design", "seo_intent", "geo"]);
export const PAGE_RE = /(?:^|\/)app\/(?:.*\/)?page\.[cm]?[jt]sx?$/;
const TEST_RE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DEFAULTS = {
  sitemap: ["**/sitemap.*", "**/sitemap*.xml"],
  metadata: ["export\\s+const\\s+metadata\\b", "generateMetadata", "<title[ >]"],
  canonical: ["canonical"],
  structured: ["application/ld\\+json", "json-?ld"],
  forbid: ["\\[\\[null\\]\\]", "Success rate\\s*0\\.0%", "catalog temporarily unavailable", "JSON\\.stringify\\([^)]*,\\s*null,\\s*2\\)"],
};
const norm = (p) => String(p ?? "").trim().replace(/^\.\//, "");
const blank = (v) => v == null || (typeof v === "string" ? !v.trim() : Array.isArray(v) ? !v.length : false);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\[|\]$/g, "").split(",") : []).map((x) => String(x ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim()).filter(Boolean);
const anyGlob = (globs, f) => globs.some((g) => globToRegex(g).test(f));
const regexes = (src) => src.flatMap((s) => { try { return [new RegExp(s, "i")]; } catch { return []; } });

/** forge.yaml pages: -> config, or null when off. `hasAppPages`: the repo tracks Next app/**\/page.* files (default-on trigger). */
export function parsePagesConfig(raw, { hasAppPages = false } = {}) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (obj.enabled === false || String(obj.enabled).toLowerCase() === "false") return null;
  const routes = list(obj.routes).map(norm);
  if (!hasAppPages && !routes.length) return null;
  const req = list(obj.require).map((k) => k.toLowerCase()).filter((k) => PAGE_REQUIRE.includes(k));
  const pick = (v, d) => { const l = list(v); return l.length ? l : d; };
  return {
    routes, icp_doc: typeof obj.icp_doc === "string" && obj.icp_doc.trim() ? obj.icp_doc.trim() : null,
    require: raw && obj.require !== undefined && req.length ? [...new Set(req)] : [...PAGE_REQUIRE],
    sitemap: pick(obj.sitemap, DEFAULTS.sitemap).map(norm), metadata_patterns: pick(obj.metadata_patterns, DEFAULTS.metadata),
    canonical_patterns: pick(obj.canonical_patterns, DEFAULTS.canonical), structured_data_patterns: pick(obj.structured_data_patterns, DEFAULTS.structured),
    forbid_patterns: pick(obj.forbid_patterns, DEFAULTS.forbid), lint: typeof obj.lint === "string" && obj.lint.trim() ? obj.lint.trim() : null,
  };
}

/** The public page files among `files`: built-in Next `app/**\/page.*` plus `pages.routes` globs, tests excluded. */
export function pageFiles(files, cfg) {
  if (!cfg) return [];
  return [...new Set((files ?? []).map(norm).filter((f) => f && !TEST_RE.test(f) && (PAGE_RE.test(f) || anyGlob(cfg.routes, f))))];
}

const present = (o, ks) => ks.filter((k) => blank(o?.[k]));

/** Contract-time problems: a deliverable that is a page needs `page_gate` {design_spec, seo, geo} per `pages.require`. [] when off or no page deliverable. */
export function contractBriefProblems(contract, cfg) {
  const pages = pageFiles((contract?.deliverables ?? []).map((d) => d?.path), cfg);
  if (!pages.length) return [];
  const g = contract?.page_gate, out = [], at = `deliverable page ${pages.slice(0, 3).join(", ")} needs contract.page_gate`;
  if (!g || typeof g !== "object" || Array.isArray(g)) return [`${at}: {"design_spec":"<FORGE:DESIGN_SPEC ref>","seo":{...},"geo":{...}} (forge.yaml pages.require: ${cfg.require.join(", ")})`];
  if (cfg.require.includes("design") && blank(g.design_spec)) out.push(`${at}.design_spec: the approved FORGE:DESIGN_SPEC (run /design first; issue or comment ref)`);
  if (cfg.require.includes("seo_intent")) {
    const miss = present(g.seo, ["intent", "icp", "title", "h1", "meta", "structured_data", "links_in", "links_out", "gsc_baseline", "measure_by"]);
    if (miss.length) out.push(`${at}.seo is missing ${miss.join(", ")} (target query/intent, named ICP${cfg.icp_doc ? ` from ${cfg.icp_doc}` : ""}, title/H1/meta, structured data type, internal links in/out, GSC baseline, measure-by date)`);
  }
  if (cfg.require.includes("geo")) {
    const miss = present(g.geo, ["surfaces", "agent_question"]);
    if (miss.length) out.push(`${at}.geo is missing ${miss.join(", ")} (llms.txt/llms-full/markdown mirror/ai-catalog/MCP surfaces and a natural-language agent question that resolves to the page)`);
  }
  return out;
}

/** True when the issue comments carry a FORGE:DESIGN_SPEC that is not marked draft/rejected; false when none. */
export function designSpecApproved(comments) {
  return (comments ?? []).map((c) => String(c?.body ?? c ?? "")).some((b) => b.includes("FORGE:DESIGN_SPEC") && !/"?(?:status|approved)"?\s*[:=]\s*"?(?:draft|rejected|false)/i.test(b));
}

/** #5442: the first `design:*` label before approval (`design:needed`...), or null; `design:approved` lifts the hold. */
export function designHold(labels) {
  const names = (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  return names.includes("design:approved") ? null : names.find((n) => n.startsWith("design:")) ?? null;
}
/** #5442: true when the `design:approved` label is on the issue. */
export const designLabelApproved = (labels) => (labels ?? []).some((l) => (typeof l === "string" ? l : l?.name) === "design:approved");

/** Added lines per file from a unified diff. */
export function addedByFile(diff) {
  const out = {}; let cur = null;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+++ ")) { cur = line.replace(/^\+\+\+ (?:b\/)?/, "").trim(); if (cur === "/dev/null") cur = null; continue; }
    if (cur && line.startsWith("+")) (out[cur] ??= []).push(line.slice(1));
  }
  return out;
}

/** URL path served by a Next page file, or null. */
export function pageRouteOf(file) {
  const m = /(?:^|\/)app\/(?:(.*)\/)?page\.[cm]?[jt]sx?$/.exec(String(file ?? ""));
  return m ? `/${(m[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/")}` : null;
}
const routeRe = (r) => new RegExp(`^${r.split("/").map((s) => (/^\[\[?\.\.\.|^\[/.test(s) ? "[^/]*(?:/.*)?" : s.replace(/[.+^${}()|\\]/g, "\\$&"))).join("/")}$`.replace("/[^/]*(?:/.*)?$", "(?:/.*)?$"));
const LINK_RE = /href\s*=\s*\{?\s*["'`](\/[^"'`#?\s{}$]*)/g;

/**
 * Blocking failures (conformance.unimplemented) for the pages a diff adds or changes. `readFile(path)` returns worktree content or "";
 * `tracked` the repo's files; `designApproved` true/false/null (unknown skips); `run({command})` -> {rc, output} for `pages.lint`.
 */
export async function pageFailures({ cfg, files = [], diff = "", result = null, readFile = () => "", tracked = null, designApproved = null, run = null }) {
  const pages = pageFiles(files, cfg);
  if (!cfg || !pages.length) return [];
  const C = OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, out = [], j = result?.page_gate ?? {};
  const row = (kind, detail) => out.push({ code: C, kind, detail });
  if (cfg.require.includes("design")) {
    if (designApproved === false) row("page_design_missing", `${pages.slice(0, 3).join(", ")} is a public page but the issue has no approved FORGE:DESIGN_SPEC: run /design before building`);
    const shots = list(j.screenshots).join(" ");
    if (!/390/.test(shots) || !/1440/.test(shots)) row("page_visual_missing", `${pages.slice(0, 3).join(", ")}: the result's page_gate.screenshots must name a 390px and a 1440px visual check attached to the PR`);
  }
  const all = [...new Set([...(tracked ?? []), ...files].map(norm))];
  if (cfg.require.includes("seo_intent")) {
    const meta = regexes(cfg.metadata_patterns), canon = regexes(cfg.canonical_patterns), sd = regexes(cfg.structured_data_patterns);
    for (const f of pages) {
      const dir = f.split("/").slice(0, -1);
      const ctx = [f, ...all.filter((p) => /(?:^|\/)layout\.[cm]?[jt]sx?$/.test(p) && (p.split("/").slice(0, -1).join("/") === "" || dir.join("/").startsWith(p.split("/").slice(0, -1).join("/"))))].map((p) => String(readFile(p) ?? "")).join("\n");
      if (!meta.some((r) => r.test(ctx))) row("page_metadata_missing", `${f} has no title/description metadata (forge.yaml pages.metadata_patterns)`);
      if (!canon.some((r) => r.test(ctx))) row("page_canonical_missing", `${f} declares no canonical URL (pages.canonical_patterns)`);
      if (!sd.some((r) => r.test(ctx))) row("page_structured_data_missing", `${f} emits no structured data / JSON-LD (pages.structured_data_patterns)`);
    }
    if (!files.map(norm).some((f) => anyGlob(cfg.sitemap, f)) && blank(j.sitemap_justification)) row("page_sitemap_missing", `${pages.slice(0, 3).join(", ")} needs a sitemap entry (a change under ${cfg.sitemap.join(", ")}) or page_gate.sitemap_justification in the result (a generated sitemap)`);
  }
  const added = addedByFile(diff), forbid = regexes(cfg.forbid_patterns);
  for (const f of pages) {
    const lines = added[f] ?? [];
    const hit = forbid.find((r) => lines.some((l) => r.test(l)));
    if (hit) row("page_forbidden_pattern", `${f} adds content matching /${hit.source}/ (null sample, raw JSON or dead-end state on a public page; forge.yaml pages.forbid_patterns)`);
  }
  if (tracked) {
    const routes = all.map(pageRouteOf).concat(all.map(routePathOf)).filter(Boolean).map(routeRe);
    const bad = new Set();
    for (const f of pages) for (const l of added[f] ?? []) for (const m of l.matchAll(LINK_RE)) {
      const p = m[1].replace(/\/+$/, "") || "/";
      if (!routes.some((r) => r.test(p)) && !all.includes(`public${p}`) && !all.some((a) => a.endsWith(`/public${p}`))) bad.add(p);
    }
    if (bad.size) row("page_link_broken", `a public page links to ${[...bad].slice(0, 5).join(", ")} which no page, route or public file serves: create it or fix the link`);
  }
  if (cfg.lint && run) {
    let r;
    try { r = await run({ command: `${cfg.lint} ${pages.map(sq).join(" ")}` }); r = r?.r ?? r; } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
    if (r?.rc !== 0) row("page_lint_failed", `forge.yaml pages.lint (\`${cfg.lint}\`) exited ${r?.rc ?? "?"}${r?.output ? `:\n${String(r.output).trim().split("\n").slice(-12).join("\n").slice(0, 1500)}` : ""}`);
  }
  return out;
}
