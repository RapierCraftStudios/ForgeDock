#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * review-context.mjs — detect and refresh a stale forge.yaml `review.context` / `review.tech_stack` (#4666).
 *
 * The checks are deterministic (no LLM): manifests, the decision log and the context text are compared directly.
 * Only `proposeRefresh` may use the enrichment backend, and only when the caller passes one in.
 *
 *   node bin/review-context.mjs check --config <forge.yaml> [--root <dir>] [--repo owner/name] --json
 *
 * Exit 0 always for `check` (a failing check must never block a review); the JSON carries the result.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

export const DEFAULT_MAX_MERGED_PRS = 50;
export const DECISION_LOG_CANDIDATES = ["docs/decisions.md", "DECISIONS.md", "docs/decision-log.md", "devdocs/project/decisions.md"];

// label as written in tech_stack -> package name as written in a manifest
const FRAMEWORKS = [
  ["Next.js", "next"], ["React", "react"], ["Vue", "vue"], ["Nuxt", "nuxt"], ["Svelte", "svelte"], ["SvelteKit", "@sveltejs/kit"],
  ["Angular", "@angular/core"], ["Remix", "@remix-run/react"], ["Astro", "astro"], ["Express", "express"], ["Fastify", "fastify"],
  ["NestJS", "@nestjs/core"], ["Tailwind", "tailwindcss"], ["Prisma", "prisma"], ["Drizzle", "drizzle-orm"],
  ["FastAPI", "fastapi"], ["Django", "django"], ["Flask", "flask"], ["SQLAlchemy", "sqlalchemy"],
  ["Rails", "rails"], ["Laravel", "laravel/framework"], ["Gin", "gin-gonic/gin"], ["Axum", "axum"], ["Actix", "actix-web"],
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "vendor", "target", "__pycache__", ".claude", ".forge-lean"]);
const MANIFEST_RE = /^(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const wordRe = (w, flags = "i") => new RegExp(`(^|[^A-Za-z0-9_.-])${esc(w)}($|[^A-Za-z0-9_.-])`, flags);

// ── forge.yaml review block (no YAML parser in this repo: a tolerant line scanner) ──────────────────────────────

function reviewRange(lines) {
  const start = lines.findIndex((l) => /^review:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\S/.test(lines[i]) && !lines[i].startsWith("#")) { end = i; break; }
  return { start, end };
}

function scalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v.replace(/\s+#.*$/, "")); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'")).replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "");
}

/** Reads the scalar keys of the top-level `review:` block (block scalars `|`/`>` included). Missing -> "". */
export function readReviewFields(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const r = reviewRange(lines);
  const out = {};
  if (!r) return out;
  for (let i = r.start + 1; i < r.end; i++) {
    const m = /^  ([A-Za-z_]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (/^[|>][+-]?\s*(#.*)?$/.test(rest)) {
      const body = [];
      let j = i + 1;
      while (j < r.end && (/^\s*$/.test(lines[j]) || /^ {3,}/.test(lines[j]))) body.push(lines[j++].replace(/^ {4}/, "").replace(/^ +$/, ""));
      out[key] = body.join("\n").replace(/\n+$/, "");
      i = j - 1;
    } else if (rest.trim() !== "") out[key] = scalar(rest);
  }
  return out;
}

/** Returns yamlText with the given review keys replaced (or added). Every other line is left untouched. */
export function writeReviewFields(yamlText, fields) {
  const lines = yamlText.split("\n");
  let r = reviewRange(lines);
  if (!r) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push("review:");
    r = { start: lines.length - 1, end: lines.length };
  }
  const keys = Object.keys(fields);
  const kept = [];
  for (let i = r.start + 1; i < r.end; i++) {
    const m = /^  ([A-Za-z_]+):/.exec(lines[i]);
    if (m && keys.includes(m[1])) {
      while (i + 1 < r.end && (/^ {3,}/.test(lines[i + 1]) || (/^\s*$/.test(lines[i + 1]) && /^ {3,}/.test(lines[i + 2] || "")))) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  const added = [];
  for (const k of keys) {
    const v = String(fields[k]);
    if (v.includes("\n")) added.push(`  ${k}: |`, ...v.replace(/\n+$/, "").split("\n").map((l) => (l ? `    ${l}` : "")));
    else added.push(`  ${k}: ${JSON.stringify(v)}`);
  }
  return [...lines.slice(0, r.start + 1), ...added, ...kept, ...lines.slice(r.end)].join("\n");
}

// ── facts: manifests and the decision log ────────────────────────────────────────────────────────────────────────

/** Dependency names and raw manifest text under `root` (depth <= 3, skipping vendored dirs). */
export function collectManifestFacts(root) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (files.length >= 200) return;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3 && !SKIP_DIRS.has(name)) walk(p, depth + 1); }
      else if (MANIFEST_RE.test(name) && st.size < 2_000_000) files.push(p);
    }
  };
  walk(root, 0);
  const parts = [];
  let hasSourceManifest = false;
  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    if (f.endsWith("package.json")) {
      try {
        const j = JSON.parse(text);
        const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(j[k] || {}));
        if (deps.length) hasSourceManifest = true;
        parts.push(deps.join("\n"));
      } catch { /* unparsable manifest: ignore */ }
    } else {
      hasSourceManifest = true;
      parts.push(text);
    }
  }
  return { files, hasSourceManifest, haystack: parts.join("\n").toLowerCase() };
}

export function findDecisionLog(root, configured) {
  for (const rel of [configured, ...DECISION_LOG_CANDIDATES].filter(Boolean)) {
    const p = resolve(root, rel);
    if (existsSync(p)) { try { return readFileSync(p, "utf8"); } catch { /* next */ } }
  }
  return "";
}

const ID_RE = /\b(?:[A-Z]{1,5}-?\d{1,4})\b/g;

/** IDs the decision log marks superseded: "D-12 ... superseded", "Status: superseded" under a "## D-12" heading, "D-15 supersedes D-12". */
export function supersededDecisionIds(logText) {
  const out = new Set();
  let lastId = [];
  for (const line of logText.split(/\r?\n/)) {
    const m = /supersed\w*/i.exec(line);
    if (!m) {
      const ids = line.match(ID_RE);
      if (ids) lastId = ids;
      continue;
    }
    if (/^supersedes$/i.test(m[0])) (line.slice(m.index).match(ID_RE) || []).forEach((i) => out.add(i));
    else {
      const before = line.slice(0, m.index).match(ID_RE) || [];
      (before.length ? before : lastId).forEach((i) => out.add(i));
    }
  }
  return out;
}

// ── detection ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Reasons the context is stale: [{code, detail}]. Empty = fresh (or nothing to compare against). */
export function detectStale({ techStack = "", context = "", manifests, decisionLogText = "" }) {
  const reasons = [];
  if (manifests?.hasSourceManifest) {
    const absent = FRAMEWORKS.filter(([label, pkg]) => wordRe(label).test(techStack) && !wordRe(pkg).test(manifests.haystack)).map(([l]) => l);
    if (absent.length) reasons.push({ code: "tech_stack_absent", detail: `tech_stack names ${absent.join(", ")} but no manifest lists it` });
    if (/docs[- ]only|\bno (?:product |source |application )?code\b/i.test(context)) {
      reasons.push({ code: "docs_only_phrasing", detail: "context says the repo is docs-only / has no code, but source manifests exist" });
    }
  }
  if (decisionLogText && context) {
    const cited = [...supersededDecisionIds(decisionLogText)].filter((id) => wordRe(id, "").test(context));
    if (cited.length) reasons.push({ code: "superseded_decision", detail: `context cites superseded decision(s) ${cited.join(", ")}` });
  }
  return reasons;
}

/** Advisory once more than `maxMergedPrs` PRs merged since the context was generated. Unknown count = not advisory. */
export function contextAge({ generatedAt = "", mergedSince = null, maxMergedPrs = DEFAULT_MAX_MERGED_PRS }) {
  const max = Number.isFinite(maxMergedPrs) && maxMergedPrs > 0 ? maxMergedPrs : DEFAULT_MAX_MERGED_PRS;
  return { generatedAt, mergedSince, maxMergedPrs: max, advisory: Boolean(generatedAt) && mergedSince != null && mergedSince > max };
}

/** Merged PR count since `generatedAt` via gh; null when it cannot be determined. */
export function countMergedSince(repo, generatedAt, run = execFileSync) {
  if (!repo || !/^\d{4}-\d{2}-\d{2}/.test(generatedAt)) return null;
  try {
    const out = run("gh", ["pr", "list", "-R", repo, "--state", "merged", "--search", `merged:>=${generatedAt.slice(0, 10)}`, "--json", "number", "--limit", "200"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
    const n = JSON.parse(out);
    return Array.isArray(n) ? n.length : null;
  } catch { return null; }
}

/** Full check of one forge.yaml. `mergedCount` is injectable for tests. */
export function checkContext({ configPath, root, repo, mergedCount = countMergedSince }) {
  let text = "";
  try { text = readFileSync(configPath, "utf8"); } catch { return { stale: false, reasons: [], generated_at: "", merged_since: null, advisory: false, max_merged_prs: DEFAULT_MAX_MERGED_PRS }; }
  const f = readReviewFields(text);
  const manifests = collectManifestFacts(root);
  const reasons = detectStale({ techStack: f.tech_stack || "", context: f.context || "", manifests, decisionLogText: findDecisionLog(root, f.decision_log) });
  const generatedAt = f.context_generated_at || "";
  const age = contextAge({ generatedAt, mergedSince: generatedAt ? mergedCount(repo, generatedAt) : null, maxMergedPrs: parseInt(f.context_max_merged_prs, 10) });
  return { stale: reasons.length > 0, reasons, generated_at: generatedAt, merged_since: age.mergedSince, advisory: age.advisory, max_merged_prs: age.maxMergedPrs };
}

// ── refresh ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tech stack from the frameworks the manifests actually list. */
export function techStackFromManifests(manifests) {
  return FRAMEWORKS.filter(([, pkg]) => wordRe(pkg).test(manifests.haystack)).map(([l]) => l).join(", ");
}

/** Drops the sentences that made the context stale (docs-only phrasing, superseded decision IDs). */
export function pruneContext(context, { hasSourceManifest, superseded }) {
  const stale = (s) => (hasSourceManifest && /docs[- ]only|\bno (?:product |source |application )?code\b/i.test(s)) || [...superseded].some((id) => wordRe(id, "").test(s));
  return context.split("\n").map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => !stale(s)).join(" ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Proposes new review fields from the current manifests and decision log, deterministically: tech_stack is rebuilt from
 * the manifests, stale sentences are pruned from the context. `enrichFn({tech_stack, context, decisionLog, manifestFiles})`
 * (optional, async) may rewrite them further.
 */
export async function proposeRefresh({ yamlText, root, now = new Date(), enrichFn, mergedTotal }) {
  const cur = readReviewFields(yamlText);
  const manifests = collectManifestFacts(root);
  const log = findDecisionLog(root, cur.decision_log);
  const names = manifests.files.map((p) => p.slice(root.length + 1));
  const stack = techStackFromManifests(manifests) || cur.tech_stack || "";
  const fields = {
    tech_stack: stack,
    context: pruneContext(cur.context || "", { hasSourceManifest: manifests.hasSourceManifest, superseded: supersededDecisionIds(log) }),
  };
  if (!fields.context && names.length) fields.context = `Source manifests: ${names.join(", ")}.`;
  if (enrichFn) {
    const e = await enrichFn({ ...fields, decisionLog: log, manifestFiles: names });
    if (e && typeof e === "object") { if (e.tech_stack) fields.tech_stack = e.tech_stack; if (e.context) fields.context = e.context; }
  }
  fields.context_generated_at = now.toISOString().slice(0, 10);
  if (mergedTotal != null) fields.context_generated_pr_count = String(mergedTotal);
  const next = writeReviewFields(yamlText, fields);
  return { next, diff: simpleDiff(yamlText, next), changed: next !== yamlText };
}

/**
 * `forgedock init --refresh-context`: show the diff, write only on approval. `deps` = {confirm, backup, write, interactive}.
 * Returns the exit code (0 written or nothing to do, 1 declined / non-interactive / no forge.yaml).
 */
export async function refreshContextFlow({ cwd, out, deps, enrichFn, mergedTotal }) {
  const path = join(cwd, "forge.yaml");
  if (!existsSync(path)) { out.write("\n  No forge.yaml here — run: npx forgedock init\n"); return 1; }
  const { next, diff, changed } = await proposeRefresh({ yamlText: readFileSync(path, "utf8"), root: cwd, enrichFn, mergedTotal });
  out.write(`\n  review.context / review.tech_stack refresh (from manifests + decision log):\n\n${diff.split("\n").map((l) => `    ${l}`).join("\n")}\n\n`);
  if (!changed) { out.write("  Nothing to change.\n"); return 0; }
  if (!deps.interactive) { out.write("  Non-interactive run — forge.yaml left untouched. Re-run in a terminal to approve.\n"); return 1; }
  if (!(await deps.confirm("Apply this change to forge.yaml? A backup will be created.", false))) { out.write("  Refresh cancelled — forge.yaml left untouched.\n"); return 1; }
  const backup = deps.backup(path);
  if (backup) out.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);
  deps.write(path, next);
  out.write("  forge.yaml updated.\n");
  return 0;
}

/** Minimal line diff (removed `-`, added `+`) over the lines that differ; enough for an approval prompt. */
export function simpleDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  return [...x.slice(s, x.length - e).map((l) => `- ${l}`), ...y.slice(s, y.length - e).map((l) => `+ ${l}`)].join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(n); return i === -1 ? "" : rest[i + 1] || ""; };
  if (cmd !== "check" || !opt("--config")) {
    process.stderr.write("usage: review-context.mjs check --config <forge.yaml> [--root <dir>] [--repo owner/name] --json\n");
    process.exit(2);
  }
  const configPath = resolve(opt("--config"));
  const res = checkContext({ configPath, root: resolve(opt("--root") || dirname(configPath)), repo: opt("--repo") });
  process.stdout.write(JSON.stringify(res) + "\n");
}
