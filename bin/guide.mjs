// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock guide` (#4782): the workflow in one screen, for a first-time user and for CI logs. What ForgeDock promises,
 * the core commands and what each automates, the issue → staging → main lifecycle, the terminal states and how to resume.
 * Plain text when stdout is not a TTY, NO_COLOR is set or TERM is dumb; wrapped to the terminal (100 columns otherwise).
 */

/** Columns to render at: the TTY width clamped to 60..120, else 100. */
export function guideWidth(out = process.stdout) {
  return out?.isTTY && Number(out.columns) > 0 ? Math.max(60, Math.min(120, Number(out.columns))) : 100;
}

/** True when ANSI styling is allowed on `out`. */
export function useAnsi(out = process.stdout, env = process.env) {
  return out?.isTTY === true && !env.NO_COLOR && env.TERM !== "dumb";
}

/** Greedy word wrap of `text` (whitespace collapsed) to `width`, continuation lines prefixed with `indent`. */
export function wrap(text, width, indent = "") {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const cand = line ? `${line} ${word}` : word;
    if (line && cand.length > width) { out.push(line); line = indent + word; } else line = cand;
  }
  if (line) out.push(line);
  return out;
}

const SECTIONS = [
  ["What ForgeDock does", [
    "You file a GitHub issue. ForgeDock investigates it, builds the change on its own branch, reviews it against the issue, " +
    "and merges it into your staging branch, never into main. A release is a separate, reviewed staging-to-main PR. " +
    "GitHub is the record: every step leaves a labelled issue and a structured FORGE comment, so any run can be read, " +
    "audited and resumed from GitHub alone.",
  ]],
  ["Core commands", [
    ["/issue <title>", "In Claude Code: file an issue in the template the pipeline reads (problem, affected files, testable acceptance criteria). Deduplicates first."],
    ["/work-on <N>", "In Claude Code: run one issue through investigate, build, review and merge into its lane."],
    ["npx forgedock run-issue <N>", "The same run without an interactive session: the durable engine drives it and records state on the issue."],
    ["npx forgedock orchestrate <N...>", "Several issues in parallel, one lane each, in Depends-on order, under the host scheduler. Detached: reattach with --resume <id>."],
    ["npx forgedock issue-watch run", "Claim new issues that match a watch and start them automatically; verifies each merge."],
    ["npx forgedock check", "Run the lane's validate commands and change-scoped checks locally, as the engine will."],
    ["npx forgedock watch", "Live view of running lanes."],
    ["/review-pr-staging", "In Claude Code: review the staging-to-main release PR and post the deploy gate marker."],
  ]],
  ["Lifecycle", [
    "1. Issue: filed with real affected files and testable acceptance criteria.",
    "2. Lane: the issue's branch target. A milestone issue goes to milestone/<slug>, anything else to staging. Never main.",
    "3. Investigate -> build -> review: labels workflow:investigating, building, in-review (remediating when review findings are fixed).",
    "4. Merge into the lane after the review, required checks and DCO pass, pinned to the reviewed commit.",
    "5. Release: a staging-to-main PR, reviewed by /review-pr-staging. Its FORGE:GATE_PASS marker is what the deploy gate checks before main accepts it.",
  ]],
  ["Where a run ends", [
    ["workflow:merged", "Merged into the lane; the issue is closed."],
    ["needs-human", "Stopped for a decision. The issue says why (an outcome code in its FORGE:STATE record and a FORGE:NEEDS_HUMAN comment). Nothing is merged."],
    ["workflow:engine-error", "The engine itself failed; safe to retry."],
    ["workflow:invalid", "Investigation found nothing to fix; the issue says why."],
    ["workflow:decomposed", "Split into sub-issues; run those."],
  ]],
  ["Resume and retry", [
    ["npx forgedock run-issue <N> --retry", "Re-run an engine-error issue, or a needs-human one after you remove the label."],
    ["npx forgedock orchestrate --resume <id>", "Reattach to a batch; a finished one replays its report."],
    ["npx forgedock resume-stalled", "Re-dispatch issues whose run lease expired."],
  ]],
  ["Next step", [
    "New repo: npx forgedock (guided setup), then npx forgedock doctor. Then file an issue with /issue and run /work-on <N>. " +
    "Full command list: npx forgedock help.",
  ]],
];

/** The guide as text: `width` columns, ANSI bold headings only when `ansi`. */
export function guideText({ width = 100, ansi = false } = {}) {
  const head = (t) => (ansi ? `\x1b[1m${t}\x1b[0m` : `${t}\n${"-".repeat(t.length)}`);
  const lines = [ansi ? "\x1b[1mForgeDock: how the workflow fits together\x1b[0m" : "ForgeDock: how the workflow fits together", ""];
  for (const [title, items] of SECTIONS) {
    lines.push(head(title));
    const pairs = items.filter(Array.isArray);
    const key = Math.min(Math.max(0, ...pairs.map(([k]) => k.length)), Math.floor(width * 0.4));
    for (const item of items) {
      if (!Array.isArray(item)) { lines.push(...wrap(item, width, /^\d\./.test(item) ? "   " : "")); continue; }
      const [k, v] = item, pad = " ".repeat(key + 4);
      if (k.length > key) { lines.push(`  ${k}`, ...wrap(v, width - pad.length).map((l) => pad + l)); continue; }
      lines.push(...wrap(v, width - pad.length).map((l, i) => (i ? pad : `  ${k.padEnd(key)}  `) + l));
    }
    lines.push("");
  }
  return lines.join("\n");
}
