// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5419: user docs for user-facing surfaces. forge.yaml `docs: {required_for, paths, registries, surfaces, link_prefixes, link_check}`.
 * Absent or empty `required_for` = off (library/CLI repos). A diff that touches a configured surface needs a docs change (a file under
 * `paths`/`registries`) or a typed `docs: [{surface, justification}]` in the lane's result; every internal `/docs/...` link the diff adds
 * must resolve (the repo's `link_check` command, else a docs file under `paths`). A milestone with user-facing children cannot close
 * without a merged `docs` child. Deterministic, 0 LLM calls; core stays repo-agnostic (#1347), like routecheck.mjs and prodparity.mjs.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";
import { routePathOf } from "./routecheck.mjs";

export const DOCS_KINDS = Object.freeze(["api", "mcp", "dashboard", "cli", "sdk"]);
const DEFAULT_PATHS = ["docs/**", "**/docs/**"];
const PAGE_RE = /(?:^|\/)app\/(?:.*\/)?page\.[cm]?[jt]sx?$/;
const TEST_RE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const norm = (p) => String(p ?? "").trim().replace(/^\.\//, "");
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\[|\]$/g, "").split(",") : []).map((x) => String(x ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim()).filter(Boolean);

/** forge.yaml docs: section -> {required_for, paths, registries, surfaces, link_prefixes, link_check} or null when off. */
export function parseDocsConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const requiredFor = [...new Set(list(raw.required_for).map((k) => k.toLowerCase()).filter((k) => DOCS_KINDS.includes(k)))];
  if (!requiredFor.length) return null;
  const surfaces = {};
  if (raw.surfaces && typeof raw.surfaces === "object" && !Array.isArray(raw.surfaces)) for (const [k, v] of Object.entries(raw.surfaces)) { const g = list(v); if (g.length && DOCS_KINDS.includes(k.toLowerCase())) surfaces[k.toLowerCase()] = g.map(norm); }
  const prefixes = list(raw.link_prefixes);
  const check = typeof raw.link_check === "string" ? raw.link_check.trim() : "";
  return { required_for: requiredFor, paths: list(raw.paths).map(norm), registries: list(raw.registries).map(norm), surfaces, link_prefixes: prefixes.length ? prefixes : ["/docs"], link_check: check || null };
}

const anyGlob = (globs, f) => globs.some((g) => globToRegex(g).test(f));

/** Touched surfaces `{kind: [files]}` for the configured kinds: built-in Next route handlers (api) and dashboard pages, plus `surfaces` globs. */
export function userFacingSurfaces(files, cfg) {
  const out = {};
  if (!cfg) return out;
  for (const f0 of files ?? []) {
    const f = norm(f0);
    if (!f || TEST_RE.test(f)) continue;
    const kinds = new Set();
    if (routePathOf(f)) kinds.add("api");
    if (PAGE_RE.test(f) && /dashboard/i.test(f)) kinds.add("dashboard");
    for (const [k, globs] of Object.entries(cfg.surfaces)) if (anyGlob(globs, f)) kinds.add(k);
    for (const k of kinds) if (cfg.required_for.includes(k)) (out[k] ??= []).push(f);
  }
  return out;
}

/** Sorted unique internal docs links (`href="/docs/x"`, `docsHref="/docs/x"`, `docsHref={"/docs/x"}`) on the added lines of a unified diff. */
export function docsLinks(diff, prefixes = ["/docs"]) {
  const found = new Set(), re = /(?:href|docsHref)\s*=\s*\{?\s*["'`](\/[^"'`#?\s{}$]*)/g;
  for (const line of String(diff ?? "").split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const m of line.matchAll(re)) if (prefixes.some((p) => m[1] === p || m[1].startsWith(`${p}/`))) found.add(m[1].replace(/\/+$/, "") || "/");
  }
  return [...found].sort();
}

/** True when some docs file under `paths` serves `link` (`rel.md|mdx`, `rel/index.*`, `rel/page.*`). */
export function linkResolves(link, cfg, files) {
  const prefix = cfg.link_prefixes.find((p) => link === p || link.startsWith(`${p}/`)) ?? "";
  const rel = link.slice(prefix.length).replace(/^\/+/, "");
  const globs = cfg.paths.length ? cfg.paths : DEFAULT_PATHS;
  const esc = rel.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|/)${esc ? `${esc}(?:/(?:index|page|readme))?` : "(?:index|page|readme)"}\\.(?:mdx?|[jt]sx?)$`, "i");
  return (files ?? []).some((f) => re.test(f) && anyGlob(globs, f));
}

const names = (c) => (c.labels ?? []).map((l) => String(l?.name ?? l).toLowerCase());
/** Milestone children `{number, state, labels}` -> {ok, reasons}. User-facing = labelled `user-facing` or a configured kind; the docs child is labelled `docs`. */
export function milestoneDocsGate({ children = [], cfg }) {
  if (!cfg) return { ok: true, gated: false, reasons: [] };
  const kinds = new Set(["user-facing", ...cfg.required_for]);
  const docs = children.filter((c) => names(c).includes("docs"));
  const facing = children.filter((c) => !docs.includes(c) && names(c).some((n) => kinds.has(n)));
  if (!facing.length) return { ok: true, gated: false, reasons: [] };
  if (!docs.length) return { ok: false, gated: true, reasons: [`user-facing children (${facing.map((c) => `#${c.number}`).join(", ")}) have no docs child: create an issue labelled \`docs\` in the milestone`] };
  const open = docs.filter((c) => String(c.state).toLowerCase() !== "closed");
  return open.length ? { ok: false, gated: true, reasons: [`docs child ${open.map((c) => `#${c.number}`).join(", ")} is not merged yet`] } : { ok: true, gated: true, reasons: [] };
}

/** `forgedock docs gate --milestone T --repo o/r`: exits 1 when the milestone's docs gate blocks; 0 when off or satisfied. */
export async function docsFromCli(argv, deps = {}) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const print = deps.print ?? ((t) => console.log(t));
  const usage = "usage: forgedock docs gate --milestone T [--repo o/r]";
  if (argv[0] !== "gate" || !val("--milestone")) throw new Error(usage);
  const cfg = parseDocsConfig(deps.config ?? (await import("../engine-cli.mjs")).readEnvConfig(deps.cwd ?? process.cwd()).docsConfig);
  if (!cfg) { print("docs: forge.yaml docs.required_for is not set; not gated"); return 0; }
  const repo = val("--repo") ?? deps.repo;
  if (!repo) throw new Error("docs gate needs the repo: pass --repo owner/repo");
  const io = deps.io ?? (await import("./effects.mjs")).makeLeanIo({ repo });
  const { findMilestone } = await import("./acceptance.mjs");
  const ms = await findMilestone({ io, repo, title: val("--milestone") });
  if (!ms) throw new Error(`no milestone titled ${val("--milestone")}`);
  const children = JSON.parse(String(await io.gh(["api", `repos/${repo}/issues?milestone=${ms.number}&state=all&per_page=100`, "--jq", "[.[] | select(.pull_request == null) | {number, state, labels: [.labels[].name]}]"])) || "[]");
  const g = milestoneDocsGate({ children, cfg });
  if (!g.gated) print("docs: milestone has no user-facing children; not gated");
  else if (g.ok) print(`docs: pass (${ms.title})`);
  else for (const r of g.reasons) print(`docs: BLOCKED: ${r}`);
  return g.ok ? 0 : 1;
}
