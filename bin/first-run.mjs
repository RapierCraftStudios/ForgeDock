// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forgedock first-run (#5290): on the user's own repo, propose up to 3 small, verifiable issues found by
 * deterministic scans (no model), file them on approval and run one to a PR. Each filed issue carries a
 * FORGE:FIRST_RUN marker with the setup start time, so `forgedock stats --first-merge` can measure setup start to
 * first merge from GitHub alone. Every failure ends with a plain-language next step (nextStep).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const MAX_PROPOSALS = 3;
export const FIRST_RUN_MARKER = "FORGE:FIRST_RUN";
const MARKER_RE = /<!--\s*FORGE:FIRST_RUN\s+(\{.*?\})\s*-->/;

/** The FORGE:FIRST_RUN marker for an issue body: {started: iso} or null. */
export function parseMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ""));
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return Number.isFinite(Date.parse(j?.started)) ? j : null;
  } catch { return null; }
}
export const markerLine = (startedMs) => `<!-- ${FIRST_RUN_MARKER} ${JSON.stringify({ started: new Date(startedMs).toISOString() })} -->`;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const mdFiles = (cwd) => {
  const out = ["README.md"].filter((f) => existsSync(join(cwd, f)));
  try { for (const f of readdirSync(join(cwd, "docs"))) if (f.endsWith(".md")) out.push(`docs/${f}`); } catch { /* no docs dir */ }
  return out;
};

/** Relative markdown links whose target is missing: [{file, target}]. */
export function findDeadLinks(cwd) {
  const dead = [];
  for (const file of mdFiles(cwd)) {
    const text = readFileSync(join(cwd, file), "utf8").replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const abs = resolve(cwd, dirname(file), target);
      if (relative(cwd, abs).startsWith("..")) continue;
      if (!existsSync(abs)) dead.push({ file, target });
    }
  }
  return dead;
}

/** Up to 3 small, verifiable candidates: [{kind, title, body}], most useful first. */
export function proposeIssues(cwd) {
  const pkg = readJson(join(cwd, "package.json"));
  const out = [];
  const dead = findDeadLinks(cwd);
  if (dead.length) {
    const list = dead.slice(0, 10).map((d) => `- \`${d.file}\` links to \`${d.target}\`, which does not exist`).join("\n");
    out.push({ kind: "dead-link", title: "docs: fix broken relative links", body: `Dead relative links found:\n\n${list}\n\nVerify: every relative link in the listed files resolves to an existing file.` });
  }
  if (!existsSync(join(cwd, "CONTRIBUTING.md"))) {
    out.push({ kind: "doc-gap", title: "docs: add CONTRIBUTING.md", body: "The repo has no CONTRIBUTING.md. Add a short one: how to set up, run the tests and open a PR.\n\nVerify: CONTRIBUTING.md exists and is linked from the README." });
  }
  if (pkg?.scripts?.lint) {
    out.push({ kind: "lint-debt", title: "chore: make `npm run lint` pass cleanly", body: "Run `npm run lint` and fix the reported findings without changing behaviour.\n\nVerify: `npm run lint` exits 0." });
  }
  if (pkg && !pkg.scripts?.test) {
    out.push({ kind: "failing-test", title: "test: add a `test` script and one passing test", body: "package.json has no `test` script. Add one with a single smoke test for an existing module.\n\nVerify: `npm test` exits 0." });
  }
  return out.slice(0, MAX_PROPOSALS);
}

/** Plain-language next step for a failure message or error. Always returns a non-empty string. */
export function nextStep(err) {
  const m = String(err?.stderr || err?.message || err || "");
  if (/gh auth|not logged in|authentication|GH_TOKEN|HTTP 401|bad credentials/i.test(m)) return "GitHub CLI is not signed in. Run `gh auth login`, then re-run `npx forgedock first-run`.";
  if (/gh: command not found|ENOENT.*gh|spawn gh/i.test(m)) return "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, run `gh auth login`, then re-run `npx forgedock first-run`.";
  if (/protected branch|GH006|required status check|branch protection/i.test(m)) return "The base branch is protected, so ForgeDock cannot merge directly. That is fine: it opens a PR for you to review and merge. Check the PR with `gh pr list`.";
  if (/no ci|no workflows|no checks/i.test(m)) return "This repo has no CI workflow, so nothing verifies the PR. Add a workflow under .github/workflows (or review the PR yourself) before merging.";
  if (/remote|not a git repository|no github|could not resolve/i.test(m)) return "No GitHub remote found. Run this inside a clone of a GitHub repo, or add one with `git remote add origin <url>`.";
  return "Something went wrong. Re-run `npx forgedock first-run`, or run `npx forgedock doctor` to check your setup.";
}

const issueNumber = (out) => { const m = /\/issues\/(\d+)/.exec(String(out ?? "")); return m ? Number(m[1]) : null; };

/** File each proposal with the start marker; returns [{number, title}]. exec(cmd, args) -> stdout. */
export function fileIssues({ exec, repo, proposals, startedMs }) {
  const filed = [];
  for (const p of proposals) {
    const body = `${p.body}\n\n${markerLine(startedMs)}`;
    const number = issueNumber(exec("gh", ["issue", "create", "-R", repo, "--title", p.title, "--body", body]));
    if (!number) throw new Error(`could not read the issue number for "${p.title}" from gh output`);
    filed.push({ number, title: p.title });
  }
  return filed;
}

/**
 * Guided first run. Never throws: returns {status: "done"|"declined"|"nothing"|"error", issues, step?}.
 * deps: exec(cmd,args), confirmFn(q, default), write(text), runIssueFn(n), startedMs.
 */
export async function runFirstRun({ cwd = process.cwd(), exec, confirmFn, write = (t) => process.stdout.write(t), runIssueFn, startedMs = Date.now() } = {}) {
  const fail = (err, issues = []) => { const step = nextStep(err); write(`\n  ${String(err?.message ?? err).split("\n")[0]}\n  Next step: ${step}\n`); return { status: "error", issues, step }; };
  let repo;
  try {
    exec("gh", ["auth", "status"]);
  } catch (err) { return fail(/not found|ENOENT/i.test(String(err?.message)) ? err : `gh auth: ${err?.stderr || err?.message}`); }
  try {
    repo = String(exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim();
    if (!repo) throw new Error("could not resolve the GitHub repo");
  } catch (err) { return fail(err); }
  if (!existsSync(join(cwd, ".github", "workflows"))) write(`  Note: ${nextStep("no CI")}\n`);
  const proposals = proposeIssues(cwd);
  if (!proposals.length) { write("  Nothing small and obvious to propose here. File an issue yourself, then run: npx forgedock run-issue <n>\n"); return { status: "nothing", issues: [] }; }
  write(`\n  ForgeDock proposes ${proposals.length} small issue${proposals.length === 1 ? "" : "s"} on ${repo}:\n`);
  proposals.forEach((p, i) => write(`   ${i + 1}. ${p.title}\n`));
  if (!(await confirmFn(`File these issue${proposals.length === 1 ? "" : "s"} on ${repo}?`, false))) { write("  Nothing filed. Re-run anytime: npx forgedock first-run\n"); return { status: "declined", issues: [] }; }
  let issues;
  try { issues = fileIssues({ exec, repo, proposals, startedMs }); } catch (err) { return fail(err); }
  write(`  Filed ${issues.map((i) => `#${i.number}`).join(", ")}. Running #${issues[0].number} now.\n`);
  try { await runIssueFn(issues[0].number); } catch (err) { return fail(err, issues); }
  write(`  Done. Review the PR with: gh pr list -R ${repo}\n`);
  return { status: "done", issues };
}
