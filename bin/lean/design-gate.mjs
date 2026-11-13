// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Design gate (#5330). Opt-in per repo through forge.yaml `design:`; a repo without `design.routes` is never gated.
 *  - routing (lane time): a predicted page entry (page.tsx|jsx, .vue, .svelte) under `design.routes` is routed to /design, or the
 *    lane is blocked pending a FORGE:DESIGN_SPEC (or the `spec_label` label) with `design.gate: blocking`, never built from a
 *    functional spec alone (designGate, designGateNote, specApproved);
 *  - visual gate (one gate, two call sites): visualGate() judges every new or changed user-visible route. The lane precheck calls it
 *    through designFailures() (spec + deterministic source critique); review-pr-staging calls it through scripts/visual-gate.mjs
 *    (#5369) with the rendered screenshots and the design-render-critique-loop verdict as evidence;
 *  - critiqueMarkup(): the deterministic floor of the render critique (empty boxes, placeholder text, a text-only hero), 0 LLM calls.
 * Keys: system, routes, exclude, gate (blocking|advisory), spec_label, needed_label, directions_param, viewports,
 * require_visual_check. Pure: no I/O, no model calls.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";
import { designSpecApproved, pageRouteOf, pageChange } from "./pagegate.mjs";

export const DEFAULT_VIEWPORTS = Object.freeze([390, 1440]);
const PAGE_ENTRY_RE = /(?:^|\/)page\.[cm]?[jt]sx?$|\.(?:vue|svelte)$/i;
const LAYOUT_RE = /(?:^|\/)layout\.[cm]?[jt]sx?$/i;
const TEST_RE = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/i;
const norm = (p) => String(p ?? "").trim().replace(/^\.\//, "");
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\s*\[|\]\s*$/g, "").split(",") : v == null ? [] : [v]).map((x) => String(x).trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
const truthy = (v, d) => (v === undefined || v === null || v === "" ? d : v === true || /^(?:true|yes|on|1)$/i.test(String(v).trim()));
const str = (v, d) => (typeof v === "string" && v.trim() ? v.trim() : d);

/** forge.yaml design block -> config, or null when there is no block. `routes: []` means the gate is off (system still read). */
export function parseDesignConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const vp = list(raw.viewports).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return {
    system: list(raw.system), routes: list(raw.routes).map(norm), exclude: list(raw.exclude).map(norm),
    gate: String(raw.gate ?? "").trim().toLowerCase() === "blocking" ? "blocking" : "advisory",
    specLabel: str(raw.spec_label, "design:approved"), neededLabel: str(raw.needed_label, "design:needed"), directionsParam: str(raw.directions_param, null),
    viewports: vp.length ? [...new Set(vp)] : [...DEFAULT_VIEWPORTS], requireVisual: truthy(raw.require_visual_check, true),
  };
}
/** The gate is on only when design.routes names at least one glob. */
export const designOn = (cfg) => Boolean(cfg && Array.isArray(cfg.routes) && cfg.routes.length);

const anyGlob = (globs, f) => globs.some((g) => globToRegex(g).test(f));
/** Non-test files under design.routes and outside design.exclude: every user-visible route file (pages and layouts). */
export function designFiles(files = [], cfg = null) {
  if (!designOn(cfg)) return [];
  return [...new Set((Array.isArray(files) ? files : []).map(norm).filter((f) => f && !TEST_RE.test(f) && anyGlob(cfg.routes, f) && !anyGlob(cfg.exclude ?? [], f)))];
}
/** Page entry points among designFiles (what routing keys on). */
export const designPages = (files, cfg) => designFiles(files, cfg).filter((f) => PAGE_ENTRY_RE.test(f));
/** URL path a route file serves (Next app router), else its directory. */
export function routeOf(file) {
  const f = norm(file);
  return pageRouteOf(f) ?? pageRouteOf(f.replace(LAYOUT_RE, (m) => m.replace(/layout/, "page"))) ?? `/${f.replace(/\.[^.]+$/, "")}`;
}

/** True when an issue comment carries a non-draft FORGE:DESIGN_SPEC, or the issue has the design.spec_label label. */
export function specApproved({ comments = [], labels = [], cfg = null } = {}) {
  const label = cfg?.specLabel ?? "design:approved";
  return designSpecApproved(comments) || (labels ?? []).some((l) => (typeof l === "string" ? l : l?.name) === label);
}

/** Lane-time routing: { route, blocked, pages, reason }. route when a predicted page matches design.routes and has no spec; blocked only with gate: blocking. */
export function designGate({ files = [], cfg = null, comments = [], labels = [], baseFiles = null } = {}) {
  // #5648: a page already on the base is modified (the precheck judges rewrite vs copy from the diff), generated pages are exempt
  const onBase = new Set(Array.isArray(baseFiles) ? baseFiles.map(norm) : []);
  const pages = designPages(files, cfg).filter((f) => !onBase.has(f) && pageChange(f, { added: [f] }) !== "generated");
  if (!pages.length || specApproved({ comments, labels, cfg })) return { route: false, blocked: false, pages, reason: "" };
  return { route: true, blocked: cfg.gate === "blocking", pages, reason: `page ${pages.slice(0, 3).join(", ")} is under design.routes and the issue has no FORGE:DESIGN_SPEC (label ${cfg.specLabel}); route it to /design before building` };
}
/** Builder prompt note for a routed lane; "" otherwise. */
export const designGateNote = (g) => (g?.route ? `\n\nDesign gate: ${g.reason}. Do not build a user-visible page straight from a functional spec; ${g.blocked ? "stop with a block asking for /design (design.gate: blocking)" : "reference a /design spec in the contract and in implementation.md's Visual Check"}.` : "");

// ---- deterministic render-critique floor ----
const BOX = /\b(?:rounded|shadow|card|panel|tile)\b|\bborder\b(?!-[tblrxy]\b)|\brounded-/i;
const BOX_TAGS = "div|section|article|aside|li|Card|CardContent|Box|Panel|Tile";
const PLACEHOLDER = /lorem ipsum|\bTBD\b|\bTODO\b|coming soon|placeholder (?:text|content|image)|\[\[null\]\]|\bundefined\b\s*<|>\s*null\s*</i;
const GENERIC_CTA = /^(?:get access|learn more|click here|read more|sign up|submit|more|go)$/i;
const VISUAL = /<(?:img|svg|video|picture|canvas|iframe|Image|Lottie)\b|bg-(?:gradient|\[url)|background(?:Image)?\s*[:=]|<(?!Link\b|Fragment\b|Suspense\b|Head\b|Script\b)[A-Z][A-Za-z0-9.]*/;

/** Findings [{id, severity: "block"|"warn", detail}] for one page's markup/JSX source. Heuristic floor; the rendered critique is the vision judge. */
export function critiqueMarkup(src) {
  // Comments are stripped for analysis only (never emitted); repeat until stable so nested/overlapping markers leave nothing behind.
  let code = String(src ?? ""), prev;
  do { prev = code; code = code.replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, ""); } while (code !== prev);
  const out = [];
  let empties = 0;
  for (const m of code.matchAll(new RegExp(`<(${BOX_TAGS})\\b([^>]*?)(?:/>|>\\s*</\\1\\s*>)`, "g"))) {
    if (BOX.test(m[2]) && !/aria-hidden|animate-|skeleton|role=["']presentation/i.test(m[2])) empties++;
  }
  for (const m of code.matchAll(new RegExp(`<(${BOX_TAGS})\\b([^>]*)>\\s*<(?:h[2-6]|CardTitle|strong|dt)\\b[^>]*>[^<{]{1,60}</(?:h[2-6]|CardTitle|strong|dt)>\\s*</\\1\\s*>`, "g"))) {
    if (/\bp[xy]?-\d|card|panel/i.test(m[2])) empties++;
  }
  if (empties) out.push({ id: "empty_box", severity: "block", detail: `${empties} box(es) with no content or only a label (empty cards/panels)` });
  if (PLACEHOLDER.test(code)) out.push({ id: "placeholder_text", severity: "block", detail: "placeholder copy or a null/undefined sample is rendered" });
  if (/<h1\b/.test(code) && !VISUAL.test(code)) out.push({ id: "plain_text_hero", severity: "block", detail: "the page is text only: an h1 and prose with no component, media, icon or background" });
  const anchors = [...code.matchAll(/<a\b[^>]*>([^<{]{1,40})<\/a>/gi)].map((m) => m[1].trim());
  if (anchors.length && anchors.every((t) => GENERIC_CTA.test(t)) && !/<(?:button|Button)\b/.test(code)) out.push({ id: "bare_cta", severity: "warn", detail: `the only calls to action are bare links (${[...new Set(anchors)].join(", ")})` });
  return out;
}

const hasShot = (shots, vp) => (shots ?? []).some((s) => new RegExp(`(?:^|[^0-9])${vp}(?:[^0-9]|$)`).test(String(s)));

/**
 * The visual gate over the user-visible route files in `files`.
 * `specs`: boolean | { [route]: boolean }; `sources`: { [file]: source text } for the deterministic critique;
 * `evidence`: { [route]: { screenshots: [paths], verdict: "PASS"|"ITERATE"|"BUDGET-EXHAUSTED" } } from the render critique, consulted only with `rendered: true`.
 * -> { gate, verdict: "SKIP"|"PASS"|"ADVISORY"|"FAIL", routes, rows: [{kind, route, detail}] }. Rows are failures when gate is blocking, warnings otherwise.
 */
export function visualGate({ cfg = null, files = [], specs = false, sources = {}, evidence = {}, rendered = false, changes = {} } = {}) {
  if (!designOn(cfg)) return { gate: null, verdict: "SKIP", routes: [], rows: [], reason: "design.routes is unset" };
  // #5648: `changes` {file: pageChange class}: generated files are exempt, a copy-only edit needs the visual check but no spec
  const routeFiles = designFiles(files, cfg).filter((f) => changes[f] !== "generated");
  const routes = routeFiles.map((file) => ({ file, route: routeOf(file), page: PAGE_ENTRY_RE.test(file) }));
  const rows = [], add = (kind, route, detail) => rows.push({ kind, route, detail });
  for (const r of routes) {
    const spec = typeof specs === "object" && specs !== null ? Boolean(specs[r.route] ?? specs[r.file]) : Boolean(specs);
    const copy = changes[r.file] === "copy";
    if (r.page && !spec && !copy) add("design_spec_missing", r.route, `${r.file} has no approved FORGE:DESIGN_SPEC (label ${cfg.specLabel}): run /design first`);
    if (r.page && !copy && sources[r.file] != null) {
      for (const f of critiqueMarkup(sources[r.file])) if (f.severity === "block") add("visual_critique_failed", r.route, `${r.file}: ${f.id}: ${f.detail}`);
    }
    if (rendered && cfg.requireVisual) {
      const ev = evidence[r.route] ?? evidence[r.file];
      const missing = cfg.viewports.filter((vp) => !hasShot(ev?.screenshots, vp));
      if (missing.length) add("visual_screenshots_missing", r.route, `${r.route}: no screenshot at ${missing.join(", ")}px`);
      const v = String(ev?.verdict ?? "").trim().toUpperCase();
      if (!v) add("visual_critique_missing", r.route, `${r.route}: no design-render-critique-loop verdict`);
      else if (v !== "PASS") add("visual_critique_failed", r.route, `${r.route}: render critique verdict ${v}`);
    }
  }
  const verdict = !rows.length ? "PASS" : cfg.gate === "blocking" ? "FAIL" : "ADVISORY";
  return { gate: cfg.gate, verdict, routes, rows, viewports: cfg.viewports };
}

/** Lane precheck rows (conformance.unimplemented) for the diff's user-visible routes; [] unless design.routes is set and gate is blocking. */
export function designFailures({ cfg = null, files = [], specs = false, readFile = () => "", added = null, diff = "" } = {}) {
  if (!designOn(cfg) || cfg.gate !== "blocking") return [];
  const sources = {}, changes = {};
  for (const f of designFiles(files, cfg)) changes[f] = pageChange(f, { added, diff, readFile }); // no added list: "new", fail closed
  for (const f of designPages(files, cfg)) sources[f] = String(readFile(f) ?? "");
  return visualGate({ cfg, files, specs, sources, changes }).rows.map((r) => ({ code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, kind: r.kind, detail: r.detail }));
}

/** Markdown for the FORGE:VISUAL_GATE comment (review-pr-staging). Rendered screenshots are listed by path. */
export function visualGateComment(g, evidence = {}) {
  const rows = (g.routes ?? []).map((r) => `| \`${r.route}\` | \`${r.file}\` | ${(evidence[r.route]?.screenshots ?? []).map((s) => `\`${s}\``).join(", ") || "none"} | ${String(evidence[r.route]?.verdict ?? "n/a")} |`);
  const probs = (g.rows ?? []).map((r) => `- ${r.kind}: ${r.detail}`);
  return `<!-- FORGE:VISUAL_GATE -->\n## Visual gate: ${g.verdict} (design.gate: ${g.gate ?? "off"})\n\n| Route | File | Screenshots | Critique |\n| --- | --- | --- | --- |\n${rows.join("\n") || "| none | | | |"}\n${probs.length ? `\n${g.gate === "blocking" ? "Blocking" : "Advisory"} findings:\n${probs.join("\n")}\n` : ""}`;
}
