/**
 * forge#4657: milestone lifecycle `building -> shipped:staging -> deployed:default -> closed`, recorded as one
 * `<!-- FORGE:LIFECYCLE {json} -->` block in the milestone description (same register as FORGE:DRIFT, drift.mjs).
 * Pure helpers plus `advanceMilestone`, which takes an injected `gh`/`git`. No LLM.
 */
import { readMilestone } from "./drift.mjs";

export const LIFECYCLE_MARKER = "FORGE:LIFECYCLE";
export const LIFECYCLE_STATES = ["building", "shipped:staging", "deployed:default", "closed"];
export const CARRY_CLASSES = ["engineering", "external", "post-deploy", "wont-do"];
const BLOCK_RE = new RegExp(`<!--\\s*${LIFECYCLE_MARKER}\\s+(\\{[\\s\\S]*?\\})\\s*-->`);
const POST_DEPLOY_LABELS = ["awaiting-promotion", "awaiting-due", "awaiting-precondition", "awaiting-measurement"];
const GATED_LABELS = ["flag-gated", "legal-gated", "legal-hold"];
const arr = (x) => (Array.isArray(x) ? x : []);
const names = (labels) => arr(labels).map((l) => String(l?.name ?? l));

/** The FORGE:LIFECYCLE record in a milestone description ({v, state, sha?}), or null. */
export function parseLifecycle(description) {
  const m = BLOCK_RE.exec(String(description ?? ""));
  if (!m) return null;
  try { const s = JSON.parse(m[1]); return s && typeof s === "object" && !Array.isArray(s) && LIFECYCLE_STATES.includes(s.state) ? s : null; } catch { return null; }
}

/** `description` with its FORGE:LIFECYCLE block replaced (or appended); the text around it is unchanged. */
export function renderLifecycle(description, record) {
  const d = String(description ?? "");
  const block = `<!-- ${LIFECYCLE_MARKER} ${JSON.stringify({ v: 1, ...record }).replace(/>/g, "\\u003e")} -->`;
  if (BLOCK_RE.test(d)) return d.replace(BLOCK_RE, () => block);
  return d ? `${d}\n\n${block}` : block;
}

/** `state` moves forward only: the later of `from` and `to` (a missing `from` is `building`). */
export function advanceState(from, to) {
  const a = Math.max(0, LIFECYCLE_STATES.indexOf(from)), b = LIFECYCLE_STATES.indexOf(to);
  return LIFECYCLE_STATES[Math.max(a, b)];
}

/** forge.yaml `milestones.close_on`: `staging` or `default` (the default). */
export const parseCloseOn = (v) => (String(v ?? "").trim().toLowerCase() === "staging" ? "staging" : "default");

/** True when `state` has reached the point `closeOn` closes the milestone at (and it is not closed yet). */
export function closeDue(state, closeOn = "default") {
  if (state === "closed") return false;
  return LIFECYCLE_STATES.indexOf(state) >= LIFECYCLE_STATES.indexOf(parseCloseOn(closeOn) === "staging" ? "shipped:staging" : "deployed:default");
}

/** Carry-over class of an open issue from its labels: external, post-deploy, wont-do, else engineering. */
export function classifyCarryOver(issue) {
  const l = names(issue?.labels);
  const explicit = l.map((x) => /^carry:(.+)$/.exec(x)?.[1]).find((x) => CARRY_CLASSES.includes(x));
  if (explicit) return explicit;
  if (l.includes("needs-human:external")) return "external";
  if (l.some((x) => POST_DEPLOY_LABELS.includes(x))) return "post-deploy";
  if (l.includes("wont-do") || l.includes("wontfix")) return "wont-do";
  return "engineering";
}

/**
 * Ship pre-flight over the open issues of a milestone. Each item: `{number, labels, target, dependsOn?}` where `target` is the
 * milestone it is carried to. `onBase(n)` says whether dependency `n` is on the target base (default: yes).
 * Returns `{ok, missing:[{issue, why}], carry:[{issue, class, target, demote}], mustNotDemote:[issue]}`. An issue that is
 * external, flag/legal-gated or depends on an issue that is not on the base is never demoted to fast lane.
 */
export function preflightCarryOver(openIssues, { onBase = () => true } = {}) {
  const missing = [], carry = [], mustNotDemote = [];
  for (const it of arr(openIssues)) {
    const n = it?.number, cls = classifyCarryOver(it), target = String(it?.target ?? "").trim();
    if (!target) { missing.push({ issue: n, why: "no target milestone" }); continue; }
    const gated = names(it.labels).some((x) => GATED_LABELS.includes(x));
    const offBase = arr(it.dependsOn).some((d) => { try { return onBase(d) === false; } catch { return false; } });
    const blocked = cls === "external" || gated || offBase;
    if (blocked) mustNotDemote.push(n);
    carry.push({ issue: n, class: cls, target, demote: !blocked });
  }
  return { ok: missing.length === 0, missing, carry, mustNotDemote };
}

/** Open milestone `{title, state, open, closed, description}` with a shipped/deployed record and open issues left. */
export function shippedWithOpen(ms) {
  const s = parseLifecycle(ms?.description)?.state;
  return ms?.state !== "closed" && ["shipped:staging", "deployed:default"].includes(s) && Number(ms?.open) > 0;
}

/** Open milestone with no open issues that is still not closed. */
export const emptyButOpen = (ms) => ms?.state !== "closed" && Number(ms?.open) === 0;

/**
 * Advance one milestone to `to` (never backwards), recording `sha` (the merge commit) when given. Closes it when `closeOn` is
 * reached and no open issue is left. `deployed(sha)` (optional) reports whether the shipped commit is on the default branch;
 * it promotes `shipped:staging` to `deployed:default`. Returns `{state, closed}` or null when the milestone is not found.
 */
export async function advanceMilestone({ gh, repo, title, to = null, sha = null, closeOn = "default", deployed = null }) {
  const ms = await readMilestone({ gh, repo, title });
  if (!ms) return null;
  const before = parseLifecycle(ms.description);
  let state = to ? advanceState(before?.state, to) : before?.state ?? "building";
  const rsha = sha ?? before?.sha ?? null;
  if (state === "shipped:staging" && rsha && deployed) { try { if (await deployed(rsha)) state = "deployed:default"; } catch { /* not provably deployed */ } }
  let closed = false;
  if (closeDue(state, closeOn)) {
    const open = JSON.parse(String(await gh(["issue", "list", "-R", repo, "--milestone", title, "--state", "open", "--limit", "1", "--json", "number"])) || "[]");
    if (!arr(open).length) { state = "closed"; closed = true; }
  }
  const next = { state, ...(rsha ? { sha: rsha } : {}) };
  if (!before || before.state !== next.state || before.sha !== next.sha) {
    await gh(["api", "-X", "PATCH", `repos/${repo}/milestones/${ms.number}`, "-f", `description=${renderLifecycle(ms.description, next)}`, ...(closed ? ["-f", "state=closed"] : [])]);
  }
  return { state, closed };
}

/**
 * The orchestrate `lifecycle` seam: `onBatchEnd(titles)` records `shipped:staging` for each milestone the batch merged into once it has no open issue, so an
 * orchestrate-driven milestone closes once `close_on` is reached. Errors are the caller's to report.
 */
export function makeLifecycle({ gh, git = null, repo, closeOn = "default", defaultBranch = "main" }) {
  const deployed = git ? async (sha) => { try { await git(["merge-base", "--is-ancestor", sha, `origin/${defaultBranch}`]); return true; } catch { return false; } } : null;
  return {
    async onBatchEnd(titles) {
      const out = [];
      for (const title of titles) {
        // D3: only a milestone with no open issue left is shipped by the batch; otherwise it is re-evaluated as is.
        const open = JSON.parse(String(await gh(["issue", "list", "-R", repo, "--milestone", title, "--state", "open", "--limit", "1", "--json", "number"])) || "[]");
        const r = await advanceMilestone({ gh, repo, title, to: arr(open).length ? null : "shipped:staging", closeOn, deployed });
        if (r) out.push({ title, ...r });
      }
      return out;
    },
  };
}
