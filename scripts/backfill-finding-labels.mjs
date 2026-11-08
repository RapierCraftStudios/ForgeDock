#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-shot backfill (#5254): closed `review-finding` issues still labelled `needs-validation`.
 * workflow:merged -> validated; workflow:invalid or closed "not planned" -> false-positive; anything else is skipped.
 * Dry run by default: prints the counts it would change; edits only with --apply.
 * Usage: backfill-finding-labels.mjs --repo owner/name [--apply] [--limit N]
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const names = (i) => (i.labels ?? []).map((l) => l?.name ?? l);

/** The label an old closed finding should carry, or null when its outcome is not derivable. */
export function targetLabel(issue) {
  const l = names(issue);
  if (l.includes("workflow:invalid") || issue.stateReason === "NOT_PLANNED") return "false-positive";
  if (l.includes("workflow:merged")) return "validated";
  return null;
}

export function backfill({ issues, apply = false, edit }) {
  const counts = { validated: 0, "false-positive": 0, skipped: 0, failed: 0 };
  const changes = [];
  for (const i of issues) {
    const t = targetLabel(i);
    if (!t) { counts.skipped++; continue; }
    if (apply) {
      try { edit(i.number, t); } catch { counts.failed++; continue; }
    }
    counts[t]++; changes.push({ number: i.number, add: t });
  }
  return { mode: apply ? "apply" : "dry-run", counts, changes };
}

function main(argv) {
  const get = (f) => { const k = argv.indexOf(f); return k >= 0 ? argv[k + 1] : null; };
  const repo = get("--repo"), limit = get("--limit") ?? "1000", apply = argv.includes("--apply");
  if (!repo) { console.error("usage: backfill-finding-labels.mjs --repo owner/name [--apply] [--limit N]"); return 2; }
  const gh = (a) => execFileSync("gh", a, { encoding: "utf8" });
  const issues = JSON.parse(gh(["issue", "list", "-R", repo, "--state", "closed", "--label", "review-finding", "--label", "needs-validation", "--limit", limit, "--json", "number,labels,stateReason"]) || "[]");
  const edit = (n, add) => gh(["issue", "edit", String(n), "-R", repo, "--add-label", add, "--remove-label", "needs-validation"]);
  const r = backfill({ issues, apply, edit });
  const c = r.counts;
  console.log(`${apply ? "applied" : "dry-run (pass --apply to change)"}: ${c.validated} -> validated, ${c["false-positive"]} -> false-positive, ${c.skipped} skipped${c.failed ? `, ${c.failed} failed` : ""}`);
  return c.failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
