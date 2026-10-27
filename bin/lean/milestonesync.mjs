// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Milestone branch sync (#4663). No LLM. `syncMilestone` merges a base into `milestone/{slug}` on demand:
 *   - a milestone whose lifecycle is past `building` (shipped:*, deployed:default, closed) is never synced (`isSyncable`);
 *   - a base already merged in is `up-to-date`; the caller names why it syncs (`reason`), never "every base move";
 *   - conflicts go through the lane base-merge resolver (conflictres.mjs `resolveBaseConflicts`, forge.yaml `lean.base_merge_*`);
 *   - an unprotected branch gets a plain push; a protected one (branch protection or a ruleset, or a push rejected by one)
 *     gets ONE long-lived sync PR (`sync/milestone-{slug}`) whose head is force-pushed in place (with lease) while the
 *     FORGE:MILESTONE-SYNC marker in its body (base sha + time) debounces: same base => `unchanged`, inside the window =>
 *     `debounced` (a `ship` sync is never debounced). Auto-merge is armed; a CLEAN PR (auto-merge refused) is merged directly.
 * Never throws; resolves {status, ...}.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForgeYaml } from "../forge-utils.mjs";
import { resolveBaseConflicts } from "./conflictres.mjs";
import { parseLifecycle } from "./lifecycle.mjs";
import { parseMinAge } from "./prefilter.mjs";
import { DEFAULT_FEATURE_PATTERN, milestoneSlug, readBranches } from "./lane.mjs";

export const SYNC_REASONS = ["ship", "batch", "conflict-risk", "manual"];
export const DEFAULT_DEBOUNCE_MS = 10 * 60 * 1000;
export const SYNC_MARKER = "FORGE:MILESTONE-SYNC";
const MARKER_RE = new RegExp(`<!--\\s*${SYNC_MARKER}\\s+(\\{[\\s\\S]*?\\})\\s*-->`);
const REJECTED_RE = /GH006|GH013|protected branch|repository rule|rule violations/i;
const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

/** Only a milestone that is open and still `building` (or has no lifecycle record) may be synced or picked active. */
export function isSyncable(ms) {
  const state = parseLifecycle(ms?.description)?.state;
  return String(ms?.state ?? "open") !== "closed" && (!state || state === "building");
}

/** forge.yaml `milestones.sync_debounce` ("10m", "1h"; default 10m) in ms. */
export function readSyncDebounce(cwd = process.cwd()) {
  try { return parseMinAge(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.milestones?.sync_debounce) ?? DEFAULT_DEBOUNCE_MS; } catch { return DEFAULT_DEBOUNCE_MS; }
}

/** True when branch protection or a repository ruleset applies to `branch`; each source fails independently to false. */
export async function isProtectedBranch({ gh, repo, branch }) {
  const safe = async (f) => { try { return await f(); } catch { return false; } };
  return (await safe(async () => String(await gh(["api", `repos/${repo}/branches/${branch}`, "--jq", ".protected"])).trim() === "true"))
    || (await safe(async () => Number(String(await gh(["api", `repos/${repo}/rules/branches/${branch}`, "--jq", "length"])).trim()) > 0));
}

const syncMarker = (rec) => `<!-- ${SYNC_MARKER} ${JSON.stringify(rec)} -->`;
const readMarker = (body) => { try { return JSON.parse(MARKER_RE.exec(String(body ?? ""))?.[1]); } catch { return null; } };

/**
 * @param {{gh:Function, git:(args:string[], o?:{cwd?:string})=>Promise<string>, repo:string, slug:string, base:string,
 *   branch?:string, cfg?:object, reason:string, now?:number, debounceMs?:number, tmp?:string}} p
 * @returns {Promise<{status:"synced"|"pr-created"|"pr-updated"|"up-to-date"|"unchanged"|"debounced"|"shipped"|"conflict"|"refused"|"error", pr?:number, base?:string, paths?:string[], detail?:string}>}
 */
export async function syncMilestone({ gh, git, repo, slug, base, branch = `milestone/${slug}`, cfg = {}, reason, now = Date.now(), debounceMs = DEFAULT_DEBOUNCE_MS, tmp = tmpdir() }) {
  let wt = null, baseSha;
  try {
    if (!SYNC_REASONS.includes(reason)) return { status: "refused", detail: `sync is on demand: reason must be one of ${SYNC_REASONS.join("|")}` };
    const list = JSON.parse(String(await gh(["api", `repos/${repo}/milestones?state=all&per_page=100`])) || "[]");
    const ms = (Array.isArray(list) ? list : []).find((m) => milestoneSlug(m?.title) === slug);
    if (!ms) return { status: "refused", detail: `no milestone with slug ${slug}` };
    if (!isSyncable(ms)) return { status: "shipped", detail: `milestone is ${parseLifecycle(ms.description)?.state ?? ms.state}: never synced` };
    await git(["fetch", "origin", base, branch]);
    baseSha = String(await git(["rev-parse", `origin/${base}`])).trim();
    try { await git(["merge-base", "--is-ancestor", `origin/${base}`, `origin/${branch}`]); return { status: "up-to-date", base: baseSha }; } catch { /* behind */ }

    const syncBranch = `sync/milestone-${slug}`;
    const protectedBranch = await isProtectedBranch({ gh, repo, branch });
    let pr = null;
    if (protectedBranch) {
      pr = JSON.parse(String(await gh(["pr", "list", "-R", repo, "--head", syncBranch, "--base", branch, "--state", "open", "--json", "number,body"])) || "[]")[0] ?? null;
      const rec = readMarker(pr?.body);
      if (rec?.base === baseSha) return { status: "unchanged", pr: pr.number, base: baseSha };
      if (rec && reason !== "ship" && now - Number(rec.at) < debounceMs) return { status: "debounced", pr: pr.number, base: baseSha };
    }

    wt = mkdtempSync(join(tmp, "milestonesync-"));
    await git(["worktree", "add", "--detach", wt, `origin/${branch}`]);
    const g = (a) => git(a, { cwd: wt });
    const ident = String(await g(["config", "user.email"]).catch(() => "")).trim() ? [] : ["-c", "user.name=ForgeDock", "-c", "user.email=forgedock@users.noreply.github.com"];
    try { await g([...ident, "merge", "--no-edit", `origin/${base}`]); } catch {
      const files = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=U"]).catch(() => ""));
      const r = files.length ? await resolveBaseConflicts({ git: g, cwd: wt, files, cfg }) : { remaining: ["(unknown files)"] };
      if (r.remaining.length) { await g(["merge", "--abort"]).catch(() => {}); return { status: "conflict", base: baseSha, paths: r.remaining }; }
      await g([...ident, "commit", "--no-edit"]);
    }
    const head = String(await g(["rev-parse", "HEAD"])).trim();

    if (!protectedBranch) {
      try { await git(["push", "origin", `${head}:refs/heads/${branch}`]); return { status: "synced", base: baseSha }; } catch (e) {
        if (!REJECTED_RE.test(String(e?.stderr ?? e?.message ?? e))) throw e; // a rule the probe could not see: take the PR path
      }
    }
    const old = lines(await git(["ls-remote", "origin", `refs/heads/${syncBranch}`]).catch(() => ""))[0]?.split(/\s+/)[0] ?? "";
    await git(["push", `--force-with-lease=refs/heads/${syncBranch}:${old}`, "origin", `${head}:refs/heads/${syncBranch}`]);
    const body = `Sync of \`${branch}\` with \`${base}\` (${reason}). One PR per milestone: its head is updated in place when the base moves.\n\n${syncMarker({ v: 1, base: baseSha, at: now })}`;
    let status = "pr-updated";
    if (pr) await gh(["pr", "edit", String(pr.number), "-R", repo, "--body", body]);
    else {
      const url = String(await gh(["pr", "create", "-R", repo, "--base", branch, "--head", syncBranch, "--title", `chore(milestone): sync ${branch} with ${base}`, "--body", body])).trim();
      pr = { number: Number(/(\d+)\s*$/.exec(url)?.[1]) || 0 }; status = "pr-created";
    }
    try { await gh(["pr", "merge", String(pr.number), "-R", repo, "--auto", "--merge"]); } catch {
      await gh(["pr", "merge", String(pr.number), "-R", repo, "--merge"]).catch(() => {}); // CLEAN: auto-merge is refused, merge now; a blocked one stays open for its checks
    }
    return { status, pr: pr.number, base: baseSha };
  } catch (e) {
    return { status: "error", ...(baseSha ? { base: baseSha } : {}), detail: String(e?.message ?? e).split("\n")[0].slice(0, 200) };
  } finally {
    if (wt) { await git(["worktree", "remove", "--force", wt]).catch(() => {}); try { rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/** `forgedock milestone-sync <slug> --reason ship|batch|conflict-risk|manual [--base BRANCH] [--repo owner/repo]`; resolves the exit code. */
export async function runMilestoneSyncCli(argv, deps = {}) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const slug = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  const cwd = deps.cwd ?? process.cwd();
  const repo = val("--repo") ?? deps.repo;
  const br = readBranches(cwd);
  const base = val("--base") ?? br.staging ?? br.default;
  if (!slug || !repo || !base) throw new Error("usage: forgedock milestone-sync <slug> --reason ship|batch|conflict-risk|manual --repo owner/repo [--base BRANCH]");
  const io = deps.io ?? (await import("./effects.mjs")).makeLeanIo({ repo });
  const { readBaseMerge } = await import("../engine-cli.mjs");
  const res = await syncMilestone({ gh: io.gh, git: (a, o = {}) => io.git(a, { cwd: o.cwd ?? cwd }), repo, slug, base,
    branch: String(br.featurePattern || DEFAULT_FEATURE_PATTERN).replace("{slug}", slug), cfg: deps.cfg ?? readBaseMerge(cwd) ?? {}, reason: val("--reason") ?? "", debounceMs: readSyncDebounce(cwd), ...(deps.now ? { now: deps.now } : {}) });
  (deps.print ?? ((t) => console.log(t)))(`milestone-sync: milestone/${slug} <- ${base}: ${res.status}${res.pr ? ` (#${res.pr})` : ""}${res.paths ? ` conflicts: ${res.paths.join(", ")}` : ""}${res.detail ? ` (${res.detail})` : ""}`);
  return ["conflict", "error", "refused"].includes(res.status) ? 1 : 0;
}
