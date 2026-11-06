// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock fix-close-reasons <owner/repo> [--milestone <m>] [--apply]` (#5177, deferred from #5152). No LLM.
 * Migration helper: an issue closed `not planned` that carries `workflow:merged` or `workflow:decomposed` was delivered
 * (or moved to sub-issues), not dropped. It is re-closed as `completed` with a comment. One PATCH changes the reason in place
 * (no reopen window). A `workflow:invalid` issue is a real drop and is never touched. Dry-run unless `--apply`.
 */
const DELIVERED = ["workflow:merged", "workflow:decomposed"];
const isNotPlanned = (r) => String(r ?? "").toUpperCase().replace(/\s/g, "_") === "NOT_PLANNED";

const commentFor = (label) => label === "workflow:decomposed"
  ? "Close reason corrected to `completed`: this issue was decomposed and its scope moved to its sub-issues, it was not dropped (`workflow:decomposed`). Re-closed by `forgedock fix-close-reasons` (#5177)."
  : "Close reason corrected to `completed`: the work was delivered and merged, it was not dropped (`workflow:merged`). Re-closed by `forgedock fix-close-reasons` (#5177).";

/** Closed `not planned` issues that were delivered: [{number, label}], by issue number, once each. */
export async function findMisclosed({ gh, repo, milestone }) {
  const found = new Map();
  for (const label of DELIVERED) {
    const out = await gh(["issue", "list", "-R", repo, "--state", "closed", "--label", label, ...(milestone ? ["--milestone", milestone] : []), "--limit", "1000", "--json", "number,stateReason,labels"]);
    for (const i of JSON.parse(String(out || "[]"))) {
      const names = (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
      if (!isNotPlanned(i.stateReason) || names.includes("workflow:invalid") || found.has(i.number)) continue;
      found.set(i.number, { number: i.number, label });
    }
  }
  return [...found.values()].sort((a, b) => a.number - b.number);
}

export async function runFixCloseReasonsCli(argv, deps = {}) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const repo = argv[0] && !argv[0].startsWith("--") ? argv[0] : (val("--repo") ?? deps.repo ?? null);
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("usage: forgedock fix-close-reasons <owner/repo> [--milestone <title|number>] [--apply]");
  const milestone = val("--milestone");
  if (argv.includes("--milestone") && (!milestone || milestone.startsWith("--"))) throw new Error("--milestone requires a milestone title or number");
  const apply = argv.includes("--apply");
  const gh = deps.gh ?? (await import("./effects.mjs")).makeLeanIo({ repo }).gh;
  const print = deps.print ?? ((t) => console.log(t));
  const items = await findMisclosed({ gh, repo, milestone });
  let changed = 0, failed = 0;
  for (const { number, label } of items) {
    if (!apply) { print(`would re-close #${number} as completed (${label})`); continue; }
    try {
      await gh(["api", "-X", "PATCH", `repos/${repo}/issues/${number}`, "-f", "state=closed", "-f", "state_reason=completed"]);
      await gh(["issue", "comment", String(number), "-R", repo, "--body", commentFor(label)]);
      changed++;
      print(`re-closed #${number} as completed (${label})`);
    } catch (e) { failed++; print(`#${number}: failed: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  print(`fix-close-reasons: ${items.length} found, ${changed} changed, ${failed} failed${apply ? "" : " (dry run, pass --apply to write)"}`);
  return failed ? 1 : 0;
}
