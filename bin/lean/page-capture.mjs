// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5770: the engine-run visual check for public pages. The builder may not install browsers and GitHub has no PR image upload, so after the
 * build the engine runs forge.yaml `pages.capture` (a command on a host or sandbox that already has a browser) for the changed routes, checks
 * every route x viewport file exists and is not blank, uploads them to an engine-owned orphan `forge-visual` ref and returns raw links.
 * The command gets FORGE_PAGE_ROUTES, FORGE_PAGE_VIEWPORTS and FORGE_CAPTURE_DIR and must write `<dir>/<slug>-<viewport>.png`
 * (slug: "/" -> home, "/a/b" -> a-b). All effects (run, stat, git) are injected.
 */
import { designOnlyFiles, pageFiles, pageRouteOf } from "./pagegate.mjs";

export const VISUAL_REF = "refs/heads/forge-visual";
export const MIN_SHOT_BYTES = 1000; // a smaller PNG is a blank page

export const routeSlug = (route) => String(route).replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]+/g, "-") || "home";

/** The URL paths of the changed public pages and design_only pages (#5793); only Next app-router page files have a route. */
export function changedRoutes(files, cfg, { readFile = null } = {}) {
  return [...new Set([...pageFiles(files, cfg, { readFile }), ...designOnlyFiles(files, cfg)].map(pageRouteOf).filter(Boolean))];
}

/**
 * Commit the capture files in `dir` as an orphan tree on VISUAL_REF with git plumbing on a throwaway index (no checkout touched), push it and
 * return {name: rawUrl}. `run({command})` -> {rc, output} is the injected shell; `slug` is owner/repo.
 */
export async function publishToRef({ run, dir, files, slug, runId }) {
  const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const adds = files.map((f) => `GIT_INDEX_FILE="$IDX" git update-index --add --cacheinfo 100644,$(git hash-object -w ${sh(`${dir}/${f.name}`)}),${sh(`${runId}/${f.name}`)}`).join(" && ");
  const command = `set -e; IDX=$(mktemp -u); trap 'rm -f "$IDX"' EXIT; ${adds}; T=$(GIT_INDEX_FILE="$IDX" git write-tree); C=$(git commit-tree "$T" -m ${sh(`visual check ${runId}`)}); git push --force origin "$C:${VISUAL_REF}" >&2; echo "$C"`;
  const r = await run({ command }).then((x) => x?.r ?? x);
  const sha = String(r?.output ?? "").trim().split("\n").pop();
  if (r?.rc !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git publish exited ${r?.rc}: ${String(r?.output ?? "").trim().split("\n").slice(-2).join(" | ")}`);
  return Object.fromEntries(files.map((f) => [f.name, `https://raw.githubusercontent.com/${slug}/${sha}/${runId}/${f.name}`]));
}

/**
 * Capture the visual check. `run({command, env})` -> {rc, output}; `read(path)` -> Buffer|null; `publish(files)` -> {name: url}.
 * Returns {screenshots: [url], errors: [{route, viewport, error}], rows: [{route, urls: {vp: url}}]}.
 */
export async function captureVisualCheck({ cfg, routes, dir, run, read, publish }) {
  const vps = cfg?.viewports ?? [390, 1440], out = { screenshots: [], errors: [], rows: [] };
  if (!cfg?.capture || !routes.length) return out;
  const fail = (route, viewport, error) => out.errors.push({ route, viewport, error: String(error).slice(0, 300) });
  let r;
  try { r = await run({ command: cfg.capture, env: { FORGE_PAGE_ROUTES: routes.join(","), FORGE_PAGE_VIEWPORTS: vps.join(","), FORGE_CAPTURE_DIR: dir } }); r = r?.r ?? r; } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
  if (r?.rc !== 0) { fail(null, null, `capture command exited ${r?.rc ?? "?"}: ${String(r?.output ?? "").trim().split("\n").slice(-3).join(" | ")}`); return out; }
  const files = [];
  for (const route of routes) for (const vp of vps) {
    const name = `${routeSlug(route)}-${vp}.png`, buf = await read(`${dir}/${name}`);
    if (!buf) fail(route, vp, "render error: the capture command wrote no screenshot");
    else if (buf.length < MIN_SHOT_BYTES) fail(route, vp, `blank page: screenshot is ${buf.length} bytes`);
    else files.push({ route, vp, name, content: buf });
  }
  if (out.errors.length || !files.length) return out;
  let urls;
  try { urls = await publish(files); } catch (e) { fail(null, null, `upload to ${VISUAL_REF} failed: ${e?.message ?? e}`); return out; }
  for (const route of routes) out.rows.push({ route, urls: Object.fromEntries(files.filter((f) => f.route === route).map((f) => [f.vp, urls[f.name]])) });
  out.screenshots = files.map((f) => urls[f.name]).filter(Boolean);
  return out;
}

/** The engine-written PR body section; "" without captures. */
export function visualMarkdown(c, viewports = [390, 1440]) {
  if (!c?.rows?.length) return "";
  const head = `| Route | ${viewports.map((v) => `${v}px`).join(" | ")} |\n| --- | ${viewports.map(() => "---").join(" | ")} |`;
  const rows = c.rows.map((r) => `| \`${r.route}\` | ${viewports.map((v) => (r.urls[v] ? `[${v}px](${r.urls[v]})` : "n/a")).join(" | ")} |`);
  return `## Visual check\nCaptured by the engine (not the builder) at ${viewports.join("px, ")}px.\n\n${head}\n${rows.join("\n")}`;
}
