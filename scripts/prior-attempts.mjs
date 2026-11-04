#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * scripts/prior-attempts.mjs — prior attempts on an issue's subject (#5085). Deterministic, no LLM.
 *
 * Extracts the subject terms (error/outcome codes, symbols, title words) from a title and body, searches closed issues
 * and merged PRs by those terms (GitHub search) plus the whole git history (`git log --grep`), whatever files they
 * touched, and prints a `## Prior Attempts` table. Same search as the context pack's subject rows (bin/lean/context.mjs).
 * Used by /issue (filing time) and as the live fallback when the Forge Ledger recall index is absent.
 *
 * Usage: node scripts/prior-attempts.mjs --repo OWNER/NAME --title T [--body-file F] [--issue N] [--base REF] [--json]
 * Exit: 0 table printed (also when nothing is found), 1 a search failed (stderr says which), 2 usage error.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { subjectHistory } from "../bin/lean/context.mjs";

const USAGE = "usage: prior-attempts.mjs --repo OWNER/NAME --title T [--body-file F] [--issue N] [--base REF] [--json]";

const KEYS = { "--repo": "repo", "--title": "title", "--body-file": "bodyFile", "--issue": "issue", "--base": "base" };

export function parseArgs(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (Object.hasOwn(KEYS, a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[KEYS[a]] = argv[++i];
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const shipped = (r) => (r.status === "merged" ? "yes" : r.status === "not_planned" || r.status === "closed unmerged" ? "no" : "closed");

/** The `## Prior Attempts` markdown for a subjectHistory result; columns 2 and 4 are left for the drafter. */
export function renderPriorAttempts({ terms = [], rows = [] } = {}) {
  const out = ["## Prior Attempts", ""];
  if (!rows.length) out.push(`None found (terms: ${terms.length ? terms.join(", ") : "none"}).`);
  else {
    out.push("| Issue/PR | What it changed | Shipped? | Why it didn't hold |", "|---|---|---|---|");
    for (const r of rows) out.push(`| #${r.number} ${cell(r.title)} (${r.kind}, ${r.status}) | ? | ${shipped(r)} | ? |`);
    out.push("", `Search terms: ${terms.join(", ")}`);
  }
  return out.join("\n");
}

const run = (cmd) => (args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (e, stdout, stderr) => (e ? reject(new Error(String(stderr || e.message).trim())) : resolve(stdout))));

/** CLI body; `io` {gh, git, read, out, err} is injectable for tests. Returns the exit code. */
export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`)), err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { out(USAGE); return 0; }
  if (!o.repo || !/^[\w.-]+\/[\w.-]+$/.test(o.repo) || !o.title) { err(USAGE); return 2; }
  let body = "";
  if (o.bodyFile) { try { body = (io.read ?? ((p) => readFileSync(p, "utf8")))(o.bodyFile); } catch (e) { err(`cannot read --body-file: ${e.message}`); return 2; } }
  const r = await subjectHistory({ io: { gh: io.gh ?? run("gh"), git: io.git ?? run("git") }, repo: o.repo, issue: o.issue ? Number(o.issue) : null, title: o.title, body, base: o.base ?? "HEAD" });
  out(o.json ? JSON.stringify(r) : renderPriorAttempts(r));
  for (const e of r.errors) err(`WARNING: ${e}`);
  return r.errors.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
