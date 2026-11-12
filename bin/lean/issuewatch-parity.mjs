// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure helpers of `forgedock issue-watch` for parity with the retired bash intake watcher (#5313): issues only (never a PR),
 * the default skip labels, issues with an open closing PR, release awareness (pause while a `forgedock release` job runs)
 * and the heartbeat liveness read by `issue-watch status` and doctor. No LLM calls; gh and the clock are injected.
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeAtomic } from "./batch.mjs";
import { delimiter, join } from "node:path";
import { RELEASE_STEPS } from "./release.mjs";

export const DEFAULT_SKIP_LABELS = ["epic", "needs-human", "post-deploy", "workflow:merged", "awaiting-promotion", "host-task"];
/** A release job that has not written its end `status` for this long is taken as dead, not in flight. */
export const RELEASE_STALE_MS = 6 * 3600 * 1000;
/** A heartbeat older than this many passes is reported dead. */
export const HEARTBEAT_PASSES = 3;

/** True when a listed item is a pull request (GitHub shares the number space; the bash watcher claimed PRs). */
export const isPullRequest = (item) => !!(item?.pullRequest || item?.isPullRequest || item?.__typename === "PullRequest" || /\/pull\/\d+/.test(String(item?.url ?? "")));

/** True when a `search` query asks for pull requests (`is:pr`, `type:pr`). */
export const searchesPullRequests = (search) => /(^|\s)-?(is|type):pr\b/i.test(String(search ?? "")) && !/(^|\s)-(is|type):pr\b/i.test(String(search ?? ""));

/** The first of `skip` the issue carries (label names or `{name}`), else null. */
export const skipLabelHit = (issue, skip = []) => (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).find((n) => n && skip.includes(n)) ?? null;

/** `Map<issue number, PR number>` of issues an open PR closes (`closingIssuesReferences`). A failed gh call throws: nothing is claimed blind. */
export async function closingPrIssues(gh, repo) {
  const out = new Map();
  for (const pr of JSON.parse(String(await gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,closingIssuesReferences"]))) ?? [])
    for (const r of pr.closingIssuesReferences ?? []) if (!out.has(r.number)) out.set(r.number, pr.number);
  return out;
}

/**
 * The release job in flight for `repo` from `<root>/<id>/state.json`: the job writes `status` only when it ends (release.mjs
 * runRelease), so a state without one and a recent mtime is running. @returns {{id, step: string|null, ageMs}|null}
 */
export function releaseInFlight({ root, repo = null, now = Date.now(), staleMs = RELEASE_STALE_MS, readdir = readdirSync, stat = statSync, read = (f) => readFileSync(f, "utf8"), exists = existsSync } = {}) {
  let ids = [];
  try { ids = readdir(root); } catch { return null; }
  let best = null;
  for (const id of ids) {
    const f = join(root, id, "state.json");
    if (!exists(f)) continue;
    let st; try { st = JSON.parse(read(f)); } catch { continue; }
    if (!st || st.status || (repo && st.repo && st.repo !== repo)) continue;
    let age; try { age = now - stat(f).mtimeMs; } catch { continue; }
    if (age > staleMs) continue;
    if (!best || age < best.ageMs) best = { id, step: RELEASE_STEPS.find((x) => !st.steps?.[x]?.done) ?? null, ageMs: age };
  }
  return best;
}

/** `{state: "running"|"paused"|"dead"|"exited"|"done"|"unknown", reason, ageMs}` from a watch's status.json: never a process grep. */
export function watchLiveness(status, now = Date.now()) {
  if (!status) return { state: "unknown", reason: "no status yet", ageMs: null };
  const beat = Date.parse(status.heartbeat ?? "");
  if (status.phase === "done") return { state: "done", reason: "watch finished", ageMs: Number.isFinite(beat) ? now - beat : null };
  if (status.phase === "exited") return { state: "exited", reason: status.exitReason ?? "exited", ageMs: Number.isFinite(beat) ? now - beat : null };
  if (!Number.isFinite(beat)) return { state: "unknown", reason: "no heartbeat recorded", ageMs: null };
  const ageMs = Math.max(0, now - beat), limit = HEARTBEAT_PASSES * (status.heartbeatEveryMs || 300000) + 60000;
  if (ageMs > limit) return { state: "dead", reason: `last heartbeat ${Math.round(ageMs / 60000)}m ago, over ${Math.round(limit / 60000)}m: the watch is not running`, ageMs };
  return status.paused ? { state: "paused", reason: status.paused.reason, ageMs } : { state: "running", reason: "heartbeat fresh", ageMs };
}

/** #5465: `[{repo, name, dir, status, live}]` for every watch under `root` (`<root>/<owner>__<repo>/<name>/status.json`). */
export function listWatches(root, now = Date.now()) {
  const out = [];
  try {
    for (const r of readdirSync(root)) for (const n of readdirSync(join(root, r), { withFileTypes: true })) {
      if (!n.isDirectory()) continue;
      const dir = join(root, r, n.name);
      let status = null; try { status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); } catch { continue; }
      out.push({ repo: status.repo ?? r.replace("__", "/"), name: status.name ?? n.name, dir, status, live: watchLiveness(status, now) });
    }
  } catch { /* no watch root yet */ }
  return out;
}

/**
 * #5465: alert once per dead heartbeat. `emit(type, data, {repo})` posts the `watch.dead` event; the heartbeat that was alerted
 * is saved as `deadAlerted` in status.json so a later pass stays quiet until the watch lives and dies again. Returns the dead watches.
 */
export async function alertDeadWatches({ root, now = Date.now(), emit }) {
  const dead = listWatches(root, now).filter((w) => w.live.state === "dead");
  for (const w of dead) {
    if (w.status.deadAlerted === w.status.heartbeat) continue;
    try { await emit("watch.dead", { watch: w.name, repo: w.repo, reason: w.live.reason, age_s: Math.round(w.live.ageMs / 1000) }, { repo: w.repo }); } catch { continue; }
    try { writeAtomic(join(w.dir, "status.json"), JSON.stringify({ ...w.status, deadAlerted: w.status.heartbeat }) + "\n"); } catch { /* the next pass alerts again */ }
  }
  return dead;
}

/** #5529: the first executable `name` on `PATH` (a PATH string), or null. `isExec` defaults to a real X_OK check. */
export function resolveOnPath(name, PATH, { isExec = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } } } = {}) {
  for (const d of String(PATH ?? "").split(delimiter)) if (d && isExec(join(d, name))) return join(d, name);
  return null;
}

/** #5529: one warning per watch whose running watcher recorded that it cannot resolve `claude` (status.json `claude: null`). */
export const watchEnvWarnings = (rows) => rows.filter((w) => w.status && "claude" in w.status && w.status.claude === null && !["done", "exited"].includes(w.live?.state))
  .map((w) => `watch ${w.name} (${w.repo}): cannot resolve claude on the watcher PATH; its lanes fail 'Failed to find executable claude' (reinstall: forgedock issue-watch install --name ${w.name})`);
