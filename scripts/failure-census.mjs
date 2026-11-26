#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * failure-census: why lanes left the happy path, measured from the register (read-only).
 *
 *   node scripts/failure-census.mjs --repo owner/repo [--since YYYY-MM-DD] [--state open|all] [--limit N]
 *                                   [--batches ~/.forge/batches] [--no-batches] [--json]
 *
 * Reads issue comments with `gh` (issues updated since --since that have comments) and the local batch logs of that repo,
 * then prints the census (bin/lean/failure-census.mjs): parks by class and day, normalised failure rows, amendment
 * classes, base-sync conflict hotspots, most-parked issues, batch outcome/deferral codes and phase timing.
 * Use it before changing a gate, the engine or the pool: solve the measured classes, not a guess.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { censusIssues, censusBatchRows, renderCensus } from "../bin/lean/failure-census.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const repo = opt("--repo");
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error("usage: failure-census.mjs --repo owner/repo [--since YYYY-MM-DD] [--state open|all] [--limit N] [--batches DIR] [--no-batches] [--json]"); process.exit(2); }
const since = opt("--since");
const state = opt("--state", "all");
const limit = Number(opt("--limit", "300"));
const gh = (a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// Issues: comments >= 1, optionally updated since; comments fetched per issue (paginated) with small parallelism.
const search = ["comments:>=1", since ? `updated:>=${since}` : ""].filter(Boolean).join(" ");
const list = JSON.parse(gh(["issue", "list", "-R", repo, "--state", state, "--limit", String(limit), "--search", search, "--json", "number,title"]));
const issues = [];
const queue = [...list];
async function worker() {
  for (let it = queue.shift(); it; it = queue.shift()) {
    try {
      const raw = gh(["api", `repos/${repo}/issues/${it.number}/comments?per_page=100`, "--paginate", "--jq", ".[] | {body, createdAt: .created_at, author: .user.login}"]);
      const comments = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      issues.push({ number: it.number, title: it.title, comments });
    } catch (e) { process.stderr.write(`#${it.number}: ${String(e?.message ?? e).split("\n")[0]}\n`); }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const ic = censusIssues(issues.sort((a, b) => a.number - b.number));

// Batch logs of this repo (local caches of the register; absent on a fresh host).
let bc = null;
if (!has("--no-batches")) {
  const dir = opt("--batches", join(homedir(), ".forge", "batches"));
  const rows = [];
  if (existsSync(dir)) for (const b of readdirSync(dir)) {
    try {
      const plan = JSON.parse(readFileSync(join(dir, b, "plan.json"), "utf8"));
      if (plan?.repo !== repo) continue;
      for (const l of readFileSync(join(dir, b, "log.jsonl"), "utf8").split("\n")) {
        if (!l) continue;
        try { const r = JSON.parse(l); if (!since || String(r.at ?? "") >= since) rows.push(r); } catch { /* partial line */ }
      }
    } catch { /* not a batch dir */ }
  }
  bc = rows.length ? censusBatchRows(rows) : null;
}

if (has("--json")) console.log(JSON.stringify({ repo, since, issues: ic, batches: bc }, null, 2));
else process.stdout.write(renderCensus({ repo, since, issues: ic, batches: bc }));
