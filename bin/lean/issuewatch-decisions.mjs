// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4793: the north-star decision engine (#4766) as an issue-watch stage. Each round the watcher lists the open `needs-human`
 * issues that match its selectors, reads the newest trusted `FORGE:NEEDS_HUMAN` comment of each (its comment id is the escalation
 * id the engine is idempotent on) and the typed `terminalCode` from a trusted `FORGE:STATE`, and hands it to `settle`. Active when
 * `decisions.mode: live`, or when the watch sets `sweep_needs_human: true`; escalations that predate the watch are a backlog and
 * only a `sweep_needs_human` watch touches them. `--dry-run` classifies and writes nothing. Handled issues count against the
 * watch's `max_issues`, issues sent back to a lane against `max_launches` (`claimsUsed`, shared with the watcher's own caps).
 * Only live mode acts: a post-deploy-only escalation is folded into `postdeploy_rollup` and closed, an evidence escalation on a repo
 * that declares `prod_watch` sources goes back to a lane with the prod monitor capability; in shadow mode each only posts.
 * Gh, the clock, the judge, the lane launch and the rollup `fold` are injected. The judge is the only LLM call.
 */
import { settle, classify, tally, isVetoed, revertVeto, effectiveMode, NEEDS_HUMAN_LABEL } from "./decision-engine.mjs";
import { codeOf } from "./context.mjs";
import { noComments } from "./render.mjs";
import { listAssociations } from "./gh-assoc.mjs";
import { parseProdWatch } from "./prodwatch.mjs";
import { isTrustedActor } from "../engine/phases.mjs";

const ROWS_MAX = 200;
const LIST_LIMIT = "200";
const MAX_ATTEMPTS = 3; // a judge/gh failure is retried this many rounds, then the escalation is left to a human
const MS_PER_HOUR = 3600_000;
const commentId = (c) => /#issuecomment-(\d+)/.exec(String(c?.url ?? ""))?.[1] ?? c?.id ?? null;
const marked = (body, m) => new RegExp(`^\\s*<!--\\s*FORGE:${m}\\b`).test(String(body ?? ""));

/** True when this watch runs the stage: `decisions.mode: live` (policy from loadPolicy) or `sweep_needs_human: true`. */
export const decisionsActive = (watch, policy) => policy?.mode === "live" || watch.sweep_needs_human === true;

/** What the watch has used up: `issues` (claimed or handled by the stage, for max_issues) and `launches` (claimed or sent back to a lane, for max_launches). */
export function claimsUsed(state) {
  const d = state.decisions;
  return { issues: new Set([...(state.claimed ?? []), ...(d?.issues ?? [])]).size, launches: new Set([...(state.claimed ?? []), ...(d?.launched ?? [])]).size };
}

/** `{policy, hasSource}`: the repo's decisions policy and whether forge.yaml declares read-only data access (`prod_watch` sources). */
export function decisionContext({ loadPolicy, readFile, cwd = "." }) {
  const policy = loadPolicy({ io: { readFile }, cwd });
  let hasSource = false;
  try { hasSource = Object.keys(parseProdWatch(readFile(`${cwd}/forge.yaml`)).sources ?? {}).length > 0; } catch { /* no forge.yaml or no prod_watch block */ }
  return { policy, hasSource };
}

/** The typed terminal code of the newest FORGE:STATE record (trusted comments, then the issue body, whose author the stage already vetted). */
export function terminalCodeOf(body, comments, trusted) {
  for (const t of [...(comments ?? []).filter(trusted).map((c) => c.body).reverse(), body]) {
    const m = /FORGE:STATE\s*(\{[^\n]*\})/.exec(String(t ?? ""));
    if (!m) continue;
    try { const st = JSON.parse(m[1]); return codeOf(st.terminalCode) ?? codeOf(st.terminalReason); } catch { /* next record */ }
  }
  return null;
}

/** An issue's open escalation: `{id, text, at}` from its newest trusted FORGE:NEEDS_HUMAN comment, or null. */
export function escalationOf(comments, trusted) {
  const c = [...(comments ?? [])].reverse().find((x) => marked(x.body, "NEEDS_HUMAN") && trusted(x));
  return c && commentId(c) ? { id: String(commentId(c)), text: noComments(c.body).replace(/^\s*## Needs human\s*/i, "").trim(), at: Date.parse(c.createdAt) || 0 } : null;
}

const dec = (state) => (state.decisions ??= { rows: [], handled: {}, attempts: {}, issues: [], launched: [], live: [], stats: { decided: 0, reversed: 0 } });

/** Counts for the watcher status: decided, evidence-gathered, folded, external-kept (decision-engine `tally`). */
export const decisionCounts = (state) => tally(state.decisions?.rows ?? []);

const ghJson = async (io, args) => JSON.parse(String(await io.gh(args)));
const poster = (io, repo) => async (_marker, body, issue) => { await io.gh(["issue", "comment", String(issue), "-R", repo, "--body", `<!-- FORGE:DECISION -->\n${body}`]); };
const labeller = (io, repo) => async ({ issue, add = [], remove = [] }) => {
  if (!add.length && !remove.length) return;
  await io.gh(["issue", "edit", String(issue), "-R", repo, ...add.flatMap((l) => ["--add-label", l]), ...remove.flatMap((l) => ["--remove-label", l])]);
};

/**
 * One round. `ctx`: `{policy, hasSource}`; `shared`: issuewatch's `{matches(issue, selectors), fold({issue, watch, repo, io, state}), labelNames, isBot, TRUSTED}`;
 * `launch(issue)→bool` sends the issue back to a lane (the watcher's per-issue launch; false leaves it to normal selection).
 * `io.judge(q)→answer` is the judgment call (none: every decision part escalates). Returns `{rows}`; with `dryRun` the rows are
 * classifications and nothing is written to GitHub or `state`. Never throws on one issue: a failure is retried, then left to a human.
 */
export async function decisionStep({ watch, repo, io, state, ctx, shared, launch = () => false, dryRun = false }) {
  const d = dec(state);
  const startedAt = state.started ?? io.now();
  if (!dryRun) state.started ??= startedAt;
  const trusted = (c) => isTrustedActor({ association: c?.authorAssociation, type: shared.isBot(c) ? "Bot" : "", login: c?.author?.login });
  const rows = [];
  const issues = await ghJson(io, ["issue", "list", "-R", repo, "--state", "open", "--label", NEEDS_HUMAN_LABEL, "--limit", LIST_LIMIT, "--json", "number,title,body,labels,milestone,author,createdAt"]);
  const assoc = await listAssociations(io.gh, repo);
  const sel = { ...watch, labels: (watch.labels ?? []).filter((l) => l !== NEEDS_HUMAN_LABEL), exclude_labels: (watch.exclude_labels ?? []).filter((l) => l !== NEEDS_HUMAN_LABEL) };
  for (const raw of issues) {
    const i = { ...raw, authorAssociation: assoc.get(raw.number) };
    if (!shared.TRUSTED.has(i.authorAssociation) || !shared.matches(i, sel)) continue;
    const view = await ghJson(io, ["issue", "view", String(i.number), "-R", repo, "--json", "comments,body,labels"]);
    const esc = escalationOf(view.comments, trusted);
    if (!esc || d.handled[esc.id]) continue;
    const backlog = esc.at < startedAt;
    if (backlog && !watch.sweep_needs_human && !dryRun) continue;
    const item = { issue: i.number, repo, escalationId: esc.id, text: esc.text, title: i.title, terminalCode: terminalCodeOf(view.body, view.comments, trusted), comments: view.comments };
    if (dryRun) { rows.push({ ...classify(item, ctx.policy), backlog }); continue; }
    const used = claimsUsed(state);
    if (watch.max_issues && used.issues >= watch.max_issues) break;
    if (watch.max_launches && used.launches >= watch.max_launches) break;
    const row = await handle({ item, issue: i, watch, repo, io, state, ctx, shared, launch, d });
    if (row.action === "error") { // not handled: retried next round, bounded
      d.attempts[esc.id] = (d.attempts[esc.id] ?? 0) + 1;
      if (d.attempts[esc.id] >= MAX_ATTEMPTS) d.handled[esc.id] = "error";
      rows.push(row);
      continue;
    }
    d.handled[esc.id] = row.action;
    if (row.action === "skipped") continue;
    d.rows = [...d.rows, { issue: row.issue, escalationId: esc.id, action: row.action, kept: row.kept ?? false }].slice(-ROWS_MAX);
    if (!d.issues.includes(i.number)) d.issues.push(i.number);
    rows.push(row);
  }
  if (!dryRun) await vetoes({ repo, io, ctx, d, shared });
  return { rows };
}

async function handle({ item, issue, watch, repo, io, state, ctx, shared, launch, d }) {
  const n = item.issue;
  try {
    const post = poster(io, repo), setLabels = labeller(io, repo);
    const back = async () => { if (!d.launched.includes(n)) d.launched.push(n); await launch(issue); }; // label cleared: a lane takes it again
    const deps = { judge: (q) => (io.judge ? io.judge(q) : null), post, setLabels, requeue: back, records: (await io.records?.()) ?? [], stats: d.stats, emit: io.emit };
    const row = await settle(item, ctx.policy, deps);
    if (row.action === "error") return row;
    if (row.action === "decided") { d.stats.decided++; if (!row.kept) d.live.push({ issue: n, escalationId: item.escalationId, at: io.now() }); }
    const key = `Escalation: ${item.escalationId}`;
    if (row.action !== "post-deploy-only" && row.action !== "evidence-needed") return row;
    if (effectiveMode(ctx.policy, d.stats).mode !== "live") { // shadow: say what would happen, change nothing
      await post(null, `## Decision (shadow)\n${key}\nWould ${row.action === "post-deploy-only" ? "fold into the release checklist and close" : "send back to a prod-monitor lane"}; nothing changed.`, n);
      return { ...row, action: "shadow" };
    }
    if (row.action === "post-deploy-only") {
      if (!watch.postdeploy_rollup) return { ...row, action: "post-deploy-kept", reason: "no postdeploy_rollup to fold into" };
      await shared.fold({ issue: { number: n, title: item.title ?? `#${n}` }, watch, repo, io, state });
      await post(null, `## Post-deploy only\n${key}\nEvery remaining item is post-deploy: folded into #${watch.postdeploy_rollup} (the release checklist) and closed.`, n);
      await setLabels({ issue: n, remove: [NEEDS_HUMAN_LABEL] });
      await io.gh(["issue", "close", String(n), "-R", repo, "--reason", "completed"]);
      return { ...row, folded: true };
    }
    if (!ctx.hasSource) return { ...row, action: "evidence-kept", reason: "no read-only data access declared in forge.yaml (prod_watch.sources)" };
    await post(null, `## Evidence needed\n${key}\nThe block is missing read-only production data and forge.yaml declares a read-only source (prod_watch.sources): back to a lane that has the prod monitor capability (placement prod_monitor), needs-human cleared.`, n);
    await setLabels({ issue: n, remove: [NEEDS_HUMAN_LABEL] });
    await back();
    return row;
  } catch (e) {
    return { issue: n, escalationId: item.escalationId, action: "error", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** A live decision vetoed inside its window (label or reply) is reverted once; a window that ended retires the record. */
async function vetoes({ repo, io, ctx, d, shared }) {
  const keep = [];
  for (const r of d.live) {
    try {
      const v = await ghJson(io, ["issue", "view", String(r.issue), "-R", repo, "--json", "comments,labels"]);
      if (isVetoed({ labels: shared.labelNames(v), comments: v.comments, decidedAt: r.at, vetoHours: ctx.policy.vetoHours, now: io.now() })) {
        await revertVeto({ issue: r.issue, escalationId: r.escalationId }, { setLabels: labeller(io, repo), post: poster(io, repo), emit: io.emit });
        d.stats.reversed++;
      } else if (io.now() < r.at + ctx.policy.vetoHours * MS_PER_HOUR) keep.push(r);
    } catch { keep.push(r); }
  }
  d.live = keep;
}

/** Dry-run text: one line per escalation with its classification. */
export const formatDecisionDryRun = (rows) => rows.length ? rows.map((r) => `#${r.issue} ${r.kind}${r.backlog ? " (backlog)" : ""}: ${r.decisions} decision part(s)${r.external.length ? `, external ${r.external.join(",")}` : ""}`).join("\n") : "no needs-human escalations to classify";
